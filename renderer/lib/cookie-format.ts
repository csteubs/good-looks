// Conversions between a cookie's stored expiry and what a datetime-local input
// wants.
//
// Cookies store `expirationDate` as UNIX SECONDS (not milliseconds — the usual
// off-by-1000 trap), while `<input type="datetime-local">` reads and writes a
// LOCAL-time `YYYY-MM-DDTHH:mm` string with no timezone suffix. Feeding an ISO
// string straight into the input silently shows the wrong time for anyone not
// on UTC.
//
// Kept out of the panel component so check:cookie-steps can exercise them.

/** Unix seconds → the `YYYY-MM-DDTHH:mm` a datetime-local input expects, in
 *  LOCAL time. Returns "" for a missing/invalid value (i.e. a session cookie). */
export function toDateTimeLocal(unixSeconds: number | undefined): string {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) return "";
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  // Built from local getters rather than toISOString(), which is UTC and would
  // shift the displayed time by the viewer's offset.
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** A datetime-local value → unix seconds. Returns undefined for empty/invalid
 *  input, which the caller treats as "session cookie". */
export function fromDateTimeLocal(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const ms = new Date(trimmed).getTime();
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 1000);
}
