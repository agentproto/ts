/**
 * On-disk + adapter-carried role pack discovery — the fs half of the
 * role registry (the pure half — merge-with-builtins, resolution,
 * `canSpawn` — lives in `role.ts`).
 *
 * Two discovery paths, mirroring how #212 discovers skill packs
 * (`packages/cli/src/commands/skill-install/pack-resolve.ts`'s
 * `listSkills`: readdir + stat + frontmatter parse) and how the tunnel
 * family discovers third-party providers
 * (`remote-providers/registry.ts`'s `discoverTunnelHandles`: dynamic
 * `import()` + duck-typed export lookup) — reusing both established
 * patterns rather than inventing a third:
 *
 *   - standalone: `<dir>/roles/<slug>/ROLE.md`, one folder per custom
 *     role, same shape as a skill pack's `skills/<slug>/SKILL.md`.
 *   - adapter-carried: any package `discoverAdapterPackages()` finds
 *     (same `@agentproto/adapter-<slug>` / `@<scope>/agentproto-
 *     adapter-<slug>` convention agent-CLI adapters use) may declare
 *     `metadata.roles: string[]` — raw ROLE.md markdown, one entry per
 *     role. Embedding content directly (rather than a second relative-
 *     path fs lookup into the package's install dir) keeps this half
 *     testable without a real node_modules fixture and avoids a second
 *     package-root resolution step.
 *
 * Partial discovery beats failing the whole registry on one broken
 * pack or adapter declaration — a malformed entry is skipped, not
 * thrown (unlike `parseRolePack` called directly, which throws).
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

import { discoverAdapterPackages } from "@agentproto/provider-kit"

import { CONFIG_FILE_PATH, loadConfig } from "./config.js"
import { parseRolePack } from "./role-pack.js"
import type { RoleProfile } from "./role.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === "string")
}

/**
 * A role pack whose `toolPolicy.delegation` is `"allow"` at a level
 * above the operator's cap is forced to `"deny"` — the pack can still
 * declare its intent, but the daemon refuses to grant it. Undefined
 * cap ⇒ no restriction (back-compat: #214 had no such knob).
 */
function applyDelegationCap(
  role: RoleProfile,
  maxGrantableDelegation: number | undefined,
): RoleProfile {
  if (maxGrantableDelegation === undefined) return role
  if (role.toolPolicy.delegation !== "allow") return role
  if (role.level <= maxGrantableDelegation) return role
  return { ...role, toolPolicy: { delegation: "deny" } }
}

async function loadStandaloneRoles(
  rolesDir: string,
  out: Record<string, RoleProfile>,
  maxGrantableDelegation: number | undefined,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(rolesDir)
  } catch {
    return
  }
  for (const entry of entries) {
    const roleDir = join(rolesDir, entry)
    try {
      const st = await stat(roleDir)
      if (!st.isDirectory()) continue
    } catch {
      continue
    }
    try {
      const md = await readFile(join(roleDir, "ROLE.md"), "utf8")
      const role = applyDelegationCap(parseRolePack(md), maxGrantableDelegation)
      out[role.name] = role
    } catch {
      // Skip role packs whose ROLE.md can't be read/parsed — partial
      // discovery beats failing the whole registry on one bad pack.
    }
  }
}

export interface AdapterPackageRef {
  slug: string
  packageName: string
}

interface LoadAdapterCarriedRolesDeps {
  discover: () => Promise<readonly AdapterPackageRef[]>
  importPackage: (specifier: string) => Promise<unknown>
}

const slugToCamel = (slug: string): string =>
  slug.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())

async function loadAdapterCarriedRoles(
  out: Record<string, RoleProfile>,
  maxGrantableDelegation: number | undefined,
  deps: LoadAdapterCarriedRolesDeps,
): Promise<void> {
  const packages = await deps.discover()
  for (const pkg of packages) {
    let mod: unknown
    try {
      mod = await deps.importPackage(pkg.packageName)
    } catch {
      continue
    }
    if (!isRecord(mod)) continue
    const camel = slugToCamel(pkg.slug)
    const candidateRaw = mod[camel] ?? mod.default ?? mod.handle
    const candidate = isRecord(candidateRaw) ? candidateRaw : undefined
    const metadata = candidate && isRecord(candidate.metadata) ? candidate.metadata : undefined
    const roleDocs = metadata?.roles
    if (!isStringArray(roleDocs)) continue
    for (const doc of roleDocs) {
      try {
        const role = applyDelegationCap(parseRolePack(doc), maxGrantableDelegation)
        out[role.name] = role
      } catch {
        // Skip malformed role declarations — one adapter's bad
        // metadata must not take down the whole registry.
      }
    }
  }
}

export interface LoadRoleRegistryOptions {
  /** Cap on the level at which a pack may self-grant
   *  `toolPolicy.delegation: "allow"` — see `applyDelegationCap`.
   *  Undefined (default) ⇒ no cap. */
  maxGrantableDelegation?: number
  /** Injectable for tests — defaults to `discoverAdapterPackages` from
   *  `@agentproto/provider-kit`. */
  discoverAdapterPackages?: () => Promise<readonly AdapterPackageRef[]>
  /** Injectable for tests — defaults to real dynamic `import()`. */
  importPackage?: (specifier: string) => Promise<unknown>
}

/**
 * Load every custom (non-built-in) role reachable from `dir` — the
 * standalone `<dir>/roles/<slug>/ROLE.md` folders plus any installed
 * adapter package's `metadata.roles`. Returns a plain slug→profile map;
 * it does NOT merge in the two built-ins (`role.ts`'s
 * `mergeRoleRegistry` does that, uniformly, at every consumption site —
 * `resolveRole`, `listRoles`, `spawnableRolesFor` — so a pack can never
 * shadow `executor`/`supervisor` regardless of where the merged result
 * is used).
 */
export async function loadRoleRegistry(
  dir: string,
  opts?: LoadRoleRegistryOptions,
): Promise<Record<string, RoleProfile>> {
  const out: Record<string, RoleProfile> = {}
  await loadStandaloneRoles(join(dir, "roles"), out, opts?.maxGrantableDelegation)
  await loadAdapterCarriedRoles(out, opts?.maxGrantableDelegation, {
    discover: opts?.discoverAdapterPackages ?? discoverAdapterPackages,
    importPackage: opts?.importPackage ?? (specifier => import(specifier)),
  })
  return out
}

/**
 * The production default: `~/.agentproto/roles/` + adapter-carried
 * packs, capped by `config.json`'s `defaults.maxGrantableDelegation`.
 * Callers that need dependency injection (tests, or a host with its
 * own config source) should call `loadRoleRegistry` directly instead.
 */
export async function loadDefaultRoleRegistry(): Promise<Record<string, RoleProfile>> {
  const config = await loadConfig()
  return loadRoleRegistry(dirname(CONFIG_FILE_PATH()), {
    maxGrantableDelegation: config.defaults?.maxGrantableDelegation,
  })
}
