/**
 * Shared conformance suite for `CredentialStore` implementations.
 *
 * Every backend (`MemoryStore`, `FileStore`, …) must satisfy the same
 * read/write/delete contract regardless of how it persists data. Call
 * `runStoreContract` from a `*.test.ts` file, passing a factory that returns
 * a fresh store per test.
 */

import { describe, it, expect, beforeEach } from "vitest"
import type { CredentialStore } from "../types.js"

export function runStoreContract(
  makeStore: () => CredentialStore | Promise<CredentialStore>,
): void {
  let store: CredentialStore

  beforeEach(async () => {
    store = await makeStore()
  })

  it("returns undefined for a credential that was never written", async () => {
    await expect(
      store.read({ path: "svc", account: "acct" }),
    ).resolves.toBeUndefined()
  })

  it("round-trips a write through read", async () => {
    const ref = { path: "svc", account: "acct" }
    await store.write(ref, { value: "tok-1", kind: "pat" })
    await expect(store.read(ref)).resolves.toEqual({
      value: "tok-1",
      kind: "pat",
    })
  })

  it("overwrites an existing entry", async () => {
    const ref = { path: "svc", account: "acct" }
    await store.write(ref, { value: "tok-1", kind: "pat" })
    await store.write(ref, { value: "tok-2", kind: "pat" })
    await expect(store.read(ref)).resolves.toEqual({
      value: "tok-2",
      kind: "pat",
    })
  })

  it("round-trips expiresAt and metadata", async () => {
    const ref = { path: "svc", account: "acct" }
    await store.write(ref, {
      value: "assert-jwt",
      kind: "assertion",
      expiresAt: "2026-01-01T00:00:00.000Z",
      metadata: { rotated: true, attempt: 2 },
    })
    await expect(store.read(ref)).resolves.toEqual({
      value: "assert-jwt",
      kind: "assertion",
      expiresAt: "2026-01-01T00:00:00.000Z",
      metadata: { rotated: true, attempt: 2 },
    })
  })

  it("keeps distinct refs independent", async () => {
    const a = { path: "svc-a", account: "acct" }
    const b = { path: "svc-b", account: "acct" }
    await store.write(a, { value: "tok-a", kind: "pat" })
    await expect(store.read(b)).resolves.toBeUndefined()
    await expect(store.read(a)).resolves.toEqual({ value: "tok-a", kind: "pat" })
  })

  describe("delete", () => {
    it("removes a written entry, making read return undefined", async () => {
      const ref = { path: "svc", account: "acct" }
      await store.write(ref, { value: "tok-1", kind: "pat" })
      if (!store.delete) return // backend doesn't support deletion
      await store.delete(ref)
      await expect(store.read(ref)).resolves.toBeUndefined()
    })

    it("is a no-op when the entry never existed", async () => {
      const ref = { path: "svc", account: "acct" }
      if (!store.delete) return
      await expect(store.delete(ref)).resolves.toBeUndefined()
    })
  })
}
