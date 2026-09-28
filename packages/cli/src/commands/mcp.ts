/**
 * `agentproto mcp <verb>` — imported-MCP maintenance.
 *
 *   migrate-secrets [--apply]   Move literal header/env values in
 *                               ~/.agentproto/imported-mcps.json behind
 *                               keychain refs (`secretRefs`). Dry-run by
 *                               default (lists WHAT would move, key names
 *                               only, writes nothing). Never automatic.
 *
 *   mount-default <adapter> <importId…>
 *                               Mount imported MCPs NATIVELY (a real mcpServers
 *                               entry) in every spawn of <adapter>: creates or
 *                               extends bundle `harness-<adapter>` and lists it
 *                               in defaults.adapters.<adapter>.bundles. Never
 *                               enabled by default; ids must already be imported.
 *
 * Safety (risk R1): per key the keychain write happens first and is
 * read-back verified; only then is the snapshot value replaced by the
 * `<secretRef>` marker, and the file is rewritten ONCE, atomically, at the
 * end. A failed key stays literal and is reported.
 */

import { KeychainStore } from "@agentproto/auth"
import { createBundle, getBundle, updateBundle, type Bundle } from "@agentproto/runtime/bundles"
import { loadConfig, saveConfig, type AgentprotoConfig } from "@agentproto/runtime/config"
import {
  isLiteralSecretValue,
  loadImportedMcps,
  moveEntrySecrets,
  saveImportedMcps,
  type ImportedMcpsConfig,
} from "@agentproto/runtime/mcp-imports"

const USAGE = `agentproto mcp — imported-MCP maintenance

Usage:
  agentproto mcp migrate-secrets [--apply]
  agentproto mcp mount-default <adapter> <importId...>

migrate-secrets lists the header/env values in imported-mcps.json that would
move to the OS keychain (names only; dry-run by default). --apply stores them,
verifies the read-back, then rewrites the file with secretRefs.

mount-default makes every future <adapter> spawn mount the given imported MCPs
as native MCP servers (bundle harness-<adapter> in defaults.adapters.<adapter>.
bundles). Repeat to add more ids. Opt-in per adapter; nothing is mounted by
default.
`

export interface MigrateSecretsDeps {
  load: () => Promise<ImportedMcpsConfig>
  save: (c: ImportedMcpsConfig) => Promise<void>
  storeMcpSecret?: (ref: string, value: string) => Promise<void>
  resolveMcpSecret?: (ref: string) => Promise<string | undefined>
}

export interface MigrateSecretsReport {
  /** `<alias>: headers.Authorization, env.X` lines (key names only). */
  lines: string[]
  moved: number
  warnings: string[]
  applied: boolean
}

/** Pure-ish core (injected store/file) so tests never touch the real home. */
export async function migrateSecrets(
  apply: boolean,
  deps: MigrateSecretsDeps
): Promise<MigrateSecretsReport> {
  const config = await deps.load()
  const lines: string[] = []
  const warnings: string[] = []
  let moved = 0
  const nextImports = []
  for (const entry of config.imports) {
    const keys = [
      ...Object.entries(entry.snapshot.headers ?? {})
        .filter(([, v]) => isLiteralSecretValue(v))
        .map(([k]) => `headers.${k}`),
      ...Object.entries(entry.snapshot.env ?? {})
        .filter(([, v]) => isLiteralSecretValue(v))
        .map(([k]) => `env.${k}`),
    ]
    if (keys.length === 0) {
      nextImports.push(entry)
      continue
    }
    lines.push(`${entry.alias}: ${keys.join(", ")}`)
    if (!apply) {
      nextImports.push(entry)
      continue
    }
    if (!deps.storeMcpSecret) {
      warnings.push(`${entry.alias}: no secret store available`)
      nextImports.push(entry)
      continue
    }
    const r = await moveEntrySecrets(entry, {
      storeMcpSecret: deps.storeMcpSecret,
      ...(deps.resolveMcpSecret ? { resolveMcpSecret: deps.resolveMcpSecret } : {}),
    })
    moved += r.moved.length
    warnings.push(...r.warnings.map(w => `${entry.alias}: ${w}`))
    nextImports.push(r.entry)
  }
  if (apply && moved > 0) await deps.save({ ...config, imports: nextImports })
  return { lines, moved, warnings, applied: apply && moved > 0 }
}

export interface MountDefaultDeps {
  loadImports: () => Promise<ImportedMcpsConfig>
  getBundle: (id: string) => Promise<Bundle | undefined>
  createBundle: (b: Bundle) => Promise<unknown>
  updateBundle: (id: string, patch: Partial<Omit<Bundle, "id">>) => Promise<unknown>
  loadConfig: () => Promise<AgentprotoConfig>
  saveConfig: (c: AgentprotoConfig) => Promise<void>
}

export interface MountDefaultReport {
  bundleId: string
  /** `created` = new bundle, `updated` = ids added, `unchanged` = nothing new. */
  bundle: "created" | "updated" | "unchanged"
  added: string[]
  /** True when the bundle was appended to the adapter's default bundles. */
  linked: boolean
  /** Final imports of the bundle (`"*"` when a wildcard bundle already existed). */
  mcpImports: string[] | "*"
}

const ADAPTER_SLUG = /^[a-z0-9][a-z0-9-]*$/

/** Core of `mcp mount-default` — injected stores so tests never touch the
 *  real home. Throws `Error` with a user-facing message on bad input. */
export async function mountDefault(
  adapter: string,
  ids: readonly string[],
  deps: MountDefaultDeps
): Promise<MountDefaultReport> {
  if (!ADAPTER_SLUG.test(adapter)) {
    throw new Error(`invalid adapter slug '${adapter}' (lowercase kebab-case expected)`)
  }
  if (ids.length === 0) throw new Error("at least one import id is required")
  const imported = await deps.loadImports()
  const valid = new Set(imported.imports.map(e => e.id))
  const unknown = ids.filter(id => !valid.has(id))
  if (unknown.length > 0) {
    throw new Error(
      `unknown import id(s): ${unknown.join(", ")}. Valid ids: ${[...valid].join(", ") || "(none imported — run mcp_import first)"}`
    )
  }
  const bundleId = `harness-${adapter}`
  const existing = await deps.getBundle(bundleId)
  let bundle: MountDefaultReport["bundle"]
  let added: string[]
  let mcpImports: string[] | "*"
  if (!existing) {
    added = [...new Set(ids)]
    mcpImports = added
    await deps.createBundle({
      id: bundleId,
      label: `Default MCP mounts for ${adapter}`,
      description: `Native imported-MCP mounts for every ${adapter} spawn (managed by \`agentproto mcp mount-default\`).`,
      mcpImports,
      skills: [],
    })
    bundle = "created"
  } else if (existing.mcpImports === "*") {
    added = []
    mcpImports = "*"
    bundle = "unchanged"
  } else {
    const have = new Set(existing.mcpImports)
    added = [...new Set(ids)].filter(id => !have.has(id))
    mcpImports = [...existing.mcpImports, ...added]
    if (added.length > 0) await deps.updateBundle(bundleId, { mcpImports })
    bundle = added.length > 0 ? "updated" : "unchanged"
  }
  const config = await deps.loadConfig()
  const adapters = config.defaults?.adapters ?? {}
  const current = adapters[adapter]?.bundles ?? []
  let linked = false
  if (!current.includes(bundleId)) {
    await deps.saveConfig({
      ...config,
      defaults: {
        ...config.defaults,
        adapters: { ...adapters, [adapter]: { ...adapters[adapter], bundles: [...current, bundleId] } },
      },
    })
    linked = true
  }
  return { bundleId, bundle, added, linked, mcpImports }
}

export async function runMcp(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") {
    process.stdout.write(USAGE)
    return 0
  }
  if (verb === "mount-default") {
    const [adapter, ...ids] = rest
    if (!adapter || ids.length === 0 || [adapter, ...ids].some(a => a.startsWith("-"))) {
      process.stderr.write(`usage: agentproto mcp mount-default <adapter> <importId...>\n`)
      return 2
    }
    try {
      const r = await mountDefault(adapter, ids, {
        loadImports: () => loadImportedMcps(),
        getBundle,
        createBundle,
        updateBundle,
        loadConfig: () => loadConfig(),
        saveConfig: c => saveConfig(c),
      })
      process.stdout.write(
        `bundle ${r.bundleId}: ${r.bundle}${r.added.length ? ` (+${r.added.join(", ")})` : ""}\n` +
          `defaults.adapters.${adapter}.bundles: ${r.linked ? "linked" : "already linked"}\n` +
          "New '" + adapter + "' spawns mount these natively; running sessions are unchanged.\n"
      )
      return 0
    } catch (err) {
      process.stderr.write(`agentproto mcp mount-default: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }
  if (verb !== "migrate-secrets") {
    process.stderr.write(`agentproto mcp: unknown subcommand '${verb}'\n\n${USAGE}`)
    return 2
  }
  const apply = rest.includes("--apply")
  const unknown = rest.filter(a => a !== "--apply")
  if (unknown.length > 0) {
    process.stderr.write(`agentproto mcp migrate-secrets: unexpected argument '${unknown[0]}'\n`)
    return 2
  }
  const store = new KeychainStore()
  const split = (ref: string): { path: string; account: string } => {
    const i = ref.lastIndexOf("#")
    return i < 0 ? { path: ref, account: ref } : { path: ref.slice(0, i), account: ref.slice(i + 1) }
  }
  const report = await migrateSecrets(apply, {
    load: () => loadImportedMcps(),
    save: c => saveImportedMcps(c),
    storeMcpSecret: async (ref, value) => {
      await store.write(split(ref), { value, kind: "pat" })
    },
    resolveMcpSecret: async ref => (await store.read(split(ref)))?.value,
  })
  if (report.lines.length === 0) {
    process.stdout.write("No literal header/env values to move.\n")
    return 0
  }
  process.stdout.write(
    `${apply ? "Moved to keychain" : "Would move to keychain (dry run — nothing written; pass --apply)"}:\n` +
      report.lines.map(l => `  ${l}\n`).join("")
  )
  for (const w of report.warnings) process.stderr.write(`warning: ${w}\n`)
  if (apply) process.stdout.write(`${report.moved} value(s) moved.\n`)
  return report.warnings.length > 0 && apply ? 1 : 0
}
