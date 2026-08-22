// The two halves of "a dead stdout cannot kill the app".
//
// The real end-to-end proof is `check:logger-epipe`, which orphans a child
// process and watches it survive — the async half of this cannot be observed
// in-process, because it arrives from the event loop. What is covered here is
// everything a unit test CAN settle: that the handler is attached, that it is
// attached once, that a missing stream is tolerated, and that the synchronous
// half swallows what the user's stack trace actually showed.

import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

import { guardStdio, writeSafely } from "./stdio-guard";

/** A stand-in for `process.stdout`: an EventEmitter is exactly the surface the
 *  guard uses, and using the real stdout here would attach handlers to the test
 *  runner's own streams. */
function fakeStream() {
  return new EventEmitter() as unknown as NodeJS.WriteStream;
}

describe("guardStdio", () => {
  it("makes an error event non-fatal instead of an uncaught exception", () => {
    const s = fakeStream();
    guardStdio([s]);
    // Without a listener, emitting "error" on an EventEmitter THROWS. That is
    // precisely how the EPIPE reached Electron's uncaught-exception dialog.
    expect(() => s.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })))
      .not.toThrow();
  });

  it("attaches once, however many times it is called", () => {
    // Not tidiness: the guard is called at logger module load, and a listener
    // per call would walk into Node's max-listeners warning — which prints to
    // the very stream that is already broken.
    const s = fakeStream();
    guardStdio([s]);
    guardStdio([s]);
    guardStdio([s]);
    expect((s as unknown as EventEmitter).listenerCount("error")).toBe(1);
  });

  it("tolerates a stream that is not there", () => {
    // A process launched with its stdio detached has `process.stdout === null`.
    // The guard for a dead stream must not be the thing that throws.
    expect(() => guardStdio([null, undefined])).not.toThrow();
  });

  it("guards each stream independently", () => {
    const out = fakeStream();
    const err = fakeStream();
    guardStdio([out, err]);
    expect(() => err.emit("error", new Error("write EPIPE"))).not.toThrow();
    expect(() => out.emit("error", new Error("write EPIPE"))).not.toThrow();
  });
});

describe("writeSafely", () => {
  it("swallows a synchronous throw — the half the reported stack showed", () => {
    // The user's trace ran afterWriteDispatched -> console.log -> log(), i.e.
    // straight back out of the call. `guardStdio` cannot see that one.
    const boom = vi.fn(() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });
    expect(() => writeSafely(boom, "a line")).not.toThrow();
    expect(boom).toHaveBeenCalledWith("a line");
  });

  it("still writes when the stream is healthy", () => {
    const ok = vi.fn();
    writeSafely(ok, "a line");
    expect(ok).toHaveBeenCalledWith("a line");
  });
});
