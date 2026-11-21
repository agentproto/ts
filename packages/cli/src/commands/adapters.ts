/**
 * `agentproto adapters <subverb>` — manage runtime adapters.
 *
 *   adapters list                  Show enabled adapters + what they provide
 *   adapters show <pkg>            Print an adapter's manifest summary
 *   adapters outdated              Read-only freshness report: installed
 *                                  adapter-package version vs latest published
 *   adapters install <pkg>         `npm i -g <pkg>` + add to config
 *   adapters uninstall <pkg>       Remove from config (+ optional npm rm)
 *   adapters enable <pkg>          Add to config (assumes installed)
 *   adapters disable <pkg>         Remove from config (keep installed)
 *
 * Adapter list lives in `~/.agentproto/config.json`:
 *
 *   { "adapters": ["@guilde/agentproto-bridge", "@acme/agentproto-slack"] }
 *
 * Adapters are loaded by `agentproto run-swarm` in the order they
 * appear. Last one to register a `kind` wins — useful for overriding
 * a built-in or another adapter.
 */

import { spawn } from "node:child_process"
import { parseArgs } from "node:util"
import {
  MAX_HERMES_SYSTEM_PROMPT_CHARS,
  hermesSystemPromptPluginStatus,
  installHermesSystemPromptPlugin,
} from "@agentproto/adapter-hermes"
import {
  readAdapterManifest,
  readAdapterPackageInfo,
} from "../registry/manifest-loader.js"
import type {
  AdapterEntry,
  AdapterManifest,
  SubstrateEntry,
} from "../registry/manifest.js"
import {
  addAdapterToConfig,
  loadAgentprotoConfig,
  removeAdapterFromConfig,
} from "../util/agentproto-config.js"
import { withNpmGlobalPrefix } from "../util/npm-prefix.js"

const FIRST_PARTY_ADAPTER_PKG_RE =
  /^@agentproto\/(?:adapter|harness)-([a-z][a-z0-9-]*)$/
const BARE_SLUG_RE = /^[a-z][a-z0-9-]*$/

/**
 * Derive an AIP-45 adapter slug from either a bare slug (`antigravity`) or a
 * first-party package name (`@agentproto/adapter-antigravity`,
 * `@agentproto/harness-antigravity`). Returns `null` for third-party packages
 * or non-slug specifiers.
 */
export function extractAdapterSlug(target: string): string | null {
  const pkgMatch = FIRST_PARTY_ADAPTER_PKG_RE.exec(target)
  if (pkgMatch) return pkgMatch[1]!
  if (BARE_SLUG_RE.test(target)) return target
  return null
}

function isConfiguredAdapter(
  configured: readonly string[],
  candidates: ReadonlyArray<string | undefined>
): boolean {
  return candidates.some((c) => typeof c === "string" && configured.includes(c))
}

const USAGE = `agentproto adapters — manage runtime adapters

Usage:
  agentproto adapters list                  Show enabled + installed adapters [--json]
  agentproto adapters show <pkg|slug>       Print an adapter's manifest or handle [--json]
  agentproto adapters outdated              Installed adapter version vs latest
                                            published on npm [--json] (read-only)
  agentproto adapters install <pkg>         npm i -g + add to config
                                            [--local] [--skip-npm]
  agentproto adapters uninstall <pkg>       Remove from config (+ npm rm)
                                            [--local] [--skip-npm]
  agentproto adapters enable <pkg>          Add to config (assume installed)
  agentproto adapters disable <pkg>         Remove from config (keep installed)
  agentproto adapters hermes-plugin status  hermes system-prompt plugin state [--json]
  agentproto adapters hermes-plugin install Copy the bundled plugin into
                                            $HERMES_HOME/plugins [--enable] [--json]
  agentproto adapters --help

  --local     install/uninstall into the local node_modules instead of -g
  --skip-npm  skip the npm install/remove; only touch the config entry

hermes-plugin manages the agentproto-system-prompt hermes plugin — the
channel that gives hermes a REAL system-prompt delivery path (hermes' ACP
server has none of its own). Without it, system-prompt text falls back to a
first-prompt prefix plus a harness warning. --enable is an explicit consent:
it runs \`hermes plugins enable agentproto-system-prompt\` (config.yaml is
never edited by hand). Delivery budget: ${MAX_HERMES_SYSTEM_PROMPT_CHARS} chars.

Adapter list lives in ~/.agentproto/config.json under \`adapters[]\`.
`

export async function runAdapters(args: readonly string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case undefined:
    case "-h":
    case "--help":
      process.stdout.write(USAGE)
      return 0
    case "list":
      return runList(rest)
    case "outdated":
      return runOutdated(rest)
    case "show":
      return runShow(rest)
    case "install":
      return runInstall(rest)
    case "uninstall":
      return runUninstall(rest)
    case "enable":
      return runEnable(rest)
    case "disable":
      return runDisable(rest)
    case "hermes-plugin":
      return runHermesPlugin(rest)
    default:
      process.stderr.write(
        `agentproto adapters: unknown subcommand '${sub}'.\n\n${USAGE}`
      )
      return 2
  }
}

// ── list ──────────────────────────────────────────────────────────────

interface AdapterListEntry {
  id: string
  manifest: AdapterManifest | null
  kind?: "manifest" | "agent-cli" | "legacy" | "missing"
  slug?: string
  version?: string
  protocol?: string
  source?: string
  enabled: boolean
  installed: boolean
  error?: string
}

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { json: { type: "boolean" } },
    strict: true,
  })
  const cfg = await loadAgentprotoConfig()
  const configured = cfg.adapters ?? []

  const { listInstalledAdapters, resolveAdapter } = await import(
    "../registry/resolve.js"
  )
  let discovered: Awaited<ReturnType<typeof listInstalledAdapters>> = []
  try {
    discovered = await listInstalledAdapters()
  } catch {
    // Non-fatal: still report configured adapters if discovery fails.
  }

  const discoveredByPkg = new Map(discovered.map((d) => [d.packageName, d]))
  const discoveredBySlug = new Map(discovered.map((d) => [d.slug, d]))
  const coveredSlugs = new Set<string>()
  const coveredPkgs = new Set<string>()

  const entries: AdapterListEntry[] = []

  for (const id of configured) {
    coveredPkgs.add(id)
    const slug = extractAdapterSlug(id)
    try {
      const result = await readAdapterManifest(id)
      if (result) {
        if (slug) coveredSlugs.add(slug)
        entries.push({
          id,
          manifest: result.manifest,
          kind: "manifest",
          enabled: true,
          installed: true,
        })
        continue
      }
    } catch (err) {
      if (slug) coveredSlugs.add(slug)
      entries.push({
        id,
        manifest: null,
        enabled: true,
        installed: true,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    // No agentproto/adapter/v1 runtime manifest — check whether this is an
    // AIP-45 agent-CLI adapter (installed package or generic ACP entry)
    // before falling back to legacy side-effect package inspection.
    const found =
      discoveredByPkg.get(id) ?? (slug ? discoveredBySlug.get(slug) : undefined)
    if (found) {
      coveredSlugs.add(found.slug)
      coveredPkgs.add(found.packageName)
      entries.push({
        id,
        manifest: null,
        kind: "agent-cli",
        slug: found.slug,
        version: found.packageVersion ?? found.version,
        protocol: found.protocol,
        enabled: true,
        installed: true,
      })
      continue
    }

    if (slug) {
      try {
        const resolved = await resolveAdapter(slug)
        const handle = resolved.handle as Record<string, unknown>
        const version =
          resolved.packageVersion ??
          (typeof handle.version === "string" ? handle.version : undefined)
        const protocol =
          typeof handle.protocol === "string" ? handle.protocol : "unknown"
        coveredSlugs.add(resolved.slug)
        if (resolved.packageName) coveredPkgs.add(resolved.packageName)
        entries.push({
          id,
          manifest: null,
          kind: "agent-cli",
          slug: resolved.slug,
          ...(version ? { version } : {}),
          protocol,
          source: resolved.source,
          enabled: true,
          installed: true,
        })
        continue
      } catch {
        // Not resolvable as an agent-CLI adapter — fall through to package check.
      }
    }

    const pkgInfo = await readAdapterPackageInfo(id)
    if (pkgInfo) {
      entries.push({
        id,
        manifest: null,
        kind: "legacy",
        ...(pkgInfo.version ? { version: pkgInfo.version } : {}),
        enabled: true,
        installed: true,
      })
    } else {
      entries.push({
        id,
        manifest: null,
        kind: "missing",
        enabled: true,
        installed: false,
      })
    }
  }

  for (const info of discovered) {
    if (coveredSlugs.has(info.slug) || coveredPkgs.has(info.packageName)) {
      continue
    }
    coveredSlugs.add(info.slug)
    coveredPkgs.add(info.packageName)
    entries.push({
      id: info.packageName,
      manifest: null,
      kind: "agent-cli",
      slug: info.slug,
      version: info.packageVersion ?? info.version,
      protocol: info.protocol,
      enabled: false,
      installed: true,
    })
  }

  if (entries.length === 0) {
    if (values.json) process.stdout.write("[]\n")
    else
      process.stdout.write(
        "agentproto adapters: no adapters installed or enabled. Try `agentproto adapters install <pkg>`.\n"
      )
    return 0
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
    return 0
  }

  for (const e of entries) {
    process.stdout.write(`• ${e.id}\n`)
    if (e.error) {
      process.stdout.write(`    error: ${e.error}\n`)
      continue
    }
    if (e.manifest) {
      printAdapterSummary("substrates", e.manifest.substrates)
      printAdapterSummary("dispatchers", e.manifest.dispatchers)
      printAdapterSummary("executors", e.manifest.executors)
      printAdapterSummary("state stores", e.manifest.stateStores)
      continue
    }
    if (e.kind === "agent-cli") {
      const meta = [
        e.protocol,
        e.version ? `v${e.version}` : undefined,
        e.source,
      ]
        .filter(Boolean)
        .join(", ")
      const scopeNote = e.enabled ? "" : " [installed, not in config]"
      process.stdout.write(
        `    agent-cli: ${e.slug}${meta ? ` (${meta})` : ""}${scopeNote}\n`
      )
      continue
    }
    if (e.kind === "missing") {
      process.stdout.write(
        `    (enabled in config, but not installed / unresolvable)\n`
      )
      continue
    }
    const ver = e.version ? `, v${e.version}` : ""
    process.stdout.write(
      `    (no manifest — legacy side-effect adapter${ver})\n`
    )
  }
  return 0
}

function printAdapterSummary(
  label: string,
  entries: ReadonlyArray<AdapterEntry | SubstrateEntry>
): void {
  if (entries.length === 0) return
  const kinds = entries.map((e) => e.kind).join(", ")
  process.stdout.write(`    ${label}: ${kinds}\n`)
}

// ── outdated ──────────────────────────────────────────────────────────

/**
 * Read-only freshness report for the installed agent-CLI adapter packages:
 * installed version (from the resolved local package.json, falling back to
 * the global-npm tree) vs latest published (`npm view` — the registry query
 * the presence fix relocated out of the manifests; here it is answering the
 * question it was always right for).
 *
 * Bounded, read-only, writes nothing: no installs, no config, no
 * `~/.agentproto`. Each probe degrades to `null` on failure → the row
 * reports "unknown" rather than guessing, and the verb still exits 0.
 */
async function runOutdated(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { json: { type: "boolean" } },
    strict: true,
  })

  const { listInstalledAdapters } = await import("../registry/resolve.js")
  const { npmLatestVersion, npmInstalledVersion, freshnessVerdict } =
    await import("../registry/freshness.js")

  let installed
  try {
    installed = await listInstalledAdapters()
  } catch (err) {
    process.stderr.write(
      `agentproto adapters outdated: could not enumerate installed adapters: ` +
        `${err instanceof Error ? err.message : String(err)}\n`
    )
    return 1
  }

  const rows = await Promise.all(
    installed.map(async (info) => {
      const [have, latest] = await Promise.all([
        info.packageVersion !== undefined
          ? Promise.resolve(info.packageVersion)
          : npmInstalledVersion(info.packageName),
        npmLatestVersion(info.packageName),
      ])
      return {
        slug: info.slug,
        package: info.packageName,
        installed: have,
        latest,
        status: freshnessVerdict(have, latest),
      }
    })
  )

  if (values.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return 0
  }

  if (rows.length === 0) {
    process.stdout.write(
      "agentproto adapters: no adapter packages installed (resolvable) on this machine.\n"
    )
    return 0
  }

  for (const r of rows) {
    const have = r.installed ?? "(not global — version unknown)"
    const latest = r.latest ?? "(unresolvable — offline?)"
    const mark =
      r.status === "behind"
        ? "→ update available"
        : r.status === "current"
          ? "✓ up to date"
          : "(freshness unknown)"
    process.stdout.write(`• ${r.slug}  ${have} → ${latest}  ${mark}\n`)
  }
  return 0
}

// ── show ──────────────────────────────────────────────────────────────

function extractModelIds(modelsField: unknown): string[] {
  const allowed = (modelsField as { allowed?: unknown } | undefined)?.allowed
  if (!Array.isArray(allowed)) return []
  const ids: string[] = []
  for (const entry of allowed) {
    if (typeof entry === "string") ids.push(entry)
    else if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string"
    ) {
      ids.push((entry as { id: string }).id)
    }
  }
  return ids
}

async function runShow(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { json: { type: "boolean" } },
    strict: true,
  })
  const pkg = positionals[0]
  if (!pkg) {
    process.stderr.write(
      "agentproto adapters show: missing <pkg>. Try: agentproto adapters show @guilde/agentproto-bridge\n"
    )
    return 2
  }

  let configured: string[] = []
  try {
    configured = (await loadAgentprotoConfig()).adapters ?? []
  } catch {
    // Non-fatal: still introspect the package even if config.json is unreadable.
  }

  let result: Awaited<ReturnType<typeof readAdapterManifest>>
  try {
    result = await readAdapterManifest(pkg)
  } catch (err) {
    process.stderr.write(
      `agentproto adapters show: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return 1
  }
  if (result) {
    if (values.json) {
      process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`)
      return 0
    }

    const m = result.manifest
    process.stdout.write(`${pkg}\n`)
    process.stdout.write(`  schema: ${m.schema}\n`)
    printAdapterDetail("substrates", m.substrates)
    printAdapterDetail("dispatchers", m.dispatchers)
    printAdapterDetail("executors", m.executors)
    printAdapterDetail("state stores", m.stateStores)
    return 0
  }

  // No agentproto/adapter/v1 runtime manifest. Try resolving as an AIP-45
  // agent-CLI adapter (supports both bare slugs like `antigravity` and
  // package names like `@agentproto/adapter-antigravity`).
  const slug = extractAdapterSlug(pkg)
  if (slug) {
    const { resolveAdapter } = await import("../registry/resolve.js")
    try {
      const resolved = await resolveAdapter(slug)
      const handle = resolved.handle as Record<string, unknown>
      const handleVersion =
        typeof handle.version === "string" ? handle.version : null
      const version = resolved.packageVersion ?? handleVersion
      const name = typeof handle.name === "string" ? handle.name : resolved.slug
      const description =
        typeof handle.description === "string" ? handle.description : ""
      const protocol =
        typeof handle.protocol === "string" ? handle.protocol : "unknown"
      const bin = typeof handle.bin === "string" ? handle.bin : null
      const binArgs = Array.isArray(handle.bin_args)
        ? (handle.bin_args as unknown[]).filter(
            (a): a is string => typeof a === "string"
          )
        : []
      const capabilities =
        handle.capabilities && typeof handle.capabilities === "object"
          ? (handle.capabilities as Record<string, unknown>)
          : {}
      const models = extractModelIds(handle.models)
      const modes = Array.isArray(resolved.handle.modes)
        ? resolved.handle.modes.map((m) => ({
            id: m.id,
            status: m.status ?? "active",
            ...(m.description ? { description: m.description } : {}),
          }))
        : []
      const enabled = isConfiguredAdapter(configured, [
        pkg,
        resolved.packageName,
        `@agentproto/adapter-${resolved.slug}`,
        `@agentproto/harness-${resolved.slug}`,
        resolved.slug,
      ])

      if (values.json) {
        const payload = {
          slug: resolved.slug,
          package: resolved.packageName ?? null,
          kind: "agent-cli" as const,
          manifest: null,
          source: resolved.source,
          version,
          ...(resolved.packageVersion &&
          handleVersion &&
          resolved.packageVersion !== handleVersion
            ? { handleVersion }
            : {}),
          name,
          description,
          protocol,
          bin,
          binArgs,
          capabilities,
          models,
          modes,
          enabled,
        }
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        return 0
      }

      const header = resolved.packageName
        ? `${resolved.slug} (${resolved.packageName})`
        : resolved.slug
      process.stdout.write(`${header}\n`)
      process.stdout.write(`  kind: agent-cli (no runtime manifest)\n`)
      process.stdout.write(`  source: ${resolved.source}\n`)
      if (version) {
        const handleSuffix =
          resolved.packageVersion &&
          handleVersion &&
          resolved.packageVersion !== handleVersion
            ? ` (handle: ${handleVersion})`
            : ""
        process.stdout.write(`  version: ${version}${handleSuffix}\n`)
      }
      process.stdout.write(`  protocol: ${protocol}\n`)
      if (bin) {
        process.stdout.write(
          `  bin: ${[bin, ...binArgs].join(" ")}\n`
        )
      }
      process.stdout.write(`  enabled: ${enabled ? "yes" : "no"}\n`)
      if (description) {
        process.stdout.write(`  description: ${description}\n`)
      }
      const capFlags = Object.entries(capabilities)
        .filter(([, v]) => v === true)
        .map(([k]) => k)
      if (capFlags.length > 0) {
        process.stdout.write(`  capabilities: ${capFlags.join(", ")}\n`)
      }
      if (models.length > 0) {
        process.stdout.write(`  models: ${models.join(", ")}\n`)
      }
      if (modes.length > 0) {
        process.stdout.write(
          `  modes: ${modes.map((m) => (m.status === "active" ? m.id : `${m.id} (${m.status})`)).join(", ")}\n`
        )
      }
      return 0
    } catch {
      // Not resolvable as an AIP-45 agent-CLI adapter — fall through to
      // legacy installed-package inspection.
    }
  }

  // Installed package without an agentproto/adapter/v1 manifest (legacy
  // side-effect adapter).
  const pkgInfo = await readAdapterPackageInfo(pkg)
  if (pkgInfo) {
    const enabled = isConfiguredAdapter(configured, [pkg, pkgInfo.name])
    if (values.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            package: pkgInfo.name ?? pkg,
            kind: "legacy" as const,
            manifest: null,
            version: pkgInfo.version ?? null,
            description: pkgInfo.description ?? "",
            packageRoot: pkgInfo.packageRoot,
            enabled,
          },
          null,
          2
        )}\n`
      )
      return 0
    }
    process.stdout.write(`${pkgInfo.name ?? pkg}\n`)
    process.stdout.write(
      `  kind: legacy side-effect adapter (no agentproto manifest)\n`
    )
    if (pkgInfo.version) {
      process.stdout.write(`  version: ${pkgInfo.version}\n`)
    }
    process.stdout.write(`  enabled: ${enabled ? "yes" : "no"}\n`)
    if (pkgInfo.description) {
      process.stdout.write(`  description: ${pkgInfo.description}\n`)
    }
    process.stdout.write(`  path: ${pkgInfo.packageRoot}\n`)
    return 0
  }

  if (configured.includes(pkg)) {
    process.stderr.write(
      `agentproto adapters show: '${pkg}' is enabled in config, but is not installed (cannot be resolved).\n`
    )
  } else {
    process.stderr.write(
      `agentproto adapters show: '${pkg}' is not installed.\n`
    )
  }
  return 1
}

function printAdapterDetail(
  label: string,
  entries: ReadonlyArray<AdapterEntry | SubstrateEntry>
): void {
  if (entries.length === 0) return
  process.stdout.write(`  ${label}:\n`)
  for (const e of entries) {
    process.stdout.write(`    • kind: ${e.kind}\n`)
    process.stdout.write(`      entry: ${e.entry} → ${e.export}\n`)
    const caps = "capabilities" in e ? e.capabilities : undefined
    if (Array.isArray(caps) && caps.length > 0) {
      process.stdout.write(`      capabilities: ${caps.join(", ")}\n`)
    }
    if (e.description) {
      process.stdout.write(`      ${e.description}\n`)
    }
  }
}

// ── install / uninstall / enable / disable ────────────────────────────

async function runInstall(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      local: { type: "boolean" },
      "skip-npm": { type: "boolean" },
    },
    strict: true,
  })
  const pkg = positionals[0]
  if (!pkg) {
    process.stderr.write("agentproto adapters install: missing <pkg>.\n")
    return 2
  }

  if (!values["skip-npm"]) {
    const code = await spawnInherit(
      "npm",
      withNpmGlobalPrefix(
        ["install", values.local ? "" : "-g", pkg].filter(Boolean),
      ),
    )
    if (code !== 0) {
      process.stderr.write(
        `agentproto adapters install: npm failed with exit ${code}; config not modified.\n`
      )
      return code
    }
  }

  await addAdapterToConfig(pkg)
  process.stdout.write(`agentproto adapters: enabled '${pkg}'.\n`)
  return 0
}

async function runUninstall(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      local: { type: "boolean" },
      "skip-npm": { type: "boolean" },
    },
    strict: true,
  })
  const pkg = positionals[0]
  if (!pkg) {
    process.stderr.write("agentproto adapters uninstall: missing <pkg>.\n")
    return 2
  }

  await removeAdapterFromConfig(pkg)

  if (!values["skip-npm"]) {
    const code = await spawnInherit(
      "npm",
      withNpmGlobalPrefix(
        ["uninstall", values.local ? "" : "-g", pkg].filter(Boolean),
      ),
    )
    if (code !== 0) {
      process.stderr.write(
        `agentproto adapters uninstall: removed from config but npm uninstall failed with exit ${code}.\n`
      )
      return code
    }
  }

  process.stdout.write(`agentproto adapters: disabled '${pkg}'.\n`)
  return 0
}

async function runEnable(args: readonly string[]): Promise<number> {
  const [pkg] = args
  if (!pkg) {
    process.stderr.write("agentproto adapters enable: missing <pkg>.\n")
    return 2
  }
  await addAdapterToConfig(pkg)
  process.stdout.write(`agentproto adapters: enabled '${pkg}'.\n`)
  return 0
}

async function runDisable(args: readonly string[]): Promise<number> {
  const [pkg] = args
  if (!pkg) {
    process.stderr.write("agentproto adapters disable: missing <pkg>.\n")
    return 2
  }
  await removeAdapterFromConfig(pkg)
  process.stdout.write(`agentproto adapters: disabled '${pkg}'.\n`)
  return 0
}

// ── hermes-plugin (system-prompt channel) ─────────────────────────────

const HERMES_PLUGIN_USAGE = `agentproto adapters hermes-plugin — manage the hermes system-prompt plugin

Usage:
  agentproto adapters hermes-plugin status   Show installed/enabled state [--json]
  agentproto adapters hermes-plugin install  Copy the bundled plugin into
                                             $HERMES_HOME/plugins [--enable] [--json]

The agentproto-system-prompt plugin is what gives hermes a real system-prompt
channel: hermes' ACP server exposes none of its own, so without the plugin the
projected system-prompt text falls back to a first-prompt prefix plus a
harness warning (delivery budget: ${MAX_HERMES_SYSTEM_PROMPT_CHARS} chars).

Enabling is an explicit consent — \`--enable\` runs
\`hermes plugins enable agentproto-system-prompt\` (argv, never a shell;
config.yaml is never edited by hand).
`

async function runHermesPlugin(args: readonly string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "status":
      return runHermesPluginStatus(rest)
    case "install":
      return runHermesPluginInstall(rest)
    default:
      process.stderr.write(
        `agentproto adapters hermes-plugin: unknown subcommand '${sub ?? ""}'.\n\n${HERMES_PLUGIN_USAGE}`
      )
      return 2
  }
}

async function runHermesPluginStatus(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { json: { type: "boolean" } },
    strict: true,
  })
  const status = hermesSystemPromptPluginStatus()
  if (values.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    return 0
  }
  process.stdout.write(
    `hermes system-prompt plugin (${status.path})\n` +
      `  installed: ${status.installed ? `yes (v${status.installedVersion})` : "no"}\n` +
      `  enabled:   ${status.enabled ? "yes" : "no"}\n` +
      `  bundled:   v${status.bundledVersion}\n`
  )
  if (!status.installed) {
    process.stdout.write(
      "\nNot installed — hermes has no system-prompt channel. Install it with:\n" +
        "  agentproto adapters hermes-plugin install --enable\n"
    )
  } else if (!status.enabled) {
    process.stdout.write(
      "\nInstalled but not enabled — the plugin will not load. Enable it with:\n" +
        "  agentproto adapters hermes-plugin install --enable\n"
    )
  }
  return 0
}

async function runHermesPluginInstall(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      enable: { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: true,
  })
  let result
  try {
    result = await installHermesSystemPromptPlugin({ enable: values.enable === true })
  } catch (err) {
    process.stderr.write(
      `agentproto adapters hermes-plugin install: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    const verb =
      result.action === "installed"
        ? `installed v${result.bundledVersion}`
        : result.action === "updated"
          ? `updated v${result.installedVersion ?? "?"} → v${result.bundledVersion}`
          : `already present (v${result.installedVersion ?? "?"}; bundled v${result.bundledVersion} is not newer)`
    process.stdout.write(`hermes system-prompt plugin: ${verb} at ${result.path}\n`)
    if (result.enable.requested) {
      if (result.enable.exitCode === 0) {
        process.stdout.write("enabled via `hermes plugins enable`.\n")
      } else if (result.enable.error) {
        process.stderr.write(`enable failed: ${result.enable.error}\n`)
      } else {
        process.stderr.write(
          `enable failed: \`hermes plugins enable\` exited ${result.enable.exitCode ?? "?"}\n`
        )
      }
    }
  }

  if (result.enable.requested && result.enable.exitCode !== 0) {
    return result.enable.exitCode ?? 1
  }
  return 0
}

function spawnInherit(cmd: string, argv: string[]): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, argv, { stdio: "inherit" })
    child.once("error", rejectP)
    child.once("exit", (code) => resolveP(code ?? 0))
  })
}
