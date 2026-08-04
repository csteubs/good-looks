// Shared helper for standalone Glaze MCP servers. Copy verbatim into the app
// project as mcp/glaze-data.mjs — do not edit per app.
//
// Resolves the app's runtime data directory (the same directory the app's
// backend gets from app.getPath("userData")) from a standalone process, using
// only this file's location, package.json, and the OS home directory — no
// hardcoded machine paths, so it keeps working if the project moves machines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = path.resolve(__dirname, "..");
const SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support");

function readProjectId() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SOURCES_DIR, "package.json"), "utf8"));
  if (!pkg.id) throw new Error('package.json is missing the "id" field');
  return pkg.id;
}

// Sources live at <Application Support>/app.glaze.macos.main[.<flavor>]/apps/<app>/.glaze-sources.
// The app's own data dir is <Application Support>/app.glaze.macos.<projectId>-local[.<flavor>].
function readHostFlavor() {
  const hostBundle = path.basename(path.resolve(SOURCES_DIR, "../../.."));
  const match = hostBundle.match(/^app\.glaze\.macos\.main(?:\.(.+))?$/);
  if (!match) return null;
  return (match[1] ?? "").toLowerCase();
}

export function resolveDataDir() {
  const projectId = readProjectId();
  const flavor = readHostFlavor();

  if (flavor !== null) {
    const suffix = flavor === "" || flavor === "production" ? "" : `.${flavor}`;
    const exact = path.join(SUPPORT_DIR, `app.glaze.macos.${projectId}-local${suffix}`);
    if (fs.existsSync(exact)) return exact;
  }

  // Fallback for legacy identities and other variants: any bundle dir for this
  // project id, most recently modified first.
  const prefix = `app.glaze.macos.${projectId}`;
  const candidates = fs
    .readdirSync(SUPPORT_DIR)
    .filter((name) => name === prefix || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}.`))
    .map((name) => path.join(SUPPORT_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates.length > 0) return candidates[0];

  throw new Error(
    `No data directory found for project "${projectId}" under ${SUPPORT_DIR}. ` +
      "Launch the app once so it creates its data directory, then retry.",
  );
}

export function readJsonFile(dataDir, fileName, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, fileName), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeJsonFile(dataDir, fileName, value) {
  const filePath = path.join(dataDir, fileName);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}
