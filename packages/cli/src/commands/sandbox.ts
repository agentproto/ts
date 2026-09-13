/**
 * `agentproto sandbox list|attach|rm|gc`
 *
 * Phase 1 `sandbox attach` — connect to an ALREADY-EXISTING sandbox
 * (Box/e2b) without tearing it down. Pure local shell over
 * `@agentproto/runtime`'s `attachSandbox`, same "no daemon required" shape
 * as `agentproto worktree`: this resolves the sandbox provider directly
 * (reading credentials from `~/.agentproto/sandbox-creds/<slug>.json`,
 * same store `setup_sandbox_provider` writes to) rather than talking to an
 * already-running local daemon — attach is about reaching a REMOTE
 * sandbox's daemon, not this machine's.
 *
 * PLAN-D1 adds navigation over the daemon's sandbox ledger
 * (`~/.agentproto/sandboxes.json`):
 *   - `list` renders the persisted boxes (id, provider, label, state, age,
 *     expiry, origin session) — `--json` for machines.
 *   - `rm` drops a LEDGER ENTRY by default; `--box` ALSO stops the box
 *     side the provider (destructive — requires `--yes` on a non-TTY, an
 *     interactive confirmation otherwise).
 *
 * `attach` prints the connection descriptor and a paste-ready `.mcp.json`
 * snippet. Never stops or pauses the sandbox.
 */
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import {
  attachSandbox,
  buildMcpConfigSnippet,
  collectGcCandidates,
  makeSandboxCredsStore,
  makeSandboxResolver,
  readSandboxLedger,
  recordSandboxLiveness,
  removeSandboxLedgerEntry,
  reapGcEntry,
  type SandboxLedgerEntry,
} from "@agentproto/runtime"
import { discoverDaemon, httpGetJson } from "./_daemon-helpers.js"

const USAGE = `agentproto sandbox — connect to sandbox providers

Usage:
  agentproto sandbox list [--json]
  agentproto sandbox attach <provider> <sandboxId> [--config-json <json>] [--keep-alive] [--json]
  agentproto sandbox rm <sandboxId|label|id-prefix> [--box] [--yes] [--json]
  agentproto sandbox gc [--apply] [--pause] [--json]

list   Show the sandbox ledger — every box the daemon booted, reconnected
       to, paused, or stopped, with its current state and idle-expiry.
       Columns:
         LIVE  provider liveness probe result (yes/no) — the ONLY signal
               that the box still exists on its provider. STATE is what the
               daemon LAST DID and is NOT trustworthy: a provider-reaped
               box still shows paused/connected (and its app URL) until
               probed. "—" when the provider can't probe, "?" when the
               probe errored. Pass --no-probe to skip the network calls.
       --json prints the raw ledger rows.

attach Connects to an ALREADY-EXISTING sandbox (e.g. a Box or e2b sandbox
       booted by a prior \`agent_start\` sandbox spawn) without tearing it
       down: resumes it, ensures its agentproto daemon is healthy and
       reachably exposed with a PERSISTENT, token-gated URL, and prints a
       connection descriptor plus a paste-ready .mcp.json snippet any MCP
       client can use to reach it directly.

  <provider>    Sandbox provider slug, e.g. "box" or "e2b".
  <sandboxId>   Provider-assigned sandbox id to attach to.

  --config-json <json>  Provider-specific SandboxSpec config overrides as a
                         JSON object, e.g. '{"port":18790}'.
  --keep-alive           Keep the sandbox awake indefinitely for an
                           always-on rendezvous — pins Box's ttlSeconds to
                           null (no-auto-stop) on this box, defensively, even
                           if it already defaults to that. No-op for
                           providers without an equivalent.
  --json                Print only the descriptor + mcpConfig, as JSON.

rm     Removes the LEDGER ENTRY for the given box (resolved by exact label,
       sandboxId, or unique id prefix) — non-destructive, the box itself is
       left alone.

--box  ALSO stop the box on its provider (DESTRUCTIVE — the sandbox and
          everything in it is torn down). Without --yes, an interactive
          terminal is asked to confirm; a non-interactive shell must pass
          --yes explicitly.
   --json Print the outcome as JSON.

gc     Reap ORPHAN boxes: ledger entries whose origin session ended in a
       failure state (error / killed / exited) — the session can never come
       back to its box, so the box is just money. Dry run by default; it
       prints what WOULD be torn down.

  --apply  Actually tear the boxes down (kill on the provider) and stamp
           the ledger rows "stopped".
  --pause  With --apply: PAUSE the boxes instead of killing them (keeps
           them attachable later) — note a paused e2b box still bills, so
           the default kill is usually what you want for orphans.
  --json   Print the plan / outcomes as JSON.

Credentials: provider API keys (e.g. BOX_API_KEY, E2B_API_KEY) must be set
in this process's environment — same as \`agent_start.sandbox\` uses.

Examples:
  agentproto sandbox list
  agentproto sandbox attach box bx_abc123
  agentproto sandbox attach box bx_abc123 --keep-alive
  agentproto sandbox attach e2b sbx_abc123 --json
  agentproto sandbox rm my-task-label
  agentproto sandbox rm bx_abc123 --box --yes
`

export interface SandboxGcCliDeps {
  /** Origin-session id → daemon status ("error"/"killed"/"exited"/…).
   *  Defaults to the live daemon's `GET /sessions`. */
  fetchSessionStatuses?: () => Promise<Map<string, string>>
  /** Resolves a ledger row's provider to its handle. Defaults to the
   *  local sandbox-creds store (same as `attach`). */
  resolveProvider?: SandboxGcProviderHandleResolver
}

type SandboxGcProviderHandleResolver = (
  slug: string,
) => Promise<import("@agentproto/runtime").SandboxGcProviderHandle | null>

export async function runSandbox(args: readonly string[], gcDeps?: SandboxGcCliDeps): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const sub = args[0]
  if (sub === "attach") return runAttach(args.slice(1))
  if (sub === "list") return runList(args.slice(1))
  if (sub === "rm") return runRm(args.slice(1))
  if (sub === "gc") return runGc(args.slice(1), gcDeps)

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto sandbox: unknown subcommand "${sub}"\n` + `  Known: list, attach, rm, gc\n`,
  )
  return 2
}

/** Resolve a ledger row from an exact label, full sandboxId, or unique
 *  id prefix. Returns the row, or an error line for the caller to print. */
function resolveLedgerEntry(
  token: string,
  entries: readonly SandboxLedgerEntry[],
): { entry: SandboxLedgerEntry } | { error: string } {
  const byId = entries.find(e => e.sandboxId === token)
  if (byId) return { entry: byId }
  const byLabel = entries.filter(e => e.label === token)
  const soleLabel = byLabel.length === 1 ? byLabel[0] : undefined
  if (soleLabel) return { entry: soleLabel }
  if (byLabel.length > 1) {
    return {
      error:
        `"${token}" is ambiguous — ${byLabel.length} ledger entries carry that label: ` +
        byLabel.map(e => e.sandboxId).join(", ") +
        ". Use the full sandboxId.",
    }
  }
  const byPrefix = entries.filter(e => e.sandboxId.startsWith(token))
  const solePrefix = byPrefix.length === 1 ? byPrefix[0] : undefined
  if (solePrefix) return { entry: solePrefix }
  if (byPrefix.length > 1) {
    return {
      error:
        `"${token}" is ambiguous — it prefixes ${byPrefix.length} sandbox ids: ` +
        byPrefix.map(e => e.sandboxId).join(", ") +
        ". Use a longer prefix or the full sandboxId.",
    }
  }
  return { error: `"${token}" matches no ledger entry (see \`agentproto sandbox list\`).` }
}

function relative(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return "?"
  const abs = Math.abs(ms)
  const units: Array<[number, string]> = [
    [1000, "s"],
    [60_000, "m"],
    [3_600_000, "h"],
    [86_400_000, "d"],
  ]
  let out = `${abs}ms`
  for (const [size, unit] of units) {
    if (abs >= size) out = `${Math.round(abs / size)}${unit}`
  }
  return ms >= 0 ? `${out} ago` : `in ${out}`
}

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      "no-probe": { type: "boolean" },
    },
  })
  const entries = readSandboxLedger()
  if (values.json) {
    process.stdout.write(JSON.stringify({ sandboxes: entries }, null, 2) + "\n")
    return 0
  }
  if (entries.length === 0) {
    process.stdout.write("no sandboxes in the ledger (~/.agentproto/sandboxes.json)\n")
    return 0
  }
  const live = values["no-probe"] ? [] : await probeLedgerLiveness(entries)
  const rows: Array<string[]> = [
    ["ID", "PROVIDER", "LABEL", "STATE", "LIVE", "AGE", "EXPIRES", "ORIGIN SESSION"],
  ]
  for (const e of entries) {
    const id = e.sandboxId.length > 20 ? `${e.sandboxId.slice(0, 17)}…` : e.sandboxId
    const expires = e.expiresAt
      ? relative(e.expiresAt)
      : "—"
    rows.push([
      id,
      e.provider,
      e.label ?? "—",
      e.state,
      live.find(r => r.sandboxId === e.sandboxId)?.verdict ?? "—",
      relative(e.updatedAt),
      expires,
      e.originSessionId ?? "—",
    ])
  }
  const header = rows[0]
  if (!header) return 0
  const widths = header.map((_, i) => Math.max(...rows.map(r => r[i]?.length ?? 0)))
  for (const [i, row] of rows.entries()) {
    const line = row.map((cell, j) => cell.padEnd(widths[j] ?? 0)).join("  ")
    process.stdout.write(`${line}\n`)
  }
  return 0
}

/**
 * Probe each ledger row's provider for box liveness (`SandboxProvider.probe`
 * — the provider control plane, not the box) and stamp the verdict back into
 * the ledger (`recordSandboxLiveness`, which flips a dead row to "gone").
 * Verdicts: "yes" alive · "no" gone · "?" probe failed · "—" provider can't
 * probe. Best-effort per row — one broken box never fails the listing.
 */
async function probeLedgerLiveness(
  entries: readonly SandboxLedgerEntry[],
): Promise<Array<{ sandboxId: string; verdict: string }>> {
  const resolver = makeSandboxResolver(makeSandboxCredsStore())
  const out: Array<{ sandboxId: string; verdict: string }> = []
  for (const e of entries) {
    let verdict = "—"
    try {
      const handle = await resolver(e.provider)
      if (handle?.provider?.probe) {
        const probe = await handle.provider.probe(e.sandboxId)
        verdict = probe.alive ? "yes" : "no"
        recordSandboxLiveness(e.sandboxId, probe.alive)
      }
    } catch {
      verdict = "?"
    }
    out.push({ sandboxId: e.sandboxId, verdict })
  }
  return out
}

async function runRm(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      box: { type: "boolean" },
      yes: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const token = positionals[0]
  if (!token) {
    process.stderr.write(
      "agentproto sandbox rm: missing <sandboxId|label|id-prefix>.\n" +
        "  Try: agentproto sandbox rm bx_abc123\n",
    )
    return 2
  }
  const resolved = resolveLedgerEntry(token, readSandboxLedger())
  if ("error" in resolved) {
    process.stderr.write(`agentproto sandbox rm: ${resolved.error}\n`)
    return 1
  }
  const entry = resolved.entry

  const fail = (message: string): number => {
    if (values.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n")
    } else {
      process.stderr.write(`agentproto sandbox rm: ${message}\n`)
    }
    return 1
  }

  if (values.box) {
    const confirmed =
      values.yes ||
      (process.stdin.isTTY
        ? await confirmInteractive(
            `Stop sandbox ${entry.sandboxId} on provider "${entry.provider}" (DESTRUCTIVE)? [y/N] `,
          )
        : false)
    if (!confirmed) {
      return fail(
        "refusing to stop the box without --yes (or an interactive confirmation) — " +
          "the ledger entry alone is removable with plain `agentproto sandbox rm`.",
      )
    }
    const stopErr = await stopLedgerBox(entry)
    if (stopErr) return fail(stopErr)
  }

  removeSandboxLedgerEntry(entry.sandboxId)
  if (values.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, removed: entry.sandboxId, boxStopped: !!values.box }, null, 2) +
        "\n",
    )
    return 0
  }
  process.stdout.write(
    values.box
      ? `sandbox ${entry.sandboxId} stopped and removed from the ledger\n`
      : `sandbox ${entry.sandboxId} removed from the ledger (box untouched)\n`,
  )
  return 0
}

async function confirmInteractive(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(prompt)
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes"
  } catch {
    return false
  } finally {
    rl.close()
  }
}

/** Stop the box on its provider — resolve the provider, `connect()` to the
 *  existing sandbox, then `stop()` the connected handle. Returns an error
 *  message on failure, `undefined` on success. */
async function stopLedgerBox(entry: SandboxLedgerEntry): Promise<string | undefined> {
  const resolver = makeSandboxResolver(makeSandboxCredsStore())
  let handle
  try {
    handle = await resolver(entry.provider)
  } catch (err) {
    return `provider "${entry.provider}" could not be resolved — ${err instanceof Error ? err.message : String(err)}`
  }
  if (!handle) return `provider "${entry.provider}" not found — check \`list_sandbox_providers\`.`
  if (!handle.provider.connect) {
    return `provider "${entry.provider}" has no connect() — cannot reach the existing box to stop it.`
  }
  try {
    const booted = await handle.provider.connect(entry.sandboxId, { provider: entry.provider, config: {} }, { env: {} })
    await booted.stop()
    return undefined
  } catch (err) {
    return `stopping sandbox "${entry.sandboxId}" failed — ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Default session-status source: the daemon's `GET /sessions` (read-only,
 *  no bearer needed on the loopback default). */
async function defaultFetchSessionStatuses(): Promise<Map<string, string>> {
  const report = await discoverDaemon()
  if (!report.found) {
    throw new Error(
      "no live daemon found — sandbox gc needs the daemon to read origin-session " +
        "statuses (start one with `agentproto serve`, or set AGENTPROTO_DAEMON_URL).",
    )
  }
  const body = await httpGetJson<{ sessions?: Array<{ id?: unknown; status?: unknown }> }>(
    `${report.found.url}/sessions`,
  )
  const map = new Map<string, string>()
  for (const s of body.sessions ?? []) {
    if (typeof s.id === "string" && typeof s.status === "string") map.set(s.id, s.status)
  }
  return map
}

const defaultResolveProvider: SandboxGcProviderHandleResolver = async slug => {
  const resolver = makeSandboxResolver(makeSandboxCredsStore())
  const handle = await resolver(slug)
  if (!handle) return null
  return handle as unknown as import("@agentproto/runtime").SandboxGcProviderHandle
}

async function runGc(args: readonly string[], cliDeps?: SandboxGcCliDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: "boolean" },
      pause: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const deps = cliDeps ?? {}

  let statuses: Map<string, string>
  try {
    statuses = await (deps.fetchSessionStatuses ?? defaultFetchSessionStatuses)()
  } catch (err) {
    process.stderr.write(
      `agentproto sandbox gc: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const candidates = collectGcCandidates(readSandboxLedger(), statuses)

  if (!values.apply) {
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          {
            candidates: candidates.map(c => ({
              sandboxId: c.entry.sandboxId,
              provider: c.entry.provider,
              state: c.entry.state,
              originSessionId: c.entry.originSessionId,
              sessionStatus: c.sessionStatus,
            })),
            applied: false,
            results: [],
          },
          null,
          2,
        ) + "\n",
      )
      return 0
    }
    if (candidates.length === 0) {
      process.stdout.write(
        "no orphan sandboxes — no ledger entries have an origin session in " +
          "error/killed/exited\n",
      )
      return 0
    }
    const rows: Array<string[]> = [["ID", "PROVIDER", "STATE", "SESSION", "STATUS"]]
    for (const c of candidates) {
      const id =
        c.entry.sandboxId.length > 20 ? `${c.entry.sandboxId.slice(0, 17)}…` : c.entry.sandboxId
      rows.push([
        id,
        c.entry.provider,
        c.entry.state,
        c.entry.originSessionId ?? "—",
        c.sessionStatus,
      ])
    }
    const header = rows[0]
    if (!header) return 0
    const widths = header.map((_, i) => Math.max(...rows.map(r => r[i]?.length ?? 0)))
    for (const [i, row] of rows.entries()) {
      process.stdout.write(row.map((cell, j) => cell.padEnd(widths[j] ?? 0)).join("  ") + "\n")
    }
    process.stdout.write(
      `\n${candidates.length} orphan sandbox(es) — dry run only. Re-run with --apply to tear them down` +
        `${values.pause ? "" : " (kill is the default; pass --pause to pause instead)"}.\n`,
    )
    return 0
  }

  const resolveProvider = deps.resolveProvider ?? defaultResolveProvider
  const results: Array<{ sandboxId: string; ok: boolean; action?: string; error?: string }> = []
  let failures = 0
  for (const c of candidates) {
    const res = await reapGcEntry(c.entry, {
      ...(values.pause ? { pause: true } : {}),
      resolveProvider: resolveProvider as unknown as (
        slug: string,
      ) => Promise<import("@agentproto/runtime").SandboxGcProviderHandle | null>,
    })
    const record = res.ok
      ? { sandboxId: c.entry.sandboxId, ok: true, action: res.action }
      : { sandboxId: c.entry.sandboxId, ok: false, error: res.error }
    results.push(record)
    if (!res.ok) {
      failures++
      if (!values.json) process.stderr.write(`agentproto sandbox gc: ${res.error}\n`)
    } else if (!values.json) {
      process.stdout.write(
        `sandbox ${c.entry.sandboxId} ${res.action === "paused" ? "paused" : "stopped"} (session ${c.entry.originSessionId} ${c.sessionStatus})\n`,
      )
    }
  }
  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          candidates: candidates.map(c => ({
            sandboxId: c.entry.sandboxId,
            provider: c.entry.provider,
            state: c.entry.state,
            originSessionId: c.entry.originSessionId,
            sessionStatus: c.sessionStatus,
          })),
          applied: true,
          results,
        },
        null,
        2,
      ) + "\n",
    )
    return failures > 0 ? 1 : 0
  }
  return failures > 0 ? 1 : 0
}

async function runAttach(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      "config-json": { type: "string" },
      "keep-alive": { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const provider = positionals[0]
  const sandboxId = positionals[1]
  if (!provider || !sandboxId) {
    process.stderr.write(
      "agentproto sandbox attach: missing <provider> and/or <sandboxId>.\n" +
        "  Try: agentproto sandbox attach box bx_abc123\n",
    )
    return 2
  }

  let config: Record<string, unknown> | undefined
  if (values["config-json"]) {
    try {
      config = JSON.parse(values["config-json"]) as Record<string, unknown>
    } catch (err) {
      process.stderr.write(
        `agentproto sandbox attach: --config-json is not valid JSON — ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      )
      return 2
    }
  }

  const result = await attachSandbox({
    provider,
    sandboxId,
    ...(config ? { config } : {}),
    ...(values["keep-alive"] ? { keepAlive: true } : {}),
  })

  if (!result.ok) {
    process.stderr.write(`agentproto sandbox attach: ${result.message}\n`)
    return 1
  }

  const mcpConfig = buildMcpConfigSnippet(result.descriptor)

  if (values.json) {
    process.stdout.write(JSON.stringify({ descriptor: result.descriptor, mcpConfig }, null, 2) + "\n")
    return 0
  }

  process.stdout.write(
    `sandbox attached  provider=${result.descriptor.provider}  sandboxId=${result.descriptor.sandboxId}\n` +
      `  mcpUrl      ${result.descriptor.mcpUrl}\n` +
      `  token       ${result.descriptor.token ? "•".repeat(8) + " (gated)" : "—"}\n` +
      `  allowOrigin ${result.descriptor.allowOrigin}\n` +
      `  keepAlive   ${result.descriptor.keepAlive ? "yes (pinned no-auto-stop)" : "no"}\n\n` +
      `Paste into .mcp.json:\n${JSON.stringify(mcpConfig, null, 2)}\n`,
  )
  return 0
}
