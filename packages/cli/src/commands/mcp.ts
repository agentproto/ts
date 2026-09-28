/**
 * `agentproto mcp <verb>` — imported-MCP maintenance.
 *
 *   migrate-secrets [--apply]   Move literal header/env values in
 *                               ~/.agentproto/imported-mcps.json behind
 *                               keychain refs (`secretRefs`). Dry-run by
 *                               default (lists WHAT would move, key names
 *                               only, writes nothing). Never automatic.
 *
 * Safety (risk R1): per key the keychain write happens first and is
 * read-back verified; only then is the snapshot value replaced by the
 * `<secretRef>` marker, and the file is rewritten ONCE, atomically, at the
 * end. A failed key stays literal and is reported.
 */

import { KeychainStore } from "@agentproto/auth"
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

migrate-secrets lists the header/env values in imported-mcps.json that would
move to the OS keychain (names only; dry-run by default). --apply stores them,
verifies the read-back, then rewrites the file with secretRefs.
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

export async function runMcp(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") {
    process.stdout.write(USAGE)
    return 0
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
