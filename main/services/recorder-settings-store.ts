// Persists global trainer preferences (independent of any recording session)
// to a small JSON file under userData, mirroring llm-config-store.ts.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

import type { RecorderSettings } from "../recorder/types.js";

const DEFAULT_SETTINGS: RecorderSettings = { showUrlBar: true };

function settingsFile(): string {
  return path.join(app.getPath("userData"), "recorder", "recorder-settings.json");
}

function read(): RecorderSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf-8")) as Partial<RecorderSettings>;
    return {
      showUrlBar: typeof parsed.showUrlBar === "boolean" ? parsed.showUrlBar : DEFAULT_SETTINGS.showUrlBar,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const recorderSettingsStore = {
  get(): RecorderSettings {
    return read();
  },

  set(update: Partial<RecorderSettings>): RecorderSettings {
    const current = read();
    const next: RecorderSettings = {
      showUrlBar: update.showUrlBar !== undefined ? update.showUrlBar : current.showUrlBar,
    };
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), "utf-8");
    logger.info("recorder", "Saved trainer settings", { showUrlBar: next.showUrlBar });
    return next;
  },
};
