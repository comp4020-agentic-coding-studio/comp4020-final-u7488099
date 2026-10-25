import { describe, expect, it } from "vitest";
import { DEFAULT_SCRYPT_PARAMS, hashPassword, verifyPassword } from "../src/server/password.ts";

// Stage 11: password.ts is a pure module with no db.ts import (see its own
// top-of-file comment — kept that way specifically so db.ts's
// bootstrapAdminAccount() can use it without a circular import), so this
// file tests it by direct import rather than over HTTP, same "pure-function"
// exception simulation.test.ts already establishes for direct-module tests
// in this spec/ directory. No DB_PATH override needed: nothing here touches
// SQLite at all.

describe("hashPassword / verifyPassword", () => {
  it("round-trips: the same password verifies against its own hash", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password against a real hash", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password entirely", stored)).toBe(false);
  });

  it("never stores the password itself in the hash or salt fields", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored.hash).not.toContain("correct horse battery staple");
    expect(stored.salt).not.toContain("correct horse battery staple");
  });

  it("produces a different salt (and therefore a different hash) for the same password hashed twice", () => {
    const a = hashPassword("same password");
    const b = hashPassword("same password");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // ...but both still verify correctly against their own stored record.
    expect(verifyPassword("same password", a)).toBe(true);
    expect(verifyPassword("same password", b)).toBe(true);
  });

  it("records the scrypt cost params used, defaulting to DEFAULT_SCRYPT_PARAMS", () => {
    const stored = hashPassword("whatever");
    expect(stored.params).toEqual(DEFAULT_SCRYPT_PARAMS);
  });

  it("still verifies correctly against a hash produced with different (non-default) params", () => {
    // Stage 11's whole point of storing params per-row: a future cost change
    // must never invalidate an already-issued hash. Simulated here with a
    // deliberately smaller N so the test stays fast.
    const lighterParams = { n: 1024, r: 8, p: 1 };
    const stored = hashPassword("legacy-cost password", lighterParams);
    expect(verifyPassword("legacy-cost password", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("rejects an empty password candidate against a real hash, and vice versa", () => {
    const stored = hashPassword("a real password");
    expect(verifyPassword("", stored)).toBe(false);
    const emptyStored = hashPassword("");
    expect(verifyPassword("a real password", emptyStored)).toBe(false);
  });
});
