// Persists global trainer preferences (independent of any recording session)
// to a small JSON file under userData, mirroring llm-config-store.ts.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

import type { RecorderSettings, TestSpeed } from "../recorder/types.js";

const DEFAULT_SETTINGS: RecorderSettings = {
  showUrlBar: true,
  defaultRunSpeed: "slow",
  autoHealEnabled: true,
  autoHealRetries: 3,
  autoHealAttemptTimeoutMs: 4000,
};

function isTestSpeed(v: unknown): v is TestSpeed {
  return v === "slow" || v === "medium" || v === "fast";
}

function settingsFile(): string {
  return path.join(app.getPath("userData"), "recorder", "recorder-settings.json");
}

function read(): RecorderSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf-8")) as Partial<RecorderSettings>;
    return {
      showUrlBar: typeof parsed.showUrlBar === "boolean" ? parsed.showUrlBar : DEFAULT_SETTINGS.showUrlBar,
      defaultRunSpeed: isTestSpeed(parsed.defaultRunSpeed) ? parsed.defaultRunSpeed : DEFAULT_SETTINGS.defaultRunSpeed,
      autoHealEnabled: typeof parsed.autoHealEnabled === "boolean" ? parsed.autoHealEnabled : DEFAULT_SETTINGS.autoHealEnabled,
      autoHealRetries:
        typeof parsed.autoHealRetries === "number" && parsed.autoHealRetries > 0
          ? Math.min(Math.round(parsed.autoHealRetries), 10)
          : DEFAULT_SETTINGS.autoHealRetries,
      autoHealAttemptTimeoutMs:
        typeof parsed.autoHealAttemptTimeoutMs === "number" && parsed.autoHealAttemptTimeoutMs >= 1000
          ? Math.min(Math.round(parsed.autoHealAttemptTimeoutMs), 30000)
          : DEFAULT_SETTINGS.autoHealAttemptTimeoutMs,
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
      defaultRunSpeed: update.defaultRunSpeed !== undefined && isTestSpeed(update.defaultRunSpeed)
        ? update.defaultRunSpeed
        : current.defaultRunSpeed,
      autoHealEnabled: update.autoHealEnabled !== undefined ? update.autoHealEnabled : current.autoHealEnabled,
      autoHealRetries:
        update.autoHealRetries !== undefined && typeof update.autoHealRetries === "number" && update.autoHealRetries > 0
          ? Math.min(Math.round(update.autoHealRetries), 10)
          : current.autoHealRetries,
      autoHealAttemptTimeoutMs:
        update.autoHealAttemptTimeoutMs !== undefined &&
        typeof update.autoHealAttemptTimeoutMs === "number" &&
        update.autoHealAttemptTimeoutMs >= 1000
          ? Math.min(Math.round(update.autoHealAttemptTimeoutMs), 30000)
          : current.autoHealAttemptTimeoutMs,
    };
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), "utf-8");
    logger.info("recorder", "Saved trainer settings", {
      showUrlBar: next.showUrlBar,
      defaultRunSpeed: next.defaultRunSpeed,
      autoHealEnabled: next.autoHealEnabled,
      autoHealRetries: next.autoHealRetries,
      autoHealAttemptTimeoutMs: next.autoHealAttemptTimeoutMs,
    });
    return next;
  },
};
