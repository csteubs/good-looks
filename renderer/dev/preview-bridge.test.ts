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
//
// This covers NAMES. Shapes are the type-checker's job: every handler in
// preview-bridge.ts is annotated with the app's own return type, which is what
// catches a fixture answering the right channel with the wrong object. Both are
// needed — a name test cannot see a wrong shape, and `type-check` cannot see a
// channel nobody handles.

import { describe, expect, it } from "vitest";
import { handledChannels, installPreviewBridge, sdkChannels } from "./preview-bridge";
// The real api.ts, as text, resolved by the bundler.
//
// Not `fs.readFileSync` off `__dirname` or `import.meta.url`: this test runs in
// the jsdom project, where `__dirname` is not a defined global (renderer/ lints
// as browser code) and `import.meta.url` is an http:// URL Vite serves, which
// `fileURLToPath` rejects outright. `?raw` sidesteps both — and it means the
// path is checked at build time, so moving api.ts fails the import rather than
// silently reading nothing.
import API_SOURCE from "../lib/api.ts?raw";

/** Every `"namespace:verb"` string literal api.ts hands to `ipc().invoke`.
 *
 *  DIGITS ARE PART OF A NAMESPACE. The pattern was `[a-zA-Z]+` on both sides,
 *  which silently excluded the entire `a11y:` family — so every a11y channel
 *  counted as "not real", and a preview handler for one would be reported as
 *  INVENTED while a missing one went unnoticed. A guard against silent drift
 *  that is itself blind to a namespace is worse than none. */
function channelsInApi(): string[] {
  const found = API_SOURCE.match(/"[a-zA-Z][a-zA-Z0-9]*:[a-zA-Z][a-zA-Z0-9]*"/g) ?? [];
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
    // fine, and demanding 130 handlers would make this file a chore nobody
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
      // The Heals view unions these rows into its journal and the detail pane
      // maps the evidence join into figures. Unhandled, the propagation third
      // of that view is only ever its absence — and the evidence pane, the
      // one part jsdom cannot render lit, never gets looked at.
      "propagation:listAll",
      "propagation:evidence",
      "llm:getConfig",
      "llm:detect",
      "aiDebug:list",
      "batch:list",
      "batch:status",
      // The Batch screen is one Routine's editor now: with no answer here it
      // renders the "no routines yet" empty state and nothing else in the
      // preview can be looked at.
      "routines:list",
      "artifacts:usage",
      // The three metrics channels answer `{ available, … }` and every one of
      // their panels destructures it. `defaultFor` would hand back `null` —
      // which is a crash, not a degraded panel — so they cannot be left to it.
      "metrics:stepHealth",
      "metrics:slowness",
      "metrics:divergence",
      // Same reason: the view destructures `{ available, reason }` to decide
      // whether to render at all. `defaultFor` would hand it null.
      "branches:status",
      // The Insights view maps over the list and the rail row counts unread —
      // a `*:list` default of [] would render only the empty state, which is
      // the least interesting screen the fixtures exist to avoid.
      "insights:list",
      "insights:get",
      "insights:status",
    ];

    const handled = new Set(handledChannels());
    expect(mustHandle.filter((c) => !handled.has(c))).toEqual([]);

    // …and every name in that list must itself be real, or this test would
    // pass by pinning fiction.
    const real = new Set(channelsInApi());
    expect(mustHandle.filter((c) => !real.has(c))).toEqual([]);
  });

  it("exempts only channels the design system owns", () => {
    // `SDK_CHANNELS` exists so a known, permanent miss does not warn on every
    // load and train everyone to ignore the miss list. That exemption is only
    // legitimate while those channels really are the SDK's: the moment api.ts
    // starts naming one, the app owns it, and answering it from the exemption
    // list would hide a genuine gap behind a comment saying it is fine.
    const real = new Set(channelsInApi());
    expect(sdkChannels().filter((c) => real.has(c))).toEqual([]);

    // And the split has to be real in the other direction too — an empty
    // exemption list would make the assertion above vacuous.
    expect(sdkChannels().length).toBeGreaterThan(0);
  });
});

describe("preview bridge behaviour", () => {
  it("exposes the surface the renderer reaches for", async () => {
    const diagnostics = installPreviewBridge();
    const api = (window as unknown as { glazeAPI: Record<string, Record<string, unknown>> })
      .glazeAPI;

    expect(typeof (api.glaze as { ipc: { invoke: unknown } }).ipc.invoke).toBe("function");
    expect(typeof api.clipboard.writeText).toBe("function");
    expect(typeof api.Menu.popup).toBe("function");
    // `nativeTheme` was here and is deliberately gone with the light theme
    // (REDESIGN §0, A4): the preload no longer exposes it, so a preview that
    // still stubbed it would be answering a call the real app cannot make —
    // which is precisely the drift this whole file exists to catch.
    expect("nativeTheme" in api).toBe(false);
    expect(diagnostics.misses).toEqual({});
  });

  it("serves fixtures rather than empty lists", async () => {
    installPreviewBridge();
    const invoke = (
      window as unknown as {
        glazeAPI: { glaze: { ipc: { invoke<T>(c: string, ...a: unknown[]): Promise<T> } } };
      }
    ).glazeAPI.glaze.ipc.invoke;

    // The whole point of the preview is that the interesting states are on
    // screen. An empty library here would mean it renders empty states only —
    // which is the part of the UI least likely to be what a change touched.
    const tests = await invoke<unknown[]>("tests:list");
    expect(tests.length).toBeGreaterThan(1);

    const runs = await invoke<Array<{ status: string }>>("runs:list");
    expect(runs.some((r) => r.status === "failed")).toBe(true);
    expect(runs.some((r) => r.status === "passed")).toBe(true);

    // A heal awaiting review is the state the Heals view exists to resolve.
    const heals = await invoke<Array<{ status: string }>>("heals:pending");
    expect(heals.length).toBeGreaterThan(0);
  });

  it("reports metrics as available, with rows", async () => {
    // `available: false` and "no history" render differently on purpose
    // (see api.ts). The preview seeds the populated state, because the empty
    // one is what you get for free by not handling the channel at all.
    installPreviewBridge();
    const invoke = (
      window as unknown as {
        glazeAPI: { glaze: { ipc: { invoke<T>(c: string, ...a: unknown[]): Promise<T> } } };
      }
    ).glazeAPI.glaze.ipc.invoke;

    const health = await invoke<{ available: boolean; rows: unknown[] }>("metrics:stepHealth");
    expect(health.available).toBe(true);
    expect(health.rows.length).toBeGreaterThan(0);

    // `slowed` is a subset of `rows` in the real query. A fixture where it is
    // not makes the panel render "3 of 2 steps slowed".
    const slow = await invoke<{
      rows: Array<{ stepId: string }>;
      slowed: Array<{ stepId: string }>;
    }>("metrics:slowness");
    const ids = new Set(slow.rows.map((r) => r.stepId));
    expect(slow.slowed.every((r) => ids.has(r.stepId))).toBe(true);
  });

  it("records unknown channels instead of pretending to answer them", async () => {
    const diagnostics = installPreviewBridge();
    const invoke = (
      window as unknown as { glazeAPI: { glaze: { ipc: { invoke<T>(c: string): Promise<T> } } } }
    ).glazeAPI.glaze.ipc.invoke;

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
    const invoke = (
      window as unknown as {
        glazeAPI: { glaze: { ipc: { invoke<T>(c: string, ...a: unknown[]): Promise<T> } } };
      }
    ).glazeAPI.glaze.ipc.invoke;

    const [first] = await invoke<Array<{ id: string; name: string }>>("tests:list");
    // One options object, exactly as api.ts sends it. Passing these
    // positionally is the mistake that makes a handler silently find nothing.
    await invoke("tests:rename", { id: first.id, name: "Renamed in preview" });

    const after = await invoke<Array<{ id: string; name: string }>>("tests:list");
    expect(after.find((t) => t.id === first.id)?.name).toBe("Renamed in preview");
  });

  it("reads arguments the way api.ts sends them", async () => {
    installPreviewBridge();
    const invoke = (
      window as unknown as {
        glazeAPI: { glaze: { ipc: { invoke<T>(c: string, ...a: unknown[]): Promise<T> } } };
      }
    ).glazeAPI.glaze.ipc.invoke;

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

describe("push events", () => {
  // `on` WAS A NO-OP, and that quietly bounded what the preview could show to
  // whatever a view renders before anything happens to it. Everything in this
  // app with a *result* arrives by push, so "Run test" started a run that could
  // never finish and the run panel was only reachable in its Running state.
  type Ipc = {
    invoke<T>(c: string, p?: unknown): Promise<T>;
    on(c: string, fn: (...args: unknown[]) => void): () => void;
  };
  const ipc = () =>
    (window as unknown as { glazeAPI: { glaze: { ipc: Ipc } } }).glazeAPI.glaze.ipc;

  /** Collect every payload pushed on `channel`, unwrapped the way api.ts does. */
  function collect(channel: string): unknown[] {
    const seen: unknown[] = [];
    // `args[1]`, exactly as `api.on` reads it — the real preload hands
    // Electron's IpcRendererEvent first. A bus that emitted the payload alone
    // would call every subscriber with `undefined`: nothing renders, nothing
    // throws, and no miss is recorded. That is the bug this line pins, and it
    // is the one the first version of the bus actually had.
    ipc().on(channel, (...args: unknown[]) => seen.push(args[1]));
    return seen;
  }

  it("delivers a payload the way api.on unwraps it", async () => {
    // `runTickMs: 1` in every test that starts a run — see "the scripted run"
    // below. These three assert on the synchronous first emit and the return
    // value, but the run they start keeps its timers past the test's end, and
    // at the preview's pace that is seconds of stray wake-ups per test.
    installPreviewBridge({ runTickMs: 1 });
    const out = collect("runner:output");
    await ipc().invoke("runner:run", { id: "t-login", headed: false });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatchObject({ runId: "t-login" });
  });

  it("stops delivering after unsubscribe", async () => {
    installPreviewBridge({ runTickMs: 1 });
    const seen: unknown[] = [];
    const off = ipc().on("runner:output", (...args: unknown[]) => seen.push(args[1]));
    off();
    await ipc().invoke("runner:run", { id: "t-login", headed: false });
    expect(seen).toHaveLength(0);
  });

  it("keys the run by the TEST id api.ts sends", async () => {
    // api.ts sends `{ id }`, not `{ testId }`, and the store keys its run map
    // by the test id. Read the wrong key and the panel watches a run nobody is
    // reporting on — which renders as a run that never finishes.
    installPreviewBridge({ runTickMs: 1 });
    const { runId } = await ipc().invoke<{ runId: string }>("runner:run", {
      id: "t-login",
      headed: false,
    });
    expect(runId).toBe("t-login");
  });
});

describe("the scripted run", () => {
  // Every test here awaits `runner:done`, and at the preview's 260ms tick that
  // wall-clock is the fixture's step count in real time — two ticks a step, so
  // t-checkout's twelve steps held the pass-path test 6.5s against vitest's 5s
  // default. It wore a per-test timeout for a while, which re-coupled on every
  // fixture change: growing t-checkout meant growing a number here, and a loop
  // block was once routed to t-search to duck exactly that. `runTickMs: 1`
  // ends the coupling — the pacing is presentation, not behaviour, and nothing
  // asserted here depends on it.
  type Ipc = {
    invoke<T>(c: string, p?: unknown): Promise<T>;
    on(c: string, fn: (...args: unknown[]) => void): () => void;
  };
  const ipc = () =>
    (window as unknown as { glazeAPI: { glaze: { ipc: Ipc } } }).glazeAPI.glaze.ipc;

  /** Run a fixture test to completion, collecting every step event and the
   *  exit code. The script is timer-driven so the steps arrive in order rather
   *  than all at once — which is the half of the screen that was already
   *  reachable without it. */
  async function runToCompletion(id: string) {
    const steps: { index: number; status: string; ok: boolean }[] = [];
    let code: number | null = null;
    ipc().on("runner:step", (...a: unknown[]) => steps.push(a[1] as never));
    const done = new Promise<void>((resolve) => {
      ipc().on("runner:done", (...a: unknown[]) => {
        code = (a[1] as { code: number }).code;
        resolve();
      });
    });
    await ipc().invoke("runner:run", { id, headed: false });
    await done;
    return { steps, code };
  }

  it("finishes, rather than running forever", async () => {
    installPreviewBridge({ runTickMs: 1 });
    const { code } = await runToCompletion("t-login");
    expect(code).not.toBeNull();
  });

  it("fails the test whose fixture history failed", async () => {
    // THE OUTCOME COMES FROM THE FIXTURE, not a coin flip. That is what makes
    // `?test=t-login` a stable address for "show me the failed path" — a
    // random outcome would mean a screenshot nobody can ask for twice.
    installPreviewBridge({ runTickMs: 1 });
    expect((await runToCompletion("t-login")).code).toBe(1);
  });

  it("passes the test whose fixture history passed", async () => {
    installPreviewBridge({ runTickMs: 1 });
    expect((await runToCompletion("t-checkout")).code).toBe(0);
  });

  it("leaves the steps after a failure unreported, as Playwright would", async () => {
    // Not marked passed, not marked failed — never attempted. A run that
    // greened everything after the failing step would be claiming those steps
    // ran, which is the one thing a step list must not lie about.
    installPreviewBridge({ runTickMs: 1 });
    const { steps } = await runToCompletion("t-login");
    const failed = steps.filter((s) => s.status === "end" && !s.ok);
    expect(failed).toHaveLength(1);
    const lastReported = Math.max(...steps.map((s) => s.index));
    expect(lastReported).toBe(failed[0].index);
  });

  it("stops a run with its current step left OPEN, as a SIGKILL does", async () => {
    // The real Stop kills the Playwright process; the reporter dies with the
    // step it began still unclosed, and no `end` for it ever arrives. The
    // preview has to reproduce that shape — the store's job is to settle that
    // step when the run reports done, and a preview that closed it tidily
    // would never show the spinner-after-stop bug the store fixes. A longer
    // tick here so the stop lands between the first `begin` and its `end`.
    installPreviewBridge({ runTickMs: 50 });
    const steps: { index: number; status: string; ok: boolean }[] = [];
    let code: number | null = null;
    ipc().on("runner:step", (...a: unknown[]) => steps.push(a[1] as never));
    const firstBegin = new Promise<void>((resolve) => {
      ipc().on("runner:step", () => resolve());
    });
    const done = new Promise<void>((resolve) => {
      ipc().on("runner:done", (...a: unknown[]) => {
        code = (a[1] as { code: number }).code;
        resolve();
      });
    });
    await ipc().invoke("runner:run", { id: "t-checkout", headed: false });
    await firstBegin;
    await ipc().invoke("runner:stop", { runId: "t-checkout" });
    await done;
    expect(code).not.toBe(0);
    expect(steps).toEqual([{ runId: "t-checkout", index: 0, status: "begin", ok: true, line: 4 }]);
    // Cancelled, not merely superseded: no tick of the stopped run fires
    // afterwards, which would report steps on a run the store has closed.
    await new Promise((r) => setTimeout(r, 120));
    expect(steps).toHaveLength(1);
  });
});

describe("the trainer route", () => {
  // `RootShell` swaps the whole outlet for `RecordingView` only while
  // `state.recording`, and nothing in a browser tab can make that true — there
  // is no training window to record. So the trainer, a fifth of this app's UI,
  // had no address in the preview at all before B6.
  type Ipc = { invoke<T>(c: string, p?: unknown): Promise<T> };
  const ipc = () => (window as unknown as { glazeAPI: { glaze: { ipc: Ipc } } }).glazeAPI.glaze.ipc;

  function withView(view: string | null, fn: () => Promise<void>) {
    const original = window.location.search;
    // jsdom allows replaceState, which is enough — the bridge reads
    // `location.search` on every call rather than capturing it once.
    window.history.replaceState({}, "", view === null ? "/" : `/?view=${view}`);
    return fn().finally(() => window.history.replaceState({}, "", original || "/"));
  }

  it("reports an idle recorder by default", async () => {
    installPreviewBridge();
    await withView(null, async () => {
      const state = await ipc().invoke<{ recording: boolean }>("recorder:getState");
      expect(state.recording).toBe(false);
    });
  });

  it("reports a live session under ?view=recorder", async () => {
    installPreviewBridge();
    await withView("recorder", async () => {
      const state = await ipc().invoke<{ recording: boolean; pageReady: boolean; url: string | null }>(
        "recorder:getState",
      );
      expect(state.recording).toBe(true);
      // `pageReady` matters as much as `recording`: the view renders a
      // "Loading page…" chip and disables every control until it is true, so a
      // half-seeded state would show the trainer's inert shell and nothing else.
      expect(state.pageReady).toBe(true);
      expect(state.url).toBeTruthy();
    });
  });

  it("gives that session real steps to render", async () => {
    installPreviewBridge();
    await withView("recorder", async () => {
      const steps = await ipc().invoke<unknown[]>("recorder:getSteps");
      expect(steps.length).toBeGreaterThan(0);
    });
  });

  it("leaves the step list empty when the flag is off", async () => {
    installPreviewBridge();
    await withView(null, async () => {
      expect(await ipc().invoke<unknown[]>("recorder:getSteps")).toHaveLength(0);
    });
  });
});
