/**
 * Unit coverage for `loadRoleRegistry` (role-registry.ts) — the fs half
 * of the role registry: standalone `<dir>/roles/<slug>/ROLE.md` packs
 * (mirrors #212's `listSkills` shape) and adapter-carried packs
 * (`metadata.roles`, discovered via an injected
 * `discoverAdapterPackages` + `importPackage`, mirroring
 * `remote-providers/registry.ts`'s duck-typed third-party import).
 *
 * `resolveRole`/`mergeRoleRegistry` (role.ts) own "built-ins always
 * win a collision" — see role.test.ts. This file only covers
 * discovery + parsing + the `maxGrantableDelegation` cap.
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRoleRegistry } from "../role-registry.js"

async function makeRoleFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentproto-role-registry-test-"))
}

async function writeRolePack(
  rootDir: string,
  slug: string,
  fields: Record<string, string>,
  body: string,
): Promise<void> {
  const dir = join(rootDir, "roles", slug)
  await mkdir(dir, { recursive: true })
  const frontmatter = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  await writeFile(join(dir, "ROLE.md"), `---\n${frontmatter}\n---\n${body}`, "utf8")
}

describe("loadRoleRegistry — standalone roles/ dir", () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
  })

  it("returns {} when there's no roles/ dir at all", async () => {
    const root = await makeRoleFixtureDir()
    dirs.push(root)
    expect(await loadRoleRegistry(root)).toEqual({})
  })

  it("loads a valid role pack from <dir>/roles/<slug>/ROLE.md", async () => {
    const root = await makeRoleFixtureDir()
    dirs.push(root)
    await writeRolePack(
      root,
      "reviewer",
      { role: "reviewer", level: "50", "toolPolicy.delegation": "deny" },
      "You review code.",
    )
    const registry = await loadRoleRegistry(root)
    expect(registry.reviewer).toEqual({
      name: "reviewer",
      disposition: "You review code.",
      toolPolicy: { delegation: "deny" },
      level: 50,
    })
  })

  it("skips a malformed pack (partial discovery) without throwing", async () => {
    const root = await makeRoleFixtureDir()
    dirs.push(root)
    await writeRolePack(root, "broken", { role: "broken" }, "missing level + delegation")
    await writeRolePack(
      root,
      "reviewer",
      { role: "reviewer", level: "50", "toolPolicy.delegation": "deny" },
      "You review code.",
    )
    const registry = await loadRoleRegistry(root)
    expect(Object.keys(registry)).toEqual(["reviewer"])
  })

  it("caps a self-granted 'allow' above maxGrantableDelegation down to 'deny'", async () => {
    const root = await makeRoleFixtureDir()
    dirs.push(root)
    await writeRolePack(
      root,
      "planner",
      { role: "planner", level: "50", "toolPolicy.delegation": "allow" },
      "You plan.",
    )
    const capped = await loadRoleRegistry(root, { maxGrantableDelegation: 40 })
    expect(capped.planner?.toolPolicy.delegation).toBe("deny")

    const uncapped = await loadRoleRegistry(root, { maxGrantableDelegation: 50 })
    expect(uncapped.planner?.toolPolicy.delegation).toBe("allow")

    const noCap = await loadRoleRegistry(root)
    expect(noCap.planner?.toolPolicy.delegation).toBe("allow")
  })
})

describe("loadRoleRegistry — adapter-carried roles (metadata.roles)", () => {
  it("loads ROLE.md content declared on an adapter package's metadata.roles", async () => {
    const root = await makeRoleFixtureDir()
    const rolePackMd =
      "---\nrole: planner\nlevel: 50\ntoolPolicy.delegation: allow\n---\nYou plan work."
    const registry = await loadRoleRegistry(root, {
      discoverAdapterPackages: async () => [{ slug: "aider", packageName: "@agentproto/adapter-aider" }],
      importPackage: async () => ({
        aider: { name: "aider", metadata: { roles: [rolePackMd] } },
      }),
    })
    expect(registry.planner).toEqual({
      name: "planner",
      disposition: "You plan work.",
      toolPolicy: { delegation: "allow" },
      level: 50,
    })
    await rm(root, { recursive: true, force: true })
  })

  it("skips adapters that don't declare metadata.roles", async () => {
    const root = await makeRoleFixtureDir()
    const registry = await loadRoleRegistry(root, {
      discoverAdapterPackages: async () => [{ slug: "aider", packageName: "@agentproto/adapter-aider" }],
      importPackage: async () => ({ aider: { name: "aider" } }),
    })
    expect(registry).toEqual({})
    await rm(root, { recursive: true, force: true })
  })

  it("skips a package that fails to import — partial discovery", async () => {
    const root = await makeRoleFixtureDir()
    const registry = await loadRoleRegistry(root, {
      discoverAdapterPackages: async () => [{ slug: "broken", packageName: "@agentproto/adapter-broken" }],
      importPackage: async () => {
        throw new Error("not installed")
      },
    })
    expect(registry).toEqual({})
    await rm(root, { recursive: true, force: true })
  })

  it("applies the same maxGrantableDelegation cap to adapter-carried roles", async () => {
    const root = await makeRoleFixtureDir()
    const rolePackMd =
      "---\nrole: planner\nlevel: 50\ntoolPolicy.delegation: allow\n---\nYou plan work."
    const registry = await loadRoleRegistry(root, {
      maxGrantableDelegation: 10,
      discoverAdapterPackages: async () => [{ slug: "aider", packageName: "@agentproto/adapter-aider" }],
      importPackage: async () => ({
        aider: { name: "aider", metadata: { roles: [rolePackMd] } },
      }),
    })
    expect(registry.planner?.toolPolicy.delegation).toBe("deny")
    await rm(root, { recursive: true, force: true })
  })
})
