// Persists global trainer preferences (independent of any recording session)
// to a small JSON file under userData, mirroring llm-config-store.ts.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

import type { RecorderSettings, TestSpeed } from "../recorder/types.js";
import { DEFAULT_RETAINED_RUNS } from "./artifact-store.js";

/** Bounds for `artifactRetainedRuns`. 1 keeps only the newest run (the pinned
 *  baseline is stored separately and is never pruned); 50 is a generous ceiling
 *  — at ~0.6 MB per captured run for a small test that's ~30 MB per test. */
const MIN_RETAINED_RUNS = 1;
const MAX_RETAINED_RUNS = 50;

/** Bounds for `artifactRetentionDays`. 0 disables age-based pruning entirely
 *  (the run-count cap still applies); 365 is a sane ceiling for a local app. */
const MAX_RETENTION_DAYS = 365;

function clampDays(n: number): number {
  return Math.min(MAX_RETENTION_DAYS, Math.max(0, Math.round(n)));
}

function clampRetained(n: number): number {
  return Math.min(MAX_RETAINED_RUNS, Math.max(MIN_RETAINED_RUNS, Math.round(n)));
}

const DEFAULT_SETTINGS: RecorderSettings = {
  showUrlBar: true,
  defaultRunSpeed: "slow",
  autoHealEnabled: true,
  autoHealRetries: 3,
  autoHealAttemptTimeoutMs: 4000,
  defaultCaptureArtifacts: false,
  defaultRunHeadless: false,
  artifactRetainedRuns: DEFAULT_RETAINED_RUNS,
  artifactRetentionDays: 0,
  disabledAestheticEnhancements: [],
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
      defaultCaptureArtifacts:
        typeof parsed.defaultCaptureArtifacts === "boolean"
          ? parsed.defaultCaptureArtifacts
          : DEFAULT_SETTINGS.defaultCaptureArtifacts,
      defaultRunHeadless:
        typeof parsed.defaultRunHeadless === "boolean"
          ? parsed.defaultRunHeadless
          : DEFAULT_SETTINGS.defaultRunHeadless,
      artifactRetainedRuns:
        typeof parsed.artifactRetainedRuns === "number" && parsed.artifactRetainedRuns > 0
          ? clampRetained(parsed.artifactRetainedRuns)
          : DEFAULT_SETTINGS.artifactRetainedRuns,
      artifactRetentionDays:
        typeof parsed.artifactRetentionDays === "number" && parsed.artifactRetentionDays >= 0
          ? clampDays(parsed.artifactRetentionDays)
          : DEFAULT_SETTINGS.artifactRetentionDays,
      disabledAestheticEnhancements:
        Array.isArray(parsed.disabledAestheticEnhancements) &&
        parsed.disabledAestheticEnhancements.every((v) => typeof v === "string")
          ? parsed.disabledAestheticEnhancements
          : DEFAULT_SETTINGS.disabledAestheticEnhancements,
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
      defaultCaptureArtifacts:
        update.defaultCaptureArtifacts !== undefined
          ? update.defaultCaptureArtifacts
          : current.defaultCaptureArtifacts,
      defaultRunHeadless:
        update.defaultRunHeadless !== undefined
          ? update.defaultRunHeadless
          : current.defaultRunHeadless,
      artifactRetainedRuns:
        update.artifactRetainedRuns !== undefined &&
        typeof update.artifactRetainedRuns === "number" &&
        update.artifactRetainedRuns > 0
          ? clampRetained(update.artifactRetainedRuns)
          : current.artifactRetainedRuns,
      artifactRetentionDays:
        update.artifactRetentionDays !== undefined &&
        typeof update.artifactRetentionDays === "number" &&
        update.artifactRetentionDays >= 0
          ? clampDays(update.artifactRetentionDays)
          : current.artifactRetentionDays,
      disabledAestheticEnhancements:
        update.disabledAestheticEnhancements !== undefined &&
        Array.isArray(update.disabledAestheticEnhancements) &&
        update.disabledAestheticEnhancements.every((v) => typeof v === "string")
          ? update.disabledAestheticEnhancements
          : current.disabledAestheticEnhancements,
    };
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), "utf-8");
    logger.info("recorder", "Saved trainer settings", {
      showUrlBar: next.showUrlBar,
      defaultRunSpeed: next.defaultRunSpeed,
      autoHealEnabled: next.autoHealEnabled,
      autoHealRetries: next.autoHealRetries,
      autoHealAttemptTimeoutMs: next.autoHealAttemptTimeoutMs,
      defaultCaptureArtifacts: next.defaultCaptureArtifacts,
      defaultRunHeadless: next.defaultRunHeadless,
      artifactRetainedRuns: next.artifactRetainedRuns,
      artifactRetentionDays: next.artifactRetentionDays,
      disabledAestheticEnhancements: next.disabledAestheticEnhancements,
    });
    return next;
  },
};
