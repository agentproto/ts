/**
 * `agentproto settings export|import` — "bring my main setup" (AIP onboarding
 * DEVICES-PLAN §PR-B).
 *
 *   export  Snapshot installed adapters, harness→profile presets, auth-profile
 *           METADATA, named LLM endpoints, imported-MCP pointers, and a
 *           sanitized `config.json` into one versioned JSON bundle.
 *   import  Read a bundle produced by `export` and apply it to THIS machine
 *           — additive only (never overwrites an existing local entry),
 *           always previewable with `--dry-run`.
 *
 * See `../lib/settings-bundle.ts` for the gather/apply logic and the secret
 * discipline it follows (nothing sensitive leaves the source machine by
 * default — see that file's header comment for the full rationale).
 */

import { parseArgs } from "node:util"
import { isatty } from "node:tty"
import {
  gatherSettingsBundle,
  applySettingsBundle,
  readSettingsBundle,
  writeSettingsBundle,
  type SettingsApplyReport,
  type SettingsBundle,
} from "../lib/settings-bundle.js"
import { promptBoolean } from "../lib/setup-prompts.js"

const USAGE = `agentproto settings — export/import this machine's setup

Usage:
  agentproto settings export [--out <file>] [--json]
                              [--include-secrets <profile-id>...] [--passphrase-env <VAR>]
  agentproto settings import <file> [--dry-run] [--yes] [--json]
                              [--unseal-passphrase-env <VAR>]
  agentproto settings --help

export:
  Writes a versioned JSON bundle (default: ./agentproto-settings-<date>.json)
  with installed adapters, harness presets, auth-profile METADATA (id,
  endpoint, method — never a credential), named LLM endpoints, imported-MCP
  pointers (env/header VALUES stripped — names only), and a sanitized
  config.json (secret + machine-specific keys dropped and reported).

  --include-secrets <id>   Seal this auth profile's stored credential into the
                            bundle, encrypted under a passphrase (requires
                            --passphrase-env). Repeatable. Omitted by default —
                            secrets never ride in a bundle unless asked.
  --passphrase-env <VAR>   Name of an env var holding the seal passphrase.
                            Never pass a passphrase as a bare argument.

import:
  Applies a bundle to this machine. ADDITIVE ONLY: an entry that already
  exists locally (same id) is left untouched and reported as skipped, never
  overwritten. A bundled auth profile with no matching sealed secret (or no
  --unseal-passphrase-env) is created disabled — a shape-only placeholder
  you fill in with a real credential afterward. Cron jobs are never part of
  a bundle and never auto-created by import.

  --dry-run                     Show the plan; write nothing.
  --yes                          Apply without an interactive confirmation
                                 (required in non-interactive contexts).
  --unseal-passphrase-env <VAR>  Name of an env var holding the passphrase to
                                 restore any sealed secrets in the bundle.
`

export async function runSettings(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(USAGE)
    return args.length === 0 ? 2 : 0
  }
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "export":
      return runExport(rest)
    case "import":
      return runImport(rest)
    default:
      process.stderr.write(`agentproto settings: unknown subcommand "${sub}".\n\n${USAGE}`)
      return 2
  }
}

// ── export ───────────────────────────────────────────────────────────────

function defaultBundlePath(): string {
  const date = new Date().toISOString().slice(0, 10)
  return `./agentproto-settings-${date}.json`
}

async function runExport(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      out: { type: "string" },
      "include-secrets": { type: "string", multiple: true },
      "passphrase-env": { type: "string" },
      json: { type: "boolean" },
    },
  })

  const includeSecrets = values["include-secrets"] ?? []
  let passphrase: string | undefined
  if (includeSecrets.length > 0) {
    const varName = values["passphrase-env"]
    if (!varName) {
      process.stderr.write(
        "agentproto settings export: --include-secrets requires --passphrase-env <VAR>\n",
      )
      return 2
    }
    passphrase = process.env[varName]
    if (!passphrase) {
      process.stderr.write(
        `agentproto settings export: env var "${varName}" is unset or empty\n`,
      )
      return 2
    }
  } else if (values["passphrase-env"]) {
    process.stderr.write(
      "agentproto settings export: --passphrase-env only applies with --include-secrets\n",
    )
    return 2
  }

  let result: Awaited<ReturnType<typeof gatherSettingsBundle>>
  try {
    result = await gatherSettingsBundle({ includeSecrets, passphrase })
  } catch (err) {
    process.stderr.write(
      `agentproto settings export: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const outPath = values.out ?? defaultBundlePath()
  await writeSettingsBundle(outPath, result.bundle)

  if (values.json) {
    process.stdout.write(JSON.stringify({ path: outPath, ...result }, null, 2) + "\n")
    return 0
  }

  process.stdout.write(
    `\nWrote settings bundle → ${outPath}\n\n` +
      `  ${result.bundle.adapters.length} adapter(s)\n` +
      `  ${result.bundle.harnessPresets.length} harness preset(s)\n` +
      `  ${result.bundle.authProfiles.length} auth profile(s) (metadata only)\n` +
      `  ${result.bundle.llmEndpoints.length} LLM endpoint(s)\n` +
      `  ${result.bundle.mcpServers.length} imported MCP server(s) (env/header VALUES stripped)\n` +
      `  ${Object.keys(result.bundle.config).length} config.json key(s)` +
      ` (${result.bundle.configSkipped.length} skipped — secret or machine-specific)\n` +
      (result.bundle.secrets ? `  ${result.bundle.secrets.length} sealed secret(s)\n` : ""),
  )
  if (result.warnings.length > 0) {
    process.stdout.write(`\nWarnings:\n${result.warnings.map(w => `  - ${w}\n`).join("")}`)
  }
  return 0
}

// ── import ───────────────────────────────────────────────────────────────

async function runImport(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
      "unseal-passphrase-env": { type: "string" },
      json: { type: "boolean" },
    },
  })
  const file = positionals[0]
  if (!file) {
    process.stderr.write("agentproto settings import: missing <file>.\n")
    return 2
  }

  let bundle: SettingsBundle
  try {
    bundle = await readSettingsBundle(file)
  } catch (err) {
    process.stderr.write(
      `agentproto settings import: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  let unsealPassphrase: string | undefined
  if (values["unseal-passphrase-env"]) {
    unsealPassphrase = process.env[values["unseal-passphrase-env"]]
    if (!unsealPassphrase) {
      process.stderr.write(
        `agentproto settings import: env var "${values["unseal-passphrase-env"]}" is unset or empty\n`,
      )
      return 2
    }
  } else if (bundle.secrets && bundle.secrets.length > 0) {
    process.stderr.write(
      `Note: this bundle carries ${bundle.secrets.length} sealed secret(s). Pass ` +
        `--unseal-passphrase-env <VAR> to restore them; otherwise the matching ` +
        `profile(s) are created disabled, with no credential.\n`,
    )
  }

  const dryRun = values["dry-run"] === true
  const yes = values.yes === true
  const interactive = !yes && !dryRun && isatty(process.stdin.fd ?? -1)
  if (!yes && !dryRun && !interactive) {
    process.stderr.write(
      "agentproto settings import: pass --yes to apply non-interactively, or --dry-run to preview.\n",
    )
    return 2
  }

  // Preview pass first — same decisions `applySettingsBundle` would make,
  // computed without writing anything, so a TTY confirmation shows the real
  // plan before the operator commits to it.
  const preview = await applySettingsBundle(bundle, { dryRun: true, unsealPassphrase })
  if (!dryRun && interactive) {
    printReport(preview, bundle)
    const proceed = await promptBoolean("\nApply this plan?", false)
    if (!proceed) {
      process.stdout.write("Aborted — nothing was applied.\n")
      return 0
    }
  }

  const report = dryRun ? preview : await applySettingsBundle(bundle, { dryRun: false, unsealPassphrase })

  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
    return 0
  }
  if (dryRun || !interactive) printReport(report, bundle)
  process.stdout.write(dryRun ? "\n(dry run — nothing was applied)\n" : "\nApplied.\n")
  return 0
}

function printReport(report: SettingsApplyReport, bundle: SettingsBundle): void {
  const line = (label: string, outcome: { added: string[]; skipped: { item: string; reason: string }[] }): string =>
    `  ${label}: ${outcome.added.length} to add, ${outcome.skipped.length} skipped\n`

  process.stdout.write(
    `\nPlan for this bundle (from ${bundle.sourceHost}, ${bundle.createdAt}):\n\n` +
      line("auth profiles", report.authProfiles) +
      (report.secretsRestored.length > 0
        ? `    (restoring credential for: ${report.secretsRestored.join(", ")})\n`
        : "") +
      line("harness presets", report.harnessPresets) +
      line("LLM endpoints", report.llmEndpoints) +
      line("imported MCP servers", report.mcpServers) +
      line("config.json keys", report.config),
  )
  if (report.missingAdapters.length > 0) {
    process.stdout.write(
      `\nAdapters in the bundle not installed here (not auto-installed):\n` +
        report.missingAdapters.map(a => `  agentproto install ${a.slug}   # v${a.version}\n`).join(""),
    )
  }
  if (report.mcpDanglingSecrets.length > 0) {
    process.stdout.write(
      `\nImported MCPs whose secrets were NOT carried over (supply them locally; key names only):\n` +
        report.mcpDanglingSecrets
          .map(d => `  - ${d.id}: ${[...(d.headers ?? []).map(k => `headers.${k}`), ...(d.env ?? []).map(k => `env.${k}`)].join(", ")}\n`)
          .join(""),
    )
  }
  const skippedDetails = [
    ...report.authProfiles.skipped,
    ...report.harnessPresets.skipped,
    ...report.llmEndpoints.skipped,
    ...report.mcpServers.skipped,
  ].filter(s => s.reason !== "already exists locally")
  if (skippedDetails.length > 0) {
    process.stdout.write(
      `\nSkipped (not "already exists"):\n${skippedDetails.map(s => `  - ${s.item}: ${s.reason}\n`).join("")}`,
    )
  }
}
