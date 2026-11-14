import { describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverAdapterPackages } from "../discover.js"

/**
 * AIP-70 renamed "adapter" to "harness". Before any package rename,
 * discovery accepts BOTH prefixes additively: an `@agentproto/harness-<slug>`
 * package (or third-party `@<scope>/agentproto-harness-<slug>`) is found next
 * to the existing `adapter-` spelling, the bare `@agentproto/harness` package
 * (no dash suffix) is never matched, and on a same-slug collision the
 * canonical `harness-` name wins.
 */
describe("discoverAdapterPackages — harness- prefix alias", () => {
  it("finds harness-<slug> packages next to adapter-<slug>, ignores the bare harness package, and prefers the canonical harness- name on collisions", { timeout: 15_000 }, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "agentproto-discover-"))
    try {
      const nm = join(root, "node_modules")
      for (const name of [
        "@agentproto/harness-foo",
        "@agentproto/adapter-bar",
        "@agentproto/harness", // bare, must never match
        "@x/agentproto-harness-baz",
        "@agentproto/adapter-dup",
        "@agentproto/harness-dup",
      ]) {
        await fs.mkdir(join(nm, name, "dist"), { recursive: true })
        await fs.writeFile(
          join(nm, name, "package.json"),
          JSON.stringify({ name, version: "0.0.1", type: "module" })
        )
      }

      const found = await discoverAdapterPackages({ start: root })
      const slugs = found.map((a) => a.slug)

      expect(slugs).toContain("foo")
      expect(slugs).toContain("bar")
      expect(slugs).toContain("baz")
      expect(slugs).toContain("dup")
      expect(slugs).not.toContain("harness")

      expect(found.find((a) => a.slug === "foo")?.packageName).toBe(
        "@agentproto/harness-foo"
      )
      expect(found.find((a) => a.slug === "bar")?.packageName).toBe(
        "@agentproto/adapter-bar"
      )
      expect(found.find((a) => a.slug === "baz")?.packageName).toBe(
        "@x/agentproto-harness-baz"
      )
      // same slug under both prefixes: canonical harness- wins
      expect(found.find((a) => a.slug === "dup")?.packageName).toBe(
        "@agentproto/harness-dup"
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("first-party @agentproto wins over third-party even if third-party uses harness- and is seen later", { timeout: 15_000 }, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "agentproto-discover-cross-"))
    try {
      const nm = join(root, "node_modules")
      for (const name of [
        "@agentproto/adapter-dup",
        "@x/agentproto-harness-dup",
      ]) {
        await fs.mkdir(join(nm, name, "dist"), { recursive: true })
        await fs.writeFile(
          join(nm, name, "package.json"),
          JSON.stringify({ name, version: "0.0.1", type: "module" })
        )
      }

      const found = await discoverAdapterPackages({ start: root })
      expect(found.find((a) => a.slug === "dup")?.packageName).toBe(
        "@agentproto/adapter-dup"
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("third-party @x/agentproto-harness-<slug> cannot replace a first-party adapter, whichever order they are scanned", { timeout: 15_000 }, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "agentproto-discover-hijack-"))
    try {
      const nm = join(root, "node_modules")
      for (const name of [
        "@agentproto/adapter-dup2",
        "@x/agentproto-harness-dup2",
      ]) {
        await fs.mkdir(join(nm, name, "dist"), { recursive: true })
        await fs.writeFile(
          join(nm, name, "package.json"),
          JSON.stringify({ name, version: "0.0.1", type: "module" })
        )
      }

      const found = await discoverAdapterPackages({ start: root })
      expect(found.find((a) => a.slug === "dup2")?.packageName).toBe(
        "@agentproto/adapter-dup2"
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
