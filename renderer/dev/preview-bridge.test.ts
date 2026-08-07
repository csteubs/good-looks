// The guard that keeps the preview honest.
//
// A fake backend fails silently by construction: a channel gets renamed, the
// fake stops recognising it, the view falls back to its empty state, and the
// preview cheerfully shows "no tests" for a library that has four. Nothing
// throws. Nobody notices until someone reviews a change against data that was
// never there.
//
// So this reads the channel names straight out of api.ts — the real source —
// and pins two independent properties against it.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { handledChannels, installPreviewBridge } from "./preview-bridge";

/** Every `"namespace:verb"` string literal api.ts hands to `ipc().invoke`. */
function channelsInApi(): string[] {
  const source = fs.readFileSync(path.resolve(__dirname, "../lib/api.ts"), "utf8");
  const found = source.match(/"[a-zA-Z]+:[a-zA-Z]+"/g) ?? [];
  return [...new Set(found.map((s) => s.slice(1, -1)))].sort();
}

describe("preview bridge channel coverage", () => {
  it("names only channels that actually exist", () => {
    // The direction that catches a rename. If api.ts renames
    // `recorder:state` to `recorder:getState`, the handler keyed by the old
    // name silently stops being reachable — and the ONLY visible symptom is a
    // view rendering an empty state, which looks like real data.
    const real = new Set(channelsInApi());
    const invented = handledChannels().filter((c) => !real.has(c));

    expect(invented).toEqual([]);
  });

  it("handles every channel whose answer gets dereferenced", () => {
    // Not every channel needs a fixture — a mutation resolving to null is
    // fine, and demanding 124 handlers would make this file a chore nobody
    // updates. These are the ones a view reads a property off or iterates, so
    // a wrong shape is a white screen rather than a cosmetic gap.
    const mustHandle = [
      "tests:list",
      "tests:get",
      "tests:getScript",
      "recorder:getState",
      "recorder:getSettings",
      "recorder:getSteps",
      "runs:list",
      "runs:getLog",
      "heals:list",
      "heals:pending",
      "llm:getConfig",
      "llm:detect",
      "aiDebug:list",
      "batch:list",
      "batch:status",
      "artifacts:usage",
    ];

    const handled = new Set(handledChannels());
    expect(mustHandle.filter((c) => !handled.has(c))).toEqual([]);

    // …and every name in that list must itself be real, or this test would
    // pass by pinning fiction.
    const real = new Set(channelsInApi());
    expect(mustHandle.filter((c) => !real.has(c))).toEqual([]);
  });
});

describe("preview bridge behaviour", () => {
  it("exposes the surface the renderer reaches for", async () => {
    const diagnostics = installPreviewBridge();
    const api = (window as unknown as { glazeAPI: Record<string, Record<string, unknown>> }).glazeAPI;

    expect(typeof (api.glaze as { ipc: { invoke: unknown } }).ipc.invoke).toBe("function");
    expect(typeof api.clipboard.writeText).toBe("function");
    expect(typeof api.Menu.popup).toBe("function");
    expect(typeof api.nativeTheme.getInfo).toBe("function");
    expect(diagnostics.misses).toEqual({});
  });

  it("serves fixtures rather than empty lists", async () => {
    installPreviewBridge();
    const invoke = (window as unknown as {
      glazeAPI: { glaze: { ipc: { invoke<T>(c: string, ...a: unknown[]): Promise<T> } } };
    }).glazeAPI.glaze.ipc.invoke;

    // The whole point of the preview is that the interesting states are on
    // screen. An empty library here would mean it renders empty states only —
    // which is the part of the UI least likely to be what a change touched.
    const tests = await invoke<unknown[]>("tests:list");
    expect(tests.length).toBeGreaterThan(1);

    const runs = await invoke<Array<{ status: string }>>("runs:list");
    expect(runs.some((r) => r.status === "failed")).toBe(true);
    expect(runs.some((r) => r.status === "passed")).toBe(true);
  });

  it("records unknown channels instead of pretending to answer them", async () => {
    const diagnostics = installPreviewBridge();
    const invoke = (window as unknown as {
      glazeAPI: { glaze: { ipc: { invoke<T>(c: string): Promise<T> } } };
    }).glazeAPI.glaze.ipc.invoke;

    // Shaped by name so a view awaiting a list gets one, rather than crashing
    // on `undefined.map` — but the miss is still recorded, which is what makes
    // the gap findable instead of invisible.
    expect(await invoke("nonexistent:list")).toEqual([]);
    expect(await invoke("nonexistent:hasThing")).toBe(false);
    expect(await invoke("nonexistent:whatever")).toBeNull();

    expect(diagnostics.misses).toEqual({
      "nonexistent:list": 1,
      "nonexistent:hasThing": 1,
      "nonexistent:whatever": 1,
    });
  });

  it("keeps mutations for the session", async () => {
    installPreviewBridge();
    const invoke = (window as unknown as {
      glazeAPI: { glaze: { ipc: { invoke<T>(c: string, ...a: unknown[]): Promise<T> } } };
    }).glazeAPI.glaze.ipc.invoke;

    const [first] = await invoke<Array<{ id: string; name: string }>>("tests:list");
    // One options object, exactly as api.ts sends it. Passing these
    // positionally is the mistake that makes a handler silently find nothing.
    await invoke("tests:rename", { id: first.id, name: "Renamed in preview" });

    const after = await invoke<Array<{ id: string; name: string }>>("tests:list");
    expect(after.find((t) => t.id === first.id)?.name).toBe("Renamed in preview");
  });

  it("reads arguments the way api.ts sends them", async () => {
    installPreviewBridge();
    const invoke = (window as unknown as {
      glazeAPI: { glaze: { ipc: { invoke<T>(c: string, ...a: unknown[]): Promise<T> } } };
    }).glazeAPI.glaze.ipc.invoke;

    // The regression this pins: `tests:get` reading a positional id finds
    // nothing, returns null, and test-detail-view renders an empty toolbar —
    // no error, no console output, no recorded miss. A blank pane is the only
    // symptom, which reads as a layout bug rather than a bridge bug.
    const [first] = await invoke<Array<{ id: string }>>("tests:list");
    const byPayload = await invoke<{ id: string } | null>("tests:get", { id: first.id });

    expect(byPayload).not.toBeNull();
    expect(byPayload?.id).toBe(first.id);
  });
});
