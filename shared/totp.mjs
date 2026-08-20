// TOTP (RFC 6238) — the MATH only, single-sourced for the two places that
// compute codes: the app (trainer replay derives the code a fill types) and
// the generated runtime (glaze-runtime.mjs embeds these functions via
// toString, the step-semantics idiom). Two implementations of an OTP
// algorithm is how a trainer that logs in and a run that doesn't happens.
//
// PURE (CLAUDE.md): no crypto import — the HMAC comes IN as a function,
// because this module cannot touch node builtins and the two callers already
// have crypto on their own side. Both embedded functions must stay
// self-contained (no free identifiers beyond their parameters and each
// other), for the same reason gateFailures must: they are serialized into
// the spec runtime.

/**
 * Decode an RFC 4648 base32 secret (the shape authenticator setup keys use).
 * Case-insensitive, ignores spaces and `=` padding. Returns a byte array, or
 * null when a character is outside the alphabet — a typo'd key must be a
 * clear error at the call site, not a silently wrong code.
 *
 * @param {string} secret
 * @returns {number[] | null}
 */
export function base32Bytes(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(secret).toUpperCase().replace(/[\s=]/g, "");
  if (clean.length === 0) return null;
  let bits = 0;
  let acc = 0;
  const out = [];
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * The RFC 6238 code for a moment in time, given an HMAC.
 *
 * @param {(keyBytes: number[], msgBytes: number[]) => number[]} hmacSha1
 *   HMAC-SHA1 as bytes-in/bytes-out — each caller wraps its own crypto.
 * @param {string} secret   base32 setup key
 * @param {number} nowMs    current time in ms
 * @param {number} [digits] code length (default 6)
 * @param {number} [stepSeconds] time step (default 30)
 * @returns {string | null} the zero-padded code, or null on a bad secret
 */
export function totpCode(hmacSha1, secret, nowMs, digits, stepSeconds) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(secret).toUpperCase().replace(/[\s=]/g, "");
  if (clean.length === 0) return null;
  let bits = 0;
  let acc = 0;
  const key = [];
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      key.push((acc >> bits) & 0xff);
    }
  }
  const d = digits || 6;
  const stepMs = (stepSeconds || 30) * 1000;
  let counter = Math.floor(nowMs / stepMs);
  const msg = new Array(8).fill(0);
  for (let i = 7; i >= 0; i--) {
    msg[i] = counter & 0xff;
    // Shift via division — the counter exceeds 32 bits in this decade, and
    // `>>= 8` would wrap it.
    counter = Math.floor(counter / 256);
  }
  const mac = hmacSha1(key, msg);
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const code = bin % Math.pow(10, d);
  return String(code).padStart(d, "0");
}
