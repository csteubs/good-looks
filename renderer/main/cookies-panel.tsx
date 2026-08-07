// Cookies tab in the trainer's bottom panel.
//
// Two things happen here and they are deliberately separate:
//   1. Editing the TRAINING BROWSER's cookies right now — e.g. pasting a
//      session cookie so you can record the checkout flow without recording the
//      login first.
//   2. Optionally recording that change as a test STEP, so a run reproduces it.
//
// Keeping (2) opt-in matters in both directions. Always recording would put an
// expiring auth token into the committed spec; never recording leaves the
// classic footgun where the test passes in the trainer and fails on a run,
// because the cookie that made it work was never part of the test.

import * as React from "react";
import {
  Badge,
  Button,
  Checkbox,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  toast,
} from "@ui";
import { Cookie as CookieIcon, Plus, RefreshCw, Trash2, X } from "lucide-react";

import { api } from "../lib/api";
import { fromDateTimeLocal, toDateTimeLocal } from "../lib/cookie-format";
import type { CookieSameSite, CookieSpec, LiveCookie, RawStep } from "../lib/recorder-types";

const SAME_SITE_OPTIONS: { value: CookieSameSite; label: string }[] = [
  { value: "unspecified", label: "Unspecified" },
  { value: "lax", label: "Lax" },
  { value: "strict", label: "Strict" },
  { value: "no_restriction", label: "None (cross-site)" },
];

/** Blank draft for the add/edit form. */
function emptyDraft(): CookieSpec {
  return { name: "", value: "", path: "/", sameSite: "unspecified" };
}

function fmtExpiry(spec: LiveCookie): string {
  if (spec.session || typeof spec.expirationDate !== "number") return "session";
  return new Date(spec.expirationDate * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function CookiesPanel({
  onInsertStep,
}: {
  /** Insert a cookie step into the test at the current cursor. */
  onInsertStep: (step: RawStep) => void;
}) {
  const [cookies, setCookies] = React.useState<LiveCookie[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [draft, setDraft] = React.useState<CookieSpec>(emptyDraft);
  const [editing, setEditing] = React.useState(false);
  // Whether a change should also be recorded as a test step. Defaults ON:
  // a cookie you needed in the trainer is usually one the test needs too, and
  // the failure mode of forgetting is a confusing run-time failure.
  const [alsoRecord, setAlsoRecord] = React.useState(true);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      setCookies(await api.recorder.listCookies());
    } catch {
      // The trainer window may have closed; an empty list is the honest view.
      setCookies([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const startEdit = (c: LiveCookie) => {
    setDraft({
      name: c.name,
      value: c.value ?? "",
      domain: c.domain,
      path: c.path ?? "/",
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite ?? "unspecified",
      ...(typeof c.expirationDate === "number" ? { expirationDate: c.expirationDate } : {}),
    });
    setEditing(true);
  };

  const save = async () => {
    if (!draft.name.trim()) {
      toast.error("A cookie needs a name.");
      return;
    }
    const spec: CookieSpec = { ...draft, name: draft.name.trim() };
    try {
      setCookies(await api.recorder.setCookie(spec));
      if (alsoRecord) {
        onInsertStep({ type: "cookie", cookieAction: "set", cookie: spec });
      }
      toast.success(alsoRecord ? "Cookie set and added as a step." : "Cookie set.");
      setDraft(emptyDraft());
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set the cookie.");
    }
  };

  const remove = async (c: LiveCookie) => {
    const spec: CookieSpec = { name: c.name, domain: c.domain, path: c.path, secure: c.secure };
    try {
      setCookies(await api.recorder.deleteCookie(spec));
      if (alsoRecord) {
        onInsertStep({ type: "cookie", cookieAction: "delete", cookie: spec });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete the cookie.");
    }
  };

  const clearAll = async () => {
    try {
      setCookies(await api.recorder.clearCookies());
      if (alsoRecord) onInsertStep({ type: "cookie", cookieAction: "clearAll" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear cookies.");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-separator px-3 py-1.5">
        <CookieIcon className="size-3.5 shrink-0 text-secondary" />
        <Text variant="small" color="secondary" className="min-w-0 truncate">
          {loading
            ? "Reading cookies…"
            : cookies.length === 0
              ? "No cookies for this page."
              : `${cookies.length} cookie${cookies.length === 1 ? "" : "s"} for this page`}
        </Text>
        <label className="ml-auto flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[11px] text-secondary">
          <Checkbox
            checked={alsoRecord}
            onCheckedChange={(v) => setAlsoRecord(v === true)}
            aria-label="Also add cookie changes to the test as steps"
          />
          Add to test as a step
        </label>
        <Button
          iconOnly
          variant="transparent"
          size="small"
          onClick={() => void refresh()}
          aria-label="Refresh cookies"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3">
          {/* Add / edit form */}
          <div className="flex flex-col gap-2 rounded-md border border-token-border bg-token-surface-raised p-2">
            <div className="flex items-center gap-2">
              <Input
                variant="filled"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="name"
                className="w-40"
                aria-label="Cookie name"
              />
              <Input
                variant="filled"
                value={draft.value ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
                placeholder="value"
                className="flex-1"
                aria-label="Cookie value"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                variant="filled"
                value={draft.domain ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, domain: e.target.value || undefined }))}
                placeholder="domain (blank = this site)"
                className="w-52"
                aria-label="Cookie domain"
              />
              <Input
                variant="filled"
                value={draft.path ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, path: e.target.value || undefined }))}
                placeholder="path"
                className="w-24"
                aria-label="Cookie path"
              />
              <Select
                value={draft.sameSite ?? "unspecified"}
                onValueChange={(v) => setDraft((d) => ({ ...d, sameSite: v as CookieSameSite }))}
              >
                <SelectTrigger variant="filled" size="small" className="w-40" aria-label="SameSite">
                  <SelectValue placeholder="SameSite" />
                </SelectTrigger>
                <SelectContent>
                  {SAME_SITE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-secondary">
                <Checkbox
                  checked={!!draft.secure}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, secure: v === true }))}
                  aria-label="Secure"
                />
                Secure
              </label>
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-secondary">
                <Checkbox
                  checked={!!draft.httpOnly}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, httpOnly: v === true }))}
                  aria-label="HttpOnly"
                />
                HttpOnly
              </label>
              {/* Without an expiry every cookie created here would silently be
                  a session cookie — invisible until a test failed after a
                  browser restart. Unchecking "Session" reveals the date field. */}
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-secondary">
                <Checkbox
                  checked={draft.expirationDate === undefined}
                  onCheckedChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      expirationDate:
                        v === true
                          ? undefined
                          : // Default a new expiry to a week out — a sensible,
                            // clearly-temporary lifetime for a test fixture.
                            Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
                    }))
                  }
                  aria-label="Session cookie (expires when the browser closes)"
                />
                Session
              </label>
              {draft.expirationDate !== undefined ? (
                <Input
                  variant="filled"
                  type="datetime-local"
                  value={toDateTimeLocal(draft.expirationDate)}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, expirationDate: fromDateTimeLocal(e.target.value) }))
                  }
                  className="w-52"
                  aria-label="Cookie expiry"
                />
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                {editing ? (
                  <Button
                    variant="glass"
                    size="small"
                    onClick={() => {
                      setDraft(emptyDraft());
                      setEditing(false);
                    }}
                  >
                    <X className="size-3.5" />
                    Cancel
                  </Button>
                ) : null}
                <Button variant="accent" size="small" onClick={() => void save()}>
                  <Plus className="size-3.5" />
                  {editing ? "Update cookie" : "Add cookie"}
                </Button>
              </div>
            </div>
          </div>

          {/* Existing cookies */}
          {cookies.length > 0 ? (
            <div className="rounded-md border border-token-border">
              {cookies.map((c) => (
                <div
                  key={`${c.name}|${c.domain ?? ""}|${c.path ?? ""}`}
                  className="flex items-center gap-2 border-b border-token-border px-2 py-1.5 last:border-b-0"
                >
                  <button
                    type="button"
                    onClick={() => startEdit(c)}
                    className="min-w-0 flex-1 truncate text-left text-[11px] hover:underline"
                    title={`${c.name}=${c.value ?? ""}`}
                  >
                    <span className="font-medium">{c.name}</span>
                    <span className="text-tertiary">={c.value ?? ""}</span>
                  </button>
                  <Text variant="small" color="tertiary" className="w-40 shrink-0 truncate">
                    {c.domain}
                    {c.path && c.path !== "/" ? c.path : ""}
                  </Text>
                  <span className="flex shrink-0 items-center gap-1">
                    {c.httpOnly ? <Badge color="secondary">HttpOnly</Badge> : null}
                    {c.secure ? <Badge color="secondary">Secure</Badge> : null}
                  </span>
                  <Text variant="small" color="tertiary" className="w-28 shrink-0 truncate">
                    {fmtExpiry(c)}
                  </Text>
                  <Button
                    iconOnly
                    variant="transparent"
                    size="small"
                    onClick={() => void remove(c)}
                    aria-label={`Delete cookie ${c.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {cookies.length > 0 ? (
            <div>
              <Button variant="glass" size="small" onClick={() => void clearAll()}>
                <Trash2 className="size-3.5" />
                Clear all cookies
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
