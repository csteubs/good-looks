// The main window hearing about a settings change made in the OTHER window.
//
// This is the one piece of the Cost work that has no visible symptom until it
// is missing, and then the symptom is indistinguishable from "the setting does
// not work": you correct the CI price in Settings, come back to Stats, and the
// panel is still multiplying by the old one. `check:push-consumers` proves a
// subscriber exists for the channel; what it cannot prove is that the
// subscriber invalidates the query the panel actually reads from.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api";
import { useSettingsFreshness } from "./root-view";

vi.mock("../lib/api", () => ({
  api: { on: vi.fn(() => () => {}) },
}));

const on = api.on as unknown as ReturnType<typeof vi.fn>;

/** Fire whatever the hook subscribed to the given channel. */
function push(channel: string): void {
  const call = on.mock.calls.filter((c) => c[0] === channel)[0];
  if (!call) throw new Error(`nothing subscribed to ${channel}`);
  (call[1] as () => void)();
}

beforeEach(() => {
  on.mockClear();
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useSettingsFreshness(), { wrapper });
  return { qc, invalidate, view };
}

describe("useSettingsFreshness", () => {
  it("subscribes to the settings push", () => {
    setup();
    expect(on.mock.calls.map((c) => c[0])).toContain("settings:changed");
  });

  it("invalidates the query the Cost panel reads its assumptions from", () => {
    // The key matters as much as the invalidation: Batch and the library
    // sidebar share this exact cache entry, so a typo here refreshes nothing
    // and nothing throws.
    const { invalidate } = setup();
    push("settings:changed");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["recorder-settings"] });
  });

  it("does nothing until the push arrives", () => {
    // A hook that invalidated on mount would refetch on every navigation, which
    // is the cost this deliberately avoids.
    const { invalidate } = setup();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", () => {
    // The main window outlives every view in it; a subscription per mount would
    // accumulate one invalidation per navigation for the rest of the session.
    const off = vi.fn();
    on.mockReturnValueOnce(off);
    const { view } = setup();
    view.unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
