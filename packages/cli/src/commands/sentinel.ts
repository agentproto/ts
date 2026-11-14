/**
 * `agentproto sentinel watch pr <url> [--session <id>] [--urgency <u>]
 *                                     [--until closed|never] [--provider <slug>] [--json]`
 * `agentproto sentinel watch <subject> [--types <t1,t2>] [--session <id>]
 *                                     [--urgency <u>] [--until closed|never]
 *                                     [--provider <slug>] [--json]`
 * `agentproto sentinel list   [--json]`
 * `agentproto sentinel rm     <id> [--json]`     (alias: delete, unwatch)
 * `agentproto sentinel status <id> [--json]`
 * `agentproto sentinel routes [list] [--json]`
 * `agentproto sentinel routes explain <subject> [--types <t1,t2>] [--site <s>]
 *                                     [--provider <slug>] [--json]`
 *
 * Manage sentinels via the daemon's /sentinels HTTP routes. Same
 * daemon-discovery + HTTP helper pattern as `agentproto tunnel`.
 */
import { parseArgs } from "node:util"
import type { SentinelRouteExplanation, SentinelRoutesListing, SentinelView } from "@agentproto/sentinel"
import {
  discoverDaemon,
  printNoDaemonError,
  httpPostJson,
  httpGetJson,
  httpDelete,
  humaniseDelta,
} from "./_daemon-helpers.js"

const USAGE = `agentproto sentinel — watch GitHub subjects (or another session's lifecycle), deliver events into a session's inbox

Usage:
  agentproto sentinel watch pr <url> [--session <id>] [--urgency <u>]
                                     [--until closed|never] [--provider <slug>] [--json]
  agentproto sentinel watch <subject> [--types <t1,t2,...>] [--session <id>]
                                     [--urgency <u>] [--until closed|never]
                                     [--provider <slug>] [--json]
  agentproto sentinel list   [--json]
  agentproto sentinel rm     <id> [--json]       (alias: delete, unwatch)
  agentproto sentinel status <id> [--json]
  agentproto sentinel routes [list] [--json]
  agentproto sentinel routes explain <subject> [--types <t1,t2,...>]
                                     [--site watch|autolink|http|mcp-events]
                                     [--provider <slug>] [--json]

Discovers the daemon the same layered way \`agentproto sessions\` does — see
\`agentproto sessions --help\` for the full fallback order.

\`watch pr <url>\` is sugar: parses a github.com PR URL to subject
\`github:owner/repo#N\`, the default PR type set, and \`--until closed\`
(subject_terminal — the sentinel expires when the PR closes/merges).

A raw subject \`session:<id>\` watches ANOTHER SESSION's own lifecycle
instead of GitHub — woken on its turn-end, awaiting-input, or exit, even if
it never calls message_parent, self-expiring once it exits. Same
\`--until closed\` default as \`watch pr\`, and \`--provider\` defaults to
\`session\` (the only provider that understands this subject).

\`--session\` defaults to nothing from the CLI (unlike the MCP \`sentinel_watch\`
tool, a CLI invocation has no calling-session identity to default to) — it is
REQUIRED unless the daemon has some other default wired. This is the DELIVERY
target, distinct from the \`<id>\` inside a \`session:<id>\` subject (the session
being WATCHED).

\`--urgency\` one of: fyi | next-turn | steer | interrupt (default next-turn).
\`--until\`   closed (alias for subject_terminal, default for \`watch pr\` and a
             \`session:<id>\` subject) | never.
\`--provider\` local-gh | webhook | session. \`local-gh\` polls the host's
             authenticated \`gh\` CLI (zero infra). \`webhook\` is near-real-time
             push via a GitHub repo hook: it needs a public daemon URL (a
             named tunnel or AGENTPROTO_PUBLIC_URL) and a \`gh\` token with
             admin:repo_hook — see \`list_sentinel_adapters\` for readiness.
             \`session\` watches another session's lifecycle (zero infra, no
             credentials). Omitted for a GitHub subject, the daemon picks
             \`webhook\` only when a stable public URL exists and webhook is
             ready, else \`local-gh\`; for a \`session:<id>\` subject it always
             picks \`session\`.

\`routes\` is read-only: \`list\` prints the signal-routing rule table
(config \`sentinel.routes\` first, then the builtin defaults) with each
provider's readiness; \`explain <subject>\` prints which provider the router
picks for that subject and why, next to the provider the daemon actually uses
today. Shadow only: the router never changes the provider a sentinel uses.

Examples:
  agentproto sentinel watch pr https://github.com/agentproto/ts/pull/1501 --session sess_abc123
  agentproto sentinel watch pr https://github.com/agentproto/ts/pull/1501 --session sess_abc123 --provider webhook
  agentproto sentinel watch github:agentproto/ts --types 'github.issue_comment.*' --session sess_abc123
  agentproto sentinel watch session:sess_child456 --session sess_supervisor789
  agentproto sentinel list
  agentproto sentinel status sen_01ABC...
  agentproto sentinel rm sen_01ABC...
  agentproto sentinel routes
  agentproto sentinel routes explain github:agentproto/ts#1501
`

export async function runSentinel(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const sub = args[0]
  if (sub === "watch") return runWatch(args.slice(1))
  if (sub === "list") return runList(args.slice(1))
  if (sub === "rm" || sub === "delete" || sub === "unwatch") return runRm(args.slice(1))
  if (sub === "status") return runStatus(args.slice(1))
  if (sub === "routes") return runRoutes(args.slice(1))

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto sentinel: unknown subcommand "${sub}"\n` +
      `  Known: watch | list | rm | status | routes\n`,
  )
  return 2
}

// ── watch ─────────────────────────────────────────────────────────────

function normalizeUntil(raw: string | undefined): string | undefined {
  if (raw === "closed") return "subject_terminal"
  return raw
}

async function runWatch(args: readonly string[]): Promise<number> {
  if (args[0] === "pr") return runWatchPr(args.slice(1))
  return runWatchSubject(args)
}

async function postWatch(body: Record<string, unknown>, json: boolean, toolName: string): Promise<number> {
  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, toolName)
    return 2
  }
  const endpoint = report.found

  let view: SentinelView
  try {
    view = await httpPostJson<SentinelView>(`${endpoint.url}/sentinels`, body, endpoint.token)
  } catch (err) {
    process.stderr.write(`${toolName}: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (json) {
    process.stdout.write(JSON.stringify(view, null, 2) + "\n")
  } else {
    printSentinelDetail(view)
  }
  return 0
}

async function runWatchPr(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      session: { type: "string" },
      urgency: { type: "string" },
      until: { type: "string" },
      provider: { type: "string" },
      json: { type: "boolean" },
    },
  })

  const url = positionals[0]
  if (!url) {
    process.stderr.write(
      "agentproto sentinel watch pr: missing <url>.\n" +
        "  Try: agentproto sentinel watch pr https://github.com/owner/repo/pull/42 --session <id>\n",
    )
    return 2
  }

  const body: Record<string, unknown> = { prUrl: url }
  if (values.session) body.sessionId = values.session
  if (values.urgency) body.urgency = values.urgency
  const until = normalizeUntil(values.until)
  if (until) body.until = until
  if (values.provider) body.provider = values.provider

  return postWatch(body, values.json === true, "agentproto sentinel watch pr")
}

async function runWatchSubject(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      types: { type: "string" },
      session: { type: "string" },
      urgency: { type: "string" },
      until: { type: "string" },
      provider: { type: "string" },
      json: { type: "boolean" },
    },
  })

  const subject = positionals[0]
  if (!subject) {
    process.stderr.write(
      "agentproto sentinel watch: missing <subject> (or use `watch pr <url>`).\n" +
        "  Try: agentproto sentinel watch github:owner/repo#42 --session <id>\n",
    )
    return 2
  }

  const body: Record<string, unknown> = { subject }
  if (values.types) {
    body.types = values.types.split(",").map(t => t.trim()).filter(Boolean)
  }
  if (values.session) body.sessionId = values.session
  if (values.urgency) body.urgency = values.urgency
  const until = normalizeUntil(values.until)
  if (until) body.until = until
  if (values.provider) body.provider = values.provider

  return postWatch(body, values.json === true, "agentproto sentinel watch")
}

// ── list ──────────────────────────────────────────────────────────────

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sentinel list")
    return 2
  }
  const endpoint = report.found

  let result: { sentinels: SentinelView[] }
  try {
    result = await httpGetJson<{ sentinels: SentinelView[] }>(`${endpoint.url}/sentinels`)
  } catch (err) {
    process.stderr.write(`agentproto sentinel list: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const sentinels = result.sentinels ?? []
  if (values.json) {
    process.stdout.write(JSON.stringify(sentinels, null, 2) + "\n")
    return 0
  }

  if (sentinels.length === 0) {
    process.stdout.write("No sentinels.\n")
    return 0
  }

  const now = Date.now()
  process.stdout.write(
    `${"ID".padEnd(28)}  ${"STATUS".padEnd(9)}  ${"PROVIDER".padEnd(10)}  ${"EVENTS".padEnd(6)}  ${"AGE".padEnd(6)}  SUBJECT\n`,
  )
  for (const s of sentinels) {
    const age = humaniseDelta(now - s.createdTs)
    const subject = s.match.map(m => m.subject).join(", ")
    process.stdout.write(
      `${s.id.padEnd(28)}  ${s.status.padEnd(9)}  ${s.provider.padEnd(10)}  ${String(s.eventCount).padEnd(6)}  ${age.padEnd(6)}  ${subject}\n`,
    )
  }
  return 0
}

// ── rm ────────────────────────────────────────────────────────────────

async function runRm(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sentinel rm: missing id.\n" +
        "  Try: agentproto sentinel rm <id>  (find ids with `agentproto sentinel list`)\n",
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sentinel rm")
    return 2
  }
  const endpoint = report.found

  try {
    const result = await httpDelete<{ ok: boolean; id: string }>(
      `${endpoint.url}/sentinels/${encodeURIComponent(id)}`,
      endpoint.token,
    )
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } else {
      process.stdout.write(`sentinel removed  ${id}\n`)
    }
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(`agentproto sentinel rm: no sentinel "${id}" — try \`agentproto sentinel list\`\n`)
      return 2
    }
    process.stderr.write(`agentproto sentinel rm: ${msg}\n`)
    return 1
  }
}

// ── status ────────────────────────────────────────────────────────────

function printSentinelDetail(s: SentinelView): void {
  const now = Date.now()
  const age = humaniseDelta(now - s.createdTs)
  process.stdout.write(
    `id       ${s.id}\n` +
      `status   ${s.status}\n` +
      `provider ${s.provider}\n` +
      (s.label ? `label    ${s.label}\n` : "") +
      (s.group ? `group    ${s.group}\n` : "") +
      `match    ${s.match.map(m => `${m.subject}${m.types ? ` [${m.types.join(",")}]` : ""}`).join("; ")}\n` +
      `until    ${s.until.kind}\n` +
      `target   ${s.target.kind === "session" ? `session ${s.target.sessionId} (${s.target.urgency})` : JSON.stringify(s.target)}\n` +
      `events   ${s.eventCount}\n` +
      `created  ${age} ago\n` +
      (s.lastEventTs !== undefined ? `lastEvent ${humaniseDelta(now - s.lastEventTs)} ago\n` : "") +
      (s.lastError ? `error    ${s.lastError}\n` : ""),
  )
}

async function runStatus(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const id = positionals[0]
  if (!id) {
    process.stderr.write(
      "agentproto sentinel status: missing id.\n" +
        "  Try: agentproto sentinel status <id>\n",
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sentinel status")
    return 2
  }
  const endpoint = report.found

  let view: SentinelView
  try {
    view = await httpGetJson<SentinelView>(`${endpoint.url}/sentinels/${encodeURIComponent(id)}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(`agentproto sentinel status: no sentinel "${id}" — try \`agentproto sentinel list\`\n`)
      return 2
    }
    process.stderr.write(`agentproto sentinel status: ${msg}\n`)
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(view, null, 2) + "\n")
  } else {
    printSentinelDetail(view)
  }
  return 0
}

// ── routes ────────────────────────────────────────────────────────────

async function runRoutes(args: readonly string[]): Promise<number> {
  if (args[0] === "explain") return runRoutesExplain(args.slice(1))
  if (args[0] === "list") return runRoutesList(args.slice(1))
  if (args[0] && !args[0].startsWith("-")) {
    process.stderr.write(
      `agentproto sentinel routes: unknown subcommand "${args[0]}"\n` +
        `  Known: list | explain\n`,
    )
    return 2
  }
  return runRoutesList(args)
}

async function runRoutesList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sentinel routes")
    return 2
  }

  let listing: SentinelRoutesListing
  try {
    listing = await httpGetJson<SentinelRoutesListing>(`${report.found.url}/sentinels/routes`)
  } catch (err) {
    process.stderr.write(`agentproto sentinel routes: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(listing, null, 2) + "\n")
    return 0
  }
  process.stdout.write(formatRoutesListing(listing))
  return 0
}

export function formatRoutesListing(listing: SentinelRoutesListing): string {
  let out = `mode     ${listing.mode} (configured: ${listing.configuredMode}, applied: ${listing.applied})\n\n`
  out += `${"ID".padEnd(20)}  ${"MATCH".padEnd(28)}  ${"VIA".padEnd(22)}  ${"FALLBACK".padEnd(10)}  ${"DO".padEnd(7)}  MODE\n`
  for (const r of listing.routes) {
    const match =
      r.match.subject +
      (r.match.types?.length ? ` [${r.match.types.join(",")}]` : "") +
      (r.match.from?.site ? ` site=${r.match.from.site}` : "") +
      (r.match.from?.sessionLabel ? ` label=${r.match.from.sessionLabel}` : "")
    const fallback = r.fallback ?? ((r.do ?? "deliver") === "deliver" ? "next-ready" : "refuse")
    out += `${r.id.padEnd(20)}  ${match.padEnd(28)}  ${r.via.join(", ").padEnd(22)}  ${fallback.padEnd(10)}  ${(r.do ?? "deliver").padEnd(7)}  ${r.source === "builtin" ? "builtin" : (r.mode ?? "shadow")}\n`
  }
  out += `\n${"PROVIDER".padEnd(12)}  ${"READY".padEnd(5)}  ${"SUBJECTS".padEnd(10)}  REASON\n`
  for (const p of listing.providers) {
    out += `${p.slug.padEnd(12)}  ${(p.ready ? "yes" : "no").padEnd(5)}  ${(p.subjects?.join(",") ?? "-").padEnd(10)}  ${p.reason ?? ""}\n`
  }
  for (const w of listing.warnings) out += `warning  ${w}\n`
  out += `\n${listing.note}\n`
  return out
}

async function runRoutesExplain(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      types: { type: "string" },
      site: { type: "string" },
      provider: { type: "string" },
      json: { type: "boolean" },
    },
  })

  const subject = positionals[0]
  if (!subject) {
    process.stderr.write(
      "agentproto sentinel routes explain: missing <subject>.\n" +
        "  Try: agentproto sentinel routes explain github:owner/repo#42\n",
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto sentinel routes explain")
    return 2
  }

  const q = new URLSearchParams({ subject })
  if (values.types) q.set("types", values.types)
  if (values.site) q.set("site", values.site)
  if (values.provider) q.set("provider", values.provider)

  let explanation: SentinelRouteExplanation
  try {
    explanation = await httpGetJson<SentinelRouteExplanation>(`${report.found.url}/sentinels/routes/explain?${q.toString()}`)
  } catch (err) {
    process.stderr.write(`agentproto sentinel routes explain: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(explanation, null, 2) + "\n")
    return 0
  }
  process.stdout.write(formatRouteExplanation(explanation))
  return 0
}

export function formatRouteExplanation(e: SentinelRouteExplanation): string {
  let out =
    `subject  ${e.subject} (site ${e.site})\n` +
    `rule     ${e.rule}\n` +
    `routed   ${e.slug ?? `none (${e.error ?? "refused"})`}\n` +
    `reason   ${e.reason}\n` +
    (e.fallbackFrom ? `fallback from ${e.fallbackFrom}\n` : "") +
    (e.warning ? `warning  ${e.warning}\n` : "") +
    `in use   ${e.legacy} (legacy selection, applied: ${e.applied})\n` +
    `walked\n`
  for (const w of e.walked) {
    out += `  ${w.provider.padEnd(12)}  ${w.rejected ? `rejected: ${w.rejected}` : "eligible"}${w.durable !== undefined ? `  durable=${w.durable}` : ""}\n`
  }
  return out
}
