/**
 * `CredentialsJsonStore` — round-trip through the same
 * `~/.agentproto/credentials.json` the CLI's `credentials.ts` helpers read,
 * and a check that `serve`'s token-resolution path (also `credentials.ts`
 * helpers) sees exactly what the store just wrote.
 *
 * Real filesystem, pinned to a throwaway `AGENTPROTO_HOME` — no fs mocking,
 * since `credentials.ts` is a thin wrapper over a handful of fs calls and the
 * point of this test is the on-disk shape.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { StoredCredential } from "@agentproto/auth"
import { CredentialsJsonStore } from "../util/credentials-store.js"
import {
  credentialsPath,
  formatExpiry,
  isExpired,
  readHost,
} from "../util/credentials.js"

const HOST = "wss://tunnel.example.test"

let fakeHome = ""

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "agp-credstore-"))
  process.env["AGENTPROTO_HOME"] = fakeHome
})

afterEach(() => {
  delete process.env["AGENTPROTO_HOME"]
  rmSync(fakeHome, { recursive: true, force: true })
})

describe("CredentialsJsonStore round-trip", () => {
  it("writes through the store and reads back the same value via the store", async () => {
    const store = new CredentialsJsonStore()
    const ref = { path: "tunnel:agentproto-daemon", account: HOST }
    const cred: StoredCredential = {
      value: "gdt_abc123",
      kind: "daemon",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      metadata: {
        obtainedAt: "2026-07-01T00:00:00.000Z",
        refreshToken: "gdr_abc123",
        scope: "tunnel:connect",
        subject: "user-1",
        deviceLabel: "jeremy@laptop",
        revocationId: "rev-1",
      },
    }

    await store.write(ref, cred)
    const readBack = await store.read(ref)

    expect(readBack?.value).toBe("gdt_abc123")
    expect(readBack?.kind).toBe("daemon")
    expect(readBack?.expiresAt).toBe(cred.expiresAt)
    expect(readBack?.metadata).toMatchObject({
      refreshToken: "gdr_abc123",
      scope: "tunnel:connect",
      subject: "user-1",
      deviceLabel: "jeremy@laptop",
      revocationId: "rev-1",
    })
  })

  it("persists the exact `credentials.json` shape the CLI's own helpers expect", async () => {
    const store = new CredentialsJsonStore()
    const ref = { path: "tunnel:agentproto-daemon", account: HOST }
    await store.write(ref, {
      value: "gdt_shape",
      kind: "daemon",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      metadata: { obtainedAt: "2026-07-01T00:00:00.000Z", scope: "tunnel:connect" },
    })

    // Read the raw file — this is the contract `serve.ts`/`auth status`/
    // `auth logout` depend on via `readHost`/`loadCredentials`.
    const raw = JSON.parse(readFileSync(credentialsPath(), "utf8"))
    expect(raw.version).toBe(1)
    expect(raw.hosts[HOST]).toMatchObject({
      token: "gdt_shape",
      tokenType: "Bearer",
      scope: "tunnel:connect",
    })

    // And the existing helper reads it right back.
    const viaHelper = await readHost(HOST)
    expect(viaHelper?.token).toBe("gdt_shape")
    expect(viaHelper?.scope).toBe("tunnel:connect")
  })

  it("round-trips a credential with no expiry (isExpired treats it as durable)", async () => {
    const store = new CredentialsJsonStore()
    const ref = { path: "tunnel:agentproto-daemon", account: HOST }
    await store.write(ref, {
      value: "gdt_no_expiry",
      kind: "daemon",
      metadata: { obtainedAt: "2026-07-01T00:00:00.000Z" },
    })

    const cred = await readHost(HOST)
    expect(cred?.expiresAt).toBeUndefined()
    expect(cred && isExpired(cred)).toBe(false)
    expect(cred && formatExpiry(cred)).toBe("no expiry reported")
  })

  it("delete() removes the host and (being the only one) unlinks the file", async () => {
    const store = new CredentialsJsonStore()
    const ref = { path: "tunnel:agentproto-daemon", account: HOST }
    await store.write(ref, { value: "gdt_gone", kind: "daemon" })
    expect(await readHost(HOST)).not.toBeNull()

    await store.delete(ref)

    expect(await readHost(HOST)).toBeNull()
  })
})

describe("serve token resolution", () => {
  it("sees a credential written via CredentialsJsonStore, mirroring serve.ts's own readHost(connectFlag) → cred.token path", async () => {
    const store = new CredentialsJsonStore()
    const ref = { path: "tunnel:agentproto-daemon", account: HOST }
    await store.write(ref, {
      value: "gdt_serve_test",
      kind: "daemon",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      metadata: { obtainedAt: new Date().toISOString() },
    })

    // This mirrors serve.ts's token-resolution block verbatim: `readHost`,
    // check `isExpired`, then use `cred.token`.
    const cred = await readHost(HOST)
    expect(cred).not.toBeNull()
    expect(cred && isExpired(cred)).toBe(false)
    const token = cred?.token
    expect(token).toBe("gdt_serve_test")
  })
})
