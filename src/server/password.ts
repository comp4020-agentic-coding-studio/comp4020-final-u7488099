import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Stage 11: zero-dependency password hashing — no bcrypt/argon2 installed,
// and node:crypto's scrypt is a proven-safe primitive for this. Kept in its
// own module (no import of db.ts) so db.ts's bootstrapAdminAccount() can use
// it without a circular import against auth.ts, which also needs db.ts.
//
// N=16384/r=8/p=1/keylen=64 is sized for the 256MB Fly machine this app
// actually runs on (a desktop-class higher N risks OOM under a concurrent
// login burst) — not a generic "secure defaults" pick. Stored per-row
// (ScryptParams) rather than as a shared constant so a future change to
// these numbers never invalidates already-issued hashes.
export interface ScryptParams {
  n: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { n: 16384, r: 8, p: 1 };

const KEY_LENGTH = 64;

export interface PasswordHash {
  hash: string;
  salt: string;
  params: ScryptParams;
}

export function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): PasswordHash {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: params.n, r: params.r, p: params.p }).toString("hex");
  return { hash, salt, params };
}

// Always compares equal-length buffers with timingSafeEqual, never `===` —
// a plain string comparison on a hash leaks timing information about how
// many leading bytes matched. Returns false (not throw) on any mismatch,
// including a malformed/legacy hash that produces the wrong buffer length.
export function verifyPassword(password: string, stored: PasswordHash): boolean {
  const candidate = scryptSync(password, stored.salt, KEY_LENGTH, {
    N: stored.params.n,
    r: stored.params.r,
    p: stored.params.p,
  });
  const expected = Buffer.from(stored.hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}
