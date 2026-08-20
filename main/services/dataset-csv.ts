// CSV → dataset rows. The pure half of Variables → Datasets → "Import CSV…":
// header cells name variables, each data row becomes one Dataset (one run of
// the sweep). The file half (dialog + fs) lives in `importDatasetCsvFile`
// below; everything about MEANING is here, testable without a disk.
//
// Two rules carry the feature's honesty:
//
// - **Columns are refused out loud, never mangled.** A header that isn't a
//   valid variable name, duplicates an earlier column, or names a SECRET
//   variable is skipped and the skip is reported with its reason. Secrets are
//   the load-bearing case: a row's values travel as plain text (GLAZE_VARS),
//   and the generated header already refuses to let them shadow a secret —
//   importing a "password" column would store plaintext that run time then
//   ignores, which is worse than refusing at the door.
//
// - **Nothing silently truncates.** Ragged rows are padded/trimmed but
//   counted; rows beyond MAX_DATASETS_PER_TEST are dropped but flagged. The
//   toast says what happened to what the user gave us.
//
// Values themselves never reach generated source: a dataset row rides the
// GLAZE_VARS env JSON at run time (see variableHeader in script-generator.ts),
// so a hostile CSV cell is inert text in a JSON blob, not code. The merged
// list still passes through normalizeDatasets — the boundary does not trust
// this module.

import * as fs from "fs";
import { randomUUID } from "crypto";

import { dialog } from "@shell/backend";

import {
  isValidVariableName,
  MAX_DATASETS_PER_TEST,
  normalizeDatasets,
  normalizeVariables,
  type Dataset,
  type TestVariable,
} from "../recorder/types.js";
import { testStore } from "./test-store.js";

/** Refuse files past this size before reading them into memory. 100 rows of
 *  generous values fit in a few hundred KB; 5 MB is someone else's export. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** Split CSV text into rows of cells. RFC 4180 quoting (embedded delimiters,
 *  newlines, and `""` escapes), any of CRLF/LF/CR, BOM stripped. The delimiter
 *  is sniffed from the header line among comma/semicolon/tab — semicolon is
 *  what Excel writes in half the world's locales, and refusing those files
 *  would read as "import is broken" to everyone in them. */
export function parseCsv(text: string): { rows: string[][]; delimiter: string } {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const delimiter = sniffDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let sawAny = false;

  const endCell = (): void => {
    row.push(cell);
    cell = "";
  };
  const endRow = (): void => {
    endCell();
    // A row whose every cell is empty is a blank line, not data.
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      inQuotes = true;
      sawAny = true;
    } else if (ch === delimiter) {
      endCell();
      sawAny = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += ch;
      sawAny = true;
    }
  }
  if (cell !== "" || row.length > 0) endRow();
  if (!sawAny) return { rows: [], delimiter };
  return { rows, delimiter };
}

function sniffDelimiter(src: string): string {
  // Count candidates in the header line only, outside quotes — a quoted cell
  // full of semicolons must not outvote the real commas.
  let inQuotes = false;
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of [";", "\t"]) {
    if (counts[d] > counts[best]) best = d;
  }
  return best;
}

export interface SkippedColumn {
  name: string;
  reason: "invalid name" | "duplicate column" | "secret variable";
}

export interface CsvDatasetsResult {
  ok: boolean;
  /** Why nothing was imported, when ok is false. */
  problem?: string;
  /** New rows, ready to append (ids fresh, names "Row N" continuing the list). */
  rows: Dataset[];
  /** Kept columns the test doesn't declare yet — the caller adds each as a
   *  plain variable so the imported values are live, not inert. */
  createdVariables: string[];
  skippedColumns: SkippedColumn[];
  /** Data rows whose cell count didn't match the header (padded or trimmed). */
  raggedRows: number;
  /** true when rows past MAX_DATASETS_PER_TEST were dropped. */
  truncated: boolean;
}

const failure = (problem: string): CsvDatasetsResult => ({
  ok: false,
  problem,
  rows: [],
  createdVariables: [],
  skippedColumns: [],
  raggedRows: 0,
  truncated: false,
});

/** Turn CSV text into dataset rows against a test's declared variables. */
export function datasetsFromCsv(
  text: string,
  opts: {
    variables: TestVariable[];
    /** rows already on the record — numbering continues and the cap counts them */
    existingCount: number;
    /** injected for deterministic tests; production uses randomUUID */
    newId?: () => string;
  },
): CsvDatasetsResult {
  const { rows: raw } = parseCsv(text);
  if (raw.length === 0) return failure("The file is empty.");
  if (raw.length === 1) return failure("The file has a header but no data rows.");

  const newId = opts.newId ?? (() => `d-${randomUUID().slice(0, 8)}`);
  const secretNames = new Set(
    opts.variables.filter((v) => v.kind === "secret").map((v) => v.name),
  );
  const declared = new Set(opts.variables.map((v) => v.name));

  const header = raw[0].map((h) => h.trim());
  const skippedColumns: SkippedColumn[] = [];
  const kept: { name: string; index: number }[] = [];
  const seen = new Set<string>();
  for (let c = 0; c < header.length; c++) {
    const name = header[c];
    if (!isValidVariableName(name)) {
      skippedColumns.push({ name: name || `column ${c + 1}`, reason: "invalid name" });
    } else if (seen.has(name)) {
      skippedColumns.push({ name, reason: "duplicate column" });
    } else if (secretNames.has(name)) {
      skippedColumns.push({ name, reason: "secret variable" });
    } else {
      seen.add(name);
      kept.push({ name, index: c });
    }
  }
  if (kept.length === 0) {
    return {
      ...failure("No column has a usable variable name."),
      skippedColumns,
    };
  }

  const capacity = Math.max(0, MAX_DATASETS_PER_TEST - opts.existingCount);
  const out: Dataset[] = [];
  let raggedRows = 0;
  let truncated = false;
  for (let r = 1; r < raw.length; r++) {
    if (out.length >= capacity) {
      truncated = true;
      break;
    }
    const cells = raw[r];
    if (cells.length !== header.length) raggedRows++;
    const values: Record<string, string> = {};
    for (const col of kept) {
      values[col.name] = cells[col.index] ?? "";
    }
    out.push({
      id: newId(),
      name: `Row ${opts.existingCount + out.length + 1}`,
      values,
    });
  }
  if (out.length === 0) {
    return { ...failure("The dataset list is already at its cap."), skippedColumns, truncated };
  }

  return {
    ok: true,
    rows: out,
    createdVariables: kept.map((k) => k.name).filter((n) => !declared.has(n)),
    skippedColumns,
    raggedRows,
    truncated,
  };
}

export interface ImportDatasetCsvResult extends CsvDatasetsResult {
  canceled?: boolean;
  imported: number;
}

/** The whole action behind the panel's "Import CSV…": pick a file, parse it,
 *  append the rows (and any newly named plain variables) to the record. */
export async function importDatasetCsvFile(testId: string): Promise<ImportDatasetCsvResult> {
  const rec = testStore.get(testId);
  if (!rec) throw new Error("Test not found: " + testId);

  const picked = await dialog.showOpenDialog({
    title: "Import dataset rows from CSV",
    properties: ["openFile"],
    filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) {
    return { ...failure("canceled"), canceled: true, imported: 0 };
  }
  const file = picked.filePaths[0];
  const size = fs.statSync(file).size;
  if (size > MAX_CSV_BYTES) {
    return {
      ...failure(`The file is ${Math.round(size / 1024 / 1024)} MB — the importer reads up to 5 MB.`),
      imported: 0,
    };
  }
  const text = fs.readFileSync(file, "utf8");

  const result = datasetsFromCsv(text, {
    variables: rec.variables ?? [],
    existingCount: (rec.datasets ?? []).length,
  });
  if (!result.ok) return { ...result, imported: 0 };

  // Created variables are plain with an empty default — the row supplies the
  // value; the default only covers a run outside the sweep.
  if (result.createdVariables.length > 0) {
    rec.variables = normalizeVariables([
      ...(rec.variables ?? []),
      ...result.createdVariables.map((name) => ({ name, kind: "plain" as const, value: "" })),
    ]);
  }
  rec.datasets = normalizeDatasets([...(rec.datasets ?? []), ...result.rows]);
  rec.updatedAt = Date.now();
  testStore.save(rec);
  return { ...result, imported: result.rows.length };
}
