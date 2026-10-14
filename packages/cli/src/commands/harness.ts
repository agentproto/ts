/**
 * `agentproto harness <subverb>` — freshness and safe upgrades of the
 * agent CLI binary an adapter spawns (the "harness": opencode, gemini,
 * copilot, …). Distinct from `agentproto adapters`, which manages the
 * adapter *PACKAGES* (`@agentproto/adapter-*`); this verb manages the
 * thing those packages spawn.
 *
 *   harness outdated [--json]              read-only freshness report — always exit 0
 *   harness check <slug> [--json]          ACP smoke probe (initialize +
 *                                          session/new, no prompt) — exit 1
 *                                          when the harness is incompatible
 *   harness upgrade <slug...|--all>        run the adapter's declared
 *        [--dry-run] [--force] [--json]    upgrade.cmd, re-probe, roll back
 *                                          on failure — exit 1 when any slug
 *                                          was refused or failed
 *
 * All three are thin: the probe/guard/upgrade logic lives in
 * `../registry/harness.ts` (and `../registry/harness-probe.ts`), whose
 * outputs are the source of truth — this layer only parses argv, picks a
 * formatter, and aggregates exit codes. Every per-slug operation degrades
 * to "unknown"/"refused" rather than crashing the whole verb.
 */

import { parseArgs } from "node:util"
import {
  collectHarnessRows,
  harnessManifest,
  probeTarget,
  upgradeHarness,
  type HarnessManifest,
  type HarnessOutdatedRow,
  type UpgradeResult,
} from "../registry/harness.js"
import { acpSmokeProbe, type SmokeProbeResult } from "../registry/harness-probe.js"
import { resolveAdapter } from "../registry/resolve.js"
import { discoverDaemon, httpGetJson } from "./_daemon-helpers.js"

const USAGE = `agentproto harness — freshness + safe upgrades of the spawned agent CLI

Usage:
  agentproto harness outdated [--json]
       Read-only report: installed harness version vs latest published,
       plus the AIP-45 version_check.range verdict. Never writes, never
       exits non-zero — every probe degrades to unknown (offline?).
  agentproto harness check <slug> [--json]
       ACP smoke probe: initialize + session/new against the installed
       harness in a temp cwd. NO session/prompt — no tokens spent.
       Exit 0 compatible / 1 incompatible (or could not probe).
  agentproto harness upgrade (<slug>...) | --all [--dry-run] [--force] [--json]
       Run the adapter's declared upgrade.cmd (inherited stdio), re-read
       the version, re-run the smoke probe, and roll back to the previous
       version when the probe fails (when a rollback is declared).
       Refuses (exit 1, nothing run) when latest is outside
       version_check.range or a live daemon session of the adapter
       exists — --force bypasses both.
  agentproto harness --help

  --all      upgrade every installed adapter that declares an upgrade cmd
  --dry-run  print the upgrade command, run nothing
  --force    bypass the range guard, the live-session guard, and the
             "unreadable installed version" refusal
  --json     machine-readable output (rows / probe result / results)

The pinned-npx rule: an adapter whose bin_args pins the harness
(npx -y <pkg>@<x.y.z>, e.g. claude-code, codex) is never upgraded in
place — the pin lives in the adapter, so outdated reports it and the fix
is bumping the pin via a PR to this repo.

Examples:
  agentproto harness outdated --json
  agentproto harness check opencode
  agentproto harness upgrade opencode gemini
  agentproto harness upgrade --all --dry-run
`

/** Injection seam for the command layer — the registry functions take the
 *  same options, this just forwards them so tests drive the dispatch and
 *  formatting without spawning npm or resolving real adapters. */
export interface HarnessCommandOverrides {
  collectRows?: () => Promise<HarnessOutdatedRow[]>
  resolveManifest?: (slug: string) => Promise<HarnessManifest>
  smokeProbe?: (m: HarnessManifest) => Promise<SmokeProbeResult>
  upgrade?: (m: HarnessManifest) => Promise<UpgradeResult>
  hasLiveSessions?: (slug: string) => Promise<boolean>
}

export async function runHarness(
  args: readonly string[],
  overrides: HarnessCommandOverrides = {},
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "outdated":
      return runOutdated(rest, overrides)
    case "check":
      return runCheck(rest, overrides)
    case "upgrade":
      return runUpgrade(rest, overrides)
    case undefined:
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto harness: unknown subcommand '${sub}'.\n` +
          `  Known: outdated | check | upgrade\n\n${USAGE}`,
      )
      return 2
  }
}

// ── shared defaults ───────────────────────────────────────────────────

const defaultResolveManifest = async (slug: string): Promise<HarnessManifest> =>
  harnessManifest(slug, (await resolveAdapter(slug)).handle)

/**
 * Live-session guard for `upgrade`: does the daemon currently hold a
 * running session of this adapter? Best-effort — no reachable daemon (or
 * an unreadable session list) is NOT evidence of a live session, so the
 * upgrade proceeds and its own rollback still covers a bad upgrade.
 */
async function daemonHasLiveSession(slug: string): Promise<boolean> {
  const report = await discoverDaemon()
  if (!report.found) return false
  try {
    const body = await httpGetJson<{ sessions?: Array<{ adapterSlug?: string }> }>(
      `${report.found.url}/sessions?onlyAlive=true`,
    )
    const sessions = Array.isArray(body.sessions) ? body.sessions : []
    return sessions.some((s) => s.adapterSlug === slug)
  } catch {
    return false
  }
}

// ── outdated ──────────────────────────────────────────────────────────

async function runOutdated(
  args: readonly string[],
  overrides: HarnessCommandOverrides,
): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { json: { type: "boolean" } },
    strict: true,
  })

  let rows: HarnessOutdatedRow[]
  try {
    rows = await (overrides.collectRows ?? collectHarnessRows)()
  } catch (err) {
    process.stderr.write(
      `agentproto harness outdated: could not enumerate installed adapters: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return 0
  }

  if (rows.length === 0) {
    process.stdout.write(
      "agentproto harness: no adapters installed (resolvable) on this machine.\n",
    )
    return 0
  }

  const widths = {
    slug: Math.max(4, ...rows.map((r) => r.slug.length)),
    installed: Math.max(9, ...rows.map((r) => (r.installed ?? "—").length)),
    latest: Math.max(6, ...rows.map((r) => (r.latest ?? "—").length)),
  }
  process.stdout.write(
    `${"SLUG".padEnd(widths.slug)}  ${"INSTALLED".padEnd(widths.installed)}  ` +
      `${"LATEST".padEnd(widths.latest)}  STATUS    NOTE\n`,
  )
  for (const r of rows) {
    process.stdout.write(
      `${r.slug.padEnd(widths.slug)}  ${(r.installed ?? "—").padEnd(widths.installed)}  ` +
        `${(r.latest ?? "—").padEnd(widths.latest)}  ${r.status.padEnd(8)}  ${r.note ?? ""}\n`,
    )
  }
  return 0
}

// ── check ─────────────────────────────────────────────────────────────

async function runCheck(
  args: readonly string[],
  overrides: HarnessCommandOverrides,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { json: { type: "boolean" } },
    strict: true,
  })
  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto harness check: missing <slug>. Try: agentproto harness check opencode\n",
    )
    return 2
  }

  let m: HarnessManifest
  try {
    m = await (overrides.resolveManifest ?? defaultResolveManifest)(slug)
  } catch (err) {
    process.stderr.write(
      `agentproto harness check: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (m.protocol !== "acp") {
    // Not a probe failure: a proprietary/print harness has no ACP
    // handshake to answer, and pretending otherwise would fail every
    // upgrade of (say) pi for no reason.
    if (values.json) {
      process.stdout.write(
        `${JSON.stringify({ slug, protocol: m.protocol, ok: null, note: "not ACP — smoke probe skipped" }, null, 2)}\n`,
      )
    } else {
      process.stdout.write(
        `${slug}: protocol '${m.protocol}' — not ACP, smoke probe skipped.\n`,
      )
    }
    return 0
  }

  const probe = overrides.smokeProbe
    ? await overrides.smokeProbe(m)
    : await acpSmokeProbe(probeTarget(m))

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ slug, protocol: m.protocol, ...probe }, null, 2)}\n`)
    return probe.ok ? 0 : 1
  }
  if (probe.ok) {
    const caps = probe.loadSession === true ? ", loadSession" : ""
    process.stdout.write(`${slug}: ACP ok (protocolVersion ${probe.protocolVersion ?? "?"}${caps})\n`)
    return 0
  }
  process.stderr.write(`${slug}: ACP smoke probe failed: ${probe.error ?? "unknown error"}\n`)
  return 1
}

// ── upgrade ───────────────────────────────────────────────────────────

async function runUpgrade(
  args: readonly string[],
  overrides: HarnessCommandOverrides,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: true,
  })

  const resolveManifest = overrides.resolveManifest ?? defaultResolveManifest
  const upgrade = overrides.upgrade ?? ((m: HarnessManifest) =>
    upgradeHarness(m, {
      ...(values["dry-run"] ? { dryRun: true } : {}),
      ...(values.force ? { force: true } : {}),
      deps: {
        ...(overrides.smokeProbe ? { smokeProbe: overrides.smokeProbe } : {}),
        hasLiveSessions: overrides.hasLiveSessions ?? daemonHasLiveSession,
      },
    }))

  let targets: HarnessManifest[] = []
  if (values.all) {
    if (positionals.length > 0) {
      process.stderr.write("agentproto harness upgrade: --all takes no <slug> arguments.\n")
      return 2
    }
    const { listInstalledAdapters } = await import("../registry/resolve.js")
    const listed = await listInstalledAdapters().catch(() => [])
    for (const info of listed) {
      try {
        const m = await resolveManifest(info.slug)
        if (m.upgrade) targets.push(m) /* pinned/curl-only declare nothing */
      } catch {
        /* unresolvable adapter — nothing safe to upgrade */
      }
    }
    if (targets.length === 0) {
      process.stderr.write(
        "agentproto harness upgrade: no installed adapter declares an upgrade command " +
          "(pinned-npx and curl-only harnesses are bumped in this repo instead).\n",
      )
      return 1
    }
  } else {
    if (positionals.length === 0) {
      process.stderr.write(
        "agentproto harness upgrade: pass one or more <slug>s, or --all.\n" +
          "  Try: agentproto harness upgrade opencode\n",
      )
      return 2
    }
    for (const slug of positionals) {
      try {
        targets.push(await resolveManifest(slug))
      } catch (err) {
        process.stderr.write(
          `agentproto harness upgrade: ${slug}: ${err instanceof Error ? err.message : String(err)}\n`,
        )
        return 1
      }
    }
  }

  const results: UpgradeResult[] = []
  for (const m of targets) {
    const result = await upgrade(m)
    results.push(result)
    if (!values.json) printUpgradeResult(result)
  }
  if (values.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  return results.some(
    (r) => r.outcome === "failed" || r.outcome === "rolled-back" || r.outcome === "refused",
  )
    ? 1
    : 0
}

function printUpgradeResult(r: UpgradeResult): void {
  const range = (s: string | null): string => s ?? "unknown"
  switch (r.outcome) {
    case "upgraded":
      process.stdout.write(
        `${r.slug}: ${range(r.before)} → ${range(r.after)}` +
          `${r.command ? `  (${r.command.join(" ")})` : ""}` +
          `${r.probe ? "  — smoke probe ok" : ""}\n`,
      )
      return
    case "dry-run":
      process.stdout.write(
        `${r.slug}: would run: ${r.command?.join(" ") ?? "?"}` +
          `  (${range(r.before)} → latest)\n`,
      )
      return
    case "current":
      process.stdout.write(`${r.slug}: already at ${range(r.after ?? r.before)}\n`)
      return
    case "refused":
      process.stderr.write(`${r.slug}: refused — ${r.reason ?? "unknown reason"}\n`)
      return
    case "rolled-back":
      process.stderr.write(
        `${r.slug}: upgrade failed, rolled back to ${range(r.after)} — ${r.reason ?? "unknown reason"}\n`,
      )
      return
    case "failed":
      process.stderr.write(`${r.slug}: FAILED — ${r.reason ?? "unknown reason"}\n`)
      return
  }
}
