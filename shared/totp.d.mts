// Hand-written declarations for totp.mjs — see CLAUDE.md's shared/ rules.

export declare function base32Bytes(secret: string): number[] | null;

export declare function totpCode(
  hmacSha1: (keyBytes: number[], msgBytes: number[]) => number[],
  secret: string,
  nowMs: number,
  digits?: number,
  stepSeconds?: number,
): string | null;
