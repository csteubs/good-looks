// The trainer agent against the REAL app: a live recording session, the real
// verify gate, and a SCRIPTED model — a local HTTP server speaking Ollama's
// /api/chat protocol, pointed at via llm:setConfig's baseUrls override. The
// script proposes one click that resolves and one that cannot, then claims
// done on the recovery turn: exactly the plan a model produces on a page it
// half-understood, and the decisions under test are the loop's — one
// insertion, the failure fed back as evidence, the group bracketing what
// landed, no double-capture, and an assertion card that inserts only on
// accept, verified against the same live page.
//
// The loop's own state machine is main/services/agent/
// trainer-agent-service.test.ts — stubbed deps, every branch. What only
// THIS can prove is the assembled thing: the real llm-service speaking to a
// real (scripted) endpoint, the real page executor, the real step list.
//
// VERIFIED TO FAIL: insert in tryOneStep regardless of `outcome.ok` and the
// bogus click lands in the list; drop the evidence assignment in the loop
// and the second /api/chat body carries no FAILED STEP line.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect, type AppFixtures } from "./fixtures.js";

interface Step {
  id: string;
  type: string;
  label?: string;
  locator?: { name?: string; v?: string };
}

interface AgentEventRecord {
  runId: string;
  seq: number;
  event:
    | { kind: "state"; state: string }
    | { kind: "say"; who: string; text: string }
    | { kind: "step"; label: string; status: string; detail?: string }
    | { kind: "proposal"; id: string; label: string }
    | { kind: "proposal-resolved"; id: string; accepted: boolean; outcome?: string }
    | { kind: "finished"; reason: string; note?: string };
}

interface AgentRunSnapshot {
  runId: string | null;
  running: boolean;
  state: string;
  events: AgentEventRecord[];
}

type Invoke = { glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } } };

function invoke<T>(window: AppFixtures["window"], channel: string, params?: unknown): Promise<T> {
  return window.evaluate(
    async (args) =>
      (window as unknown as { glazeAPI: Invoke }).glazeAPI.glaze.ipc.invoke(
        args.channel,
        args.params,
      ) as Promise<T>,
    { channel, params },
  ) as Promise<T>;
}

function trainingPage(app: AppFixtures["app"]) {
  return app.windows().find((p) => p.url().startsWith("http://127.0.0.1"));
}

async function waitForPageReady(window: AppFixtures["window"]): Promise<void> {
  await expect
    .poll(async () => (await invoke<{ pageReady: boolean }>(window, "recorder:getState")).pageReady, {
      timeout: 20_000,
    })
    .toBe(true);
}

async function stepLabels(window: AppFixtures["window"]): Promise<string[]> {
  const steps = await invoke<Step[]>(window, "recorder:getSteps");
  return steps.map((s) =>
    s.type === "click"
      ? `click:${s.locator?.name ?? "?"}`
      : s.type === "group"
        ? `group:${s.label ?? ""}`
        : s.type,
  );
}

async function stopRecording(window: AppFixtures["window"]): Promise<void> {
  await invoke(window, "recorder:stop");
  await expect
    .poll(async () => (await invoke<{ recording: boolean }>(window, "recorder:getState")).recording, {
      timeout: 20_000,
    })
    .toBe(false);
}

async function servePage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      "<!doctype html><title>agent</title>" +
        "<button id=\"a\" onclick=\"document.getElementById('out').textContent='clicked'\">First</button>" +
        '<p id="out"></p>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const RESOLVES = { type: "click", locator: { k: "role", role: "button", name: "First" } };
const CANNOT = { type: "click", locator: { k: "role", role: "button", name: "Nowhere" } };

/** The scripted model. Turn one plans a step that works and one that cannot;
 *  every later turn claims done and proposes one assertion — so the run
 *  exercises act → fail → recover → finish, and leaves a card behind. */
async function serveLlm(): Promise<{
  url: string;
  chatBodies: () => string[];
  close: () => Promise<void>;
}> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/chat") {
        bodies.push(raw);
        const turn =
          bodies.length === 1
            ? { note: "Pressing the button, twice.", steps: [RESOLVES, CANNOT] }
            : {
                note: "Done — the page reacted.",
                done: true,
                assertions: [{ type: "assert", assert: "visible", locator: { k: "css", v: "#out" } }],
              };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: { content: JSON.stringify(turn) }, done: true }));
        return;
      }
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "stub" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    chatBodies: () => bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the agent inserts only what ran, recovers with evidence, and a card inserts on accept", async ({
  app,
  window,
}) => {
  const page = await servePage();
  const llm = await serveLlm();
  try {
    await invoke(window, "llm:setConfig", {
      baseUrls: { ollama: llm.url },
      roles: { chat: { provider: "ollama", model: "stub" } },
    });
    await invoke(window, "recorder:start", { url: page.url, name: "agent loop" });
    await waitForPageReady(window);
    const browser = trainingPage(app)!;
    await browser.waitForLoadState("domcontentloaded");

    const started = await invoke<{ ok: boolean; reason?: string }>(window, "agent:start", {
      goal: "press the go button",
    });
    expect(started.ok, started.reason).toBe(true);

    await expect
      .poll(async () => (await invoke<AgentRunSnapshot>(window, "agent:getRun")).running, {
        timeout: 60_000,
      })
      .toBe(false);
    const snapshot = await invoke<AgentRunSnapshot>(window, "agent:getRun");
    const events = snapshot.events.map((r) => r.event);

    // The run finished by reaching the goal — not by budget or error.
    expect(events.find((e) => e.kind === "finished")).toMatchObject({ reason: "goal" });

    // Exactly one step ran and one failed, in that order, on the live page.
    const stepEvents = events.filter((e) => e.kind === "step");
    expect(stepEvents.map((e) => (e as { status: string }).status)).toEqual(["ran", "failed"]);
    await expect(browser.locator("#out")).toHaveText("clicked");

    // The recovery turn carried the failure and the probe's evidence — the
    // second /api/chat body is the proof the loop fed back what happened.
    expect(llm.chatBodies()).toHaveLength(2);
    expect(llm.chatBodies()[1]).toContain("FAILED STEP");
    expect(llm.chatBodies()[1]).toContain("EVIDENCE");

    // What landed: ONE verified click, bracketed by the goal's group — never
    // the bogus step, and the verified try was not captured a second time.
    expect(await stepLabels(window)).toEqual([
      "goto",
      "group:press the go button",
      "click:First",
      "endGroup",
    ]);

    // The assertion card inserts ONLY on accept, and the accept verifies it
    // against the same live page before anything lands.
    const proposal = events.find((e) => e.kind === "proposal") as { id: string } | undefined;
    expect(proposal, "the done turn proposed an assertion card").toBeTruthy();
    expect(await stepLabels(window)).not.toContain("assert");
    const resolved = await invoke<{ ok: boolean; detail?: string }>(window, "agent:resolveProposal", {
      id: proposal!.id,
      accept: true,
    });
    expect(resolved.ok, resolved.detail).toBe(true);
    expect(await stepLabels(window)).toEqual([
      "goto",
      "group:press the go button",
      "click:First",
      "endGroup",
      "assert",
    ]);
  } finally {
    await stopRecording(window).catch(() => {});
    await llm.close();
    await page.close();
  }
});
