import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateIdentity } from "@agentproto/secrets/identity"
import { createPairingRegistry, type PairingHostRegistry } from "../index.js"

describe("local device credential", () => {
  let tmp: string
  let path: string
  let logs: string[]
  const registries: PairingHostRegistry[] = []

  const open = (): PairingHostRegistry => {
    const registry = createPairingRegistry({
      loadIdentity: async () => generateIdentity(),
      pairingsPath: path,
      dial: async () => {
        throw new Error("no rendezvous in this test")
      },
      serve: () => ({ close: async () => {} }),
      log: line => logs.push(line),
    })
    registries.push(registry)
    return registry
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pairing-host-local-"))
    path = join(tmp, "pairings.json")
    logs = []
  })
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.shutdown().catch(() => {})
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it("mints a device that verifies, lists, and is rejected on the very next verify after revoke", async () => {
    const registry = open()
    const cred = await registry.mintLocalDevice({ name: "claude-code@laptop" })
    expect(cred.bearer).toMatch(/^apd1\.[0-9a-f]{32}\.[A-Za-z0-9_-]+$/)

    expect(await registry.verifyDeviceBearer(cred.bearer)).toEqual({
      fingerprint: cred.fingerprint,
      name: "claude-code@laptop",
    })

    const listed = await registry.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ fingerprint: cred.fingerprint, name: "claude-code@laptop", local: true })
    expect(JSON.stringify(listed)).not.toContain(cred.bearer)

    expect(await registry.revoke("claude-code@laptop")).toBe(true)
    expect(await registry.verifyDeviceBearer(cred.bearer)).toBeNull()
    expect(await registry.list()).toHaveLength(0)
    expect(await registry.revoke(cred.fingerprint)).toBe(false)
  })

  it("rejects malformed, tampered, truncated and foreign bearers", async () => {
    const registry = open()
    const a = await registry.mintLocalDevice({ name: "a" })
    const b = await registry.mintLocalDevice({ name: "b" })
    const [prefix, fp, mac] = a.bearer.split(".") as [string, string, string]
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A")
    const foreignMac = b.bearer.split(".")[2] as string
    for (const bad of [
      "",
      "garbage",
      `${prefix}.${fp}`,
      `${prefix}.${fp}.`,
      `${prefix}.${fp}.${flipped}`,
      `${prefix}.${fp}.${mac.slice(0, 10)}`,
      `${prefix}.${fp}.${foreignMac}`,
      `${prefix}.${"0".repeat(32)}.${mac}`,
      `x.${fp}.${mac}`,
      `${a.bearer}.extra`,
    ]) {
      expect(await registry.verifyDeviceBearer(bad)).toBeNull()
    }
    expect(await registry.verifyDeviceBearer(a.bearer)).not.toBeNull()
  })

  it("survives a restart, and a revoke by another process takes effect on the next verify", async () => {
    const server = open()
    const cred = await server.mintLocalDevice({ name: "cursor" })

    // A second registry over the same file stands in for a CLI process.
    const cli = open()
    expect(await cli.verifyDeviceBearer(cred.bearer)).not.toBeNull()
    const other = await cli.mintLocalDevice({ name: "vscode" })

    // The long-lived "server" sees the CLI's mint without a restart...
    expect(await server.verifyDeviceBearer(other.bearer)).not.toBeNull()
    // ...and its own later write does not clobber it.
    await server.rename("cursor", "cursor-2")
    expect(await cli.verifyDeviceBearer(other.bearer)).not.toBeNull()

    expect(await cli.revoke("cursor-2")).toBe(true)
    expect(await server.verifyDeviceBearer(cred.bearer)).toBeNull()
    expect(await server.verifyDeviceBearer(other.bearer)).not.toBeNull()
  })

  it("keeps pairings.json v2, 0600, and loads files without the new field", async () => {
    await writeFile(path, JSON.stringify({ v: 2, pairings: [] }) + "\n", { mode: 0o600 })
    const registry = open()
    expect(await registry.list()).toEqual([])
    const cred = await registry.mintLocalDevice({ name: "d" })
    const file = JSON.parse(await readFile(path, "utf8"))
    expect(file.v).toBe(2)
    expect(file.pairings).toEqual([])
    expect(file.localDevices).toHaveLength(1)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    // The bearer itself is not stored; only the secret it derives from.
    expect(JSON.stringify(file)).not.toContain(cred.bearer)
  })

  it("rejects an empty name and never logs the bearer", async () => {
    const registry = open()
    await expect(registry.mintLocalDevice({ name: "  " })).rejects.toThrow(/name/)
    const cred = await registry.mintLocalDevice({ name: "quiet" })
    await registry.verifyDeviceBearer(cred.bearer)
    await registry.verifyDeviceBearer(cred.bearer.slice(0, -2))
    await registry.revoke("quiet")
    const secret = (cred.bearer.split(".")[2] ?? "").slice(0, 12)
    expect(logs.length).toBeGreaterThan(0)
    for (const line of logs) {
      expect(line).not.toContain(cred.bearer)
      expect(line).not.toContain(secret)
    }
  })
})
