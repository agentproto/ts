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
 *     expiry, origin session, attached sessions per the AIP-36 shared-box
 *     refcount) — `--json` for machines.
 *   - `rm` drops a LEDGER ENTRY by default; `--box` ALSO stops the box
 *     side the provider (destructive — requires `--yes` on a non-TTY, an
 *     interactive confirmation otherwise).
 *
 * `exec` runs one command in a sandbox via the RUNNING DAEMON's
 * `POST /sandboxes/exec` (the CLI twin of the `sandbox_exec` MCP tool), so
 * `--env-profile` resolves against the daemon's keychain and the secret never
 * touches this process. The exit code is the box command's exit code.
 *
 * `attach` prints the connection descriptor and a paste-ready `.mcp.json`
 * snippet. Never stops or pauses the sandbox.
 */
import { readFile } from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import { createInterface } from "node:readline/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  attachSandbox,
  buildMcpConfigSnippet,
  collectGcCandidates,
  liveSessionBoxIds,
  makeSandboxCredsStore,
  makeSandboxResolver,
  readSandboxLedger,
  recordSandboxLiveness,
  reconcileSandboxLedger,
  removeSandboxLedgerEntry,
  reapGcEntry,
  runSandboxOrphanGcPass,
  type SandboxGcLiveSession,
  type SandboxLedgerEntry,
  type SandboxOrphanCandidate,
} from "@agentproto/runtime"
import { parseDuration } from "../util/duration.js"
import { repoRootOf } from "./worktree.js"
import {
  planSandboxCheckpointGc,
  applySandboxCheckpointGc,
  renderSandboxCheckpointGcPlan,
  type SandboxCheckpointGcPlan,
  type SandboxCheckpointGcApplyResult,
} from "@agentproto/worktree"
import { discoverDaemon, httpGetJson, type DaemonDiscoveryReport } from "./_daemon-helpers.js"

const USAGE = `agentproto sandbox — connect to sandbox providers

Usage:
  agentproto sandbox list [--json] [--no-probe] [--reconcile]
  agentproto sandbox attach <provider> <sandboxId> [--config-json <json>] [--keep-alive] [--json]
  agentproto sandbox rm <sandboxId|label|id-prefix> [--box] [--yes] [--json]
  agentproto sandbox gc [--apply] [--pause] [--json]
  agentproto sandbox checkpoint-gc [--repo <dir>] [--dry-run] [--apply] [--json]
  agentproto sandbox exec <provider> [--sandbox-id <id>] [--cwd <dir>] [--timeout <dur>]
                          [--env NAME=value ...] [--env-profile NAME=<profileId> ...]
                          [--file <local>:<boxPath> ...] [--json] -- <command...>

list   Show the sandbox ledger — every box the daemon booted, reconnected
       to, paused, or stopped, with its current state and idle-expiry.
       Columns:
         LIVE  provider liveness probe result (yes/no) — the ONLY signal
               that the box still exists on its provider. STATE is what the
               daemon LAST DID and is NOT trustworthy: a provider-reaped
               box still shows paused/connected (and its app URL) until
               probed. "—" when the provider can't probe, "?" when the
               probe errored. Pass --no-probe to skip the network calls.
       --json prints the raw ledger rows (plus a "reconciled" summary when
              a reconcile pass ran). Unlike table mode, --json does NOT
              probe by default — pass --reconcile to force it.
       --reconcile  Force the provider-liveness pass (same as table mode's
                    default) even under --json, and print a summary of what
                    it found. Never tears a box down — a row the provider
                    confirms gone is only ever marked "gone" in the ledger.

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
       ORPHAN PROVIDER BOXES are reaped too: boxes the PROVIDER's control
       plane still holds (the computer controller keeps their RAM, and their
       session slots, pinned on the host) that the daemon's sandbox registry
       never knew and that no LIVE session references. A box a live session
       holds is never a candidate. With --apply they are deleted on the
       provider, forced (a stale provider-side session slot would otherwise
       make the provider refuse the destroy).

  --apply  Actually tear the boxes down (kill on the provider) and stamp
           the ledger rows "stopped".
  --pause  With --apply: PAUSE the boxes instead of killing them (keeps
           them attachable later) — note a paused e2b box still bills, so
           the default kill is usually what you want for orphans.
  --provider <slug>
           Provider whose control plane is swept for orphan boxes.
           Repeatable. Default: computer.
  --json   Print the plan / outcomes as JSON.

checkpoint-gc
       Reap stale checkpoint branches: every remote
       \`agentproto-checkpoint/<work-branch>\` ref a dead or finished session
       left behind. A ref is listed as SAFE when the work it rescued is
       provably elsewhere: the work branch's PR is merged or closed (via the
       repo's forge, when \`gh\` credentials are available), the snapshot's
       parent commit is merged or squash/patch-merged into the default
       branch, or its content is already in the remote work branch. Dry run
       (table or --json) is the default; only --apply deletes.

  --repo <dir>  Repo to run in (default: cwd's git repo). The remote to act
                on is that repo's \`origin\`.
  --apply       Delete every ref classified SAFE, re-classifying a FRESH plan
                right before the deletes (push --no-verify, hooks skipped).
  --json        Print the plan / apply outcomes as JSON.

exec   Runs ONE command inside a sandbox, through the running daemon
       (\`POST /sandboxes/exec\`, same function as the \`sandbox_exec\` MCP
       tool). Without --sandbox-id an EPHEMERAL box is booted for the command
       and always torn down after; with it, the existing box is reused and left
       as found. Everything after \`--\` is the command: a single argument is
       passed verbatim (a shell snippet), several are shell-quoted and joined.

  <provider>             Sandbox provider slug, e.g. "e2b" or "box".
  --sandbox-id <id>      Run against this existing box (default: ephemeral).
  --cwd <dir>            Working directory INSIDE the box (absolute).
  --timeout <dur>        Per-command wall clock: 500ms, 30s, 10m, 2h.
  --env NAME=value       Literal env var for this command. Repeatable.
                         WARNING: the value is on this process's command line
                         (shell history, \`ps\`) — do NOT pass secrets here;
                         use --env-profile.
  --env-profile NAME=<profileId>
                         Set NAME from the stored credential of auth profile
                         <profileId> (see the \`auth_profile_list\` MCP tool). The
                         DAEMON reads it; the value never reaches this CLI, the
                         command line, or the output (redacted if echoed).
                         Repeatable. Also covers sub-account profiles.
  --file <local>:<boxPath>
                         Upload a local file into the box (absolute <boxPath>)
                         BEFORE the command runs — use it instead of inlining a
                         big script (a command over 16 KB is rejected). Repeatable.
  --json                 Print the daemon's response as JSON instead of
                         streaming stdout/stderr.

  Exit code is the box command's own exit code (0-255). Failures that never
  produced one — no daemon, bad input, provider/profile error — exit 125 with
  the reason on stderr; usage errors exit 2.

Credentials: provider API keys (e.g. BOX_API_KEY, E2B_API_KEY) must be set
in this process's environment — same as \`agent_start.sandbox\` uses.

Examples:
  agentproto sandbox list
  agentproto sandbox attach box bx_abc123
  agentproto sandbox attach box bx_abc123 --keep-alive
  agentproto sandbox attach e2b sbx_abc123 --json
  agentproto sandbox rm my-task-label
  agentproto sandbox rm bx_abc123 --box --yes
  agentproto sandbox exec e2b --env-profile OPENAI_API_KEY=openai-main -- python run.py
  agentproto sandbox exec e2b --sandbox-id sbx_abc --file ./job.sh:/home/user/job.sh -- bash /home/user/job.sh
`

export interface SandboxGcCliDeps {
  /** Origin-session id → daemon status ("error"/"killed"/"exited"/…).
   *  Defaults to the live daemon's `GET /sessions`. */
  fetchSessionStatuses?: () => Promise<Map<string, string>>
  /** Resolves a ledger row's provider to its handle. Defaults to the
   *  local sandbox-creds store (same as `attach`). */
  resolveProvider?: SandboxGcProviderHandleResolver
  /** The daemon's live sessions (id / status / sandboxId): the boxes a LIVE
   *  session holds. A box a live session holds is never a gc candidate.
   *  Defaults to the daemon's `GET /sessions`. */
  fetchLiveSessions?: () => Promise<SandboxGcLiveSession[]>
  /** Provider slugs swept for ORPHAN boxes (boxes the provider's control
   *  plane still holds that no live session references). Defaults to
   *  {@link DEFAULT_GC_PROVIDER_SLUGS}. */
  providerSlugs?: readonly string[]
}

type SandboxGcProviderHandleResolver = (
  slug: string,
) => Promise<import("@agentproto/runtime").SandboxGcProviderHandle | null>

/** The resolver shape the runtime gc helpers take. */
type GcProviderResolver = SandboxGcProviderHandleResolver

/** Providers whose control plane can enumerate its boxes, so the gc can find
 *  the boxes the daemon's ledger never knew about. The `computer` provider is
 *  the one that pins RAM on a shared controller. */
export const DEFAULT_GC_PROVIDER_SLUGS: readonly string[] = ["computer"]

export interface SandboxExecCliDeps {
  /** Defaults to `discoverDaemon()`. */
  discover?: () => Promise<DaemonDiscoveryReport>
  /** Defaults to a Node-http POST (no response timeout: an exec can run for hours). */
  post?: (url: string, body: unknown, token?: string) => Promise<{ status: number; body: unknown }>
}

export async function runSandbox(
  args: readonly string[],
  gcDeps?: SandboxGcCliDeps,
  execDeps?: SandboxExecCliDeps,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const sub = args[0]
  if (sub === "attach") return runAttach(args.slice(1))
  if (sub === "list") return runList(args.slice(1))
  if (sub === "rm") return runRm(args.slice(1))
  if (sub === "gc") return runGc(args.slice(1), gcDeps)
  if (sub === "checkpoint-gc") return runCheckpointGc(args.slice(1))
  if (sub === "exec") return runExec(args.slice(1), execDeps)

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto sandbox: unknown subcommand "${sub}"\n` + `  Known: list, attach, rm, gc, exec\n`,
  )
  return 2
}

/** `agentproto sandbox checkpoint-gc [--repo <dir>] [--dry-run] [--apply] [--json]`.
 *  Dry run is the default; only --apply deletes, and each delete re-plans
 *  fresh so a stale plan never deletes anything. Never exits nonzero just
 *  because refs remain: only a plan that could not run does. */
export async function runCheckpointGc(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      repo: { type: "string" },
      "dry-run": { type: "boolean" },
      apply: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const repoRoot = repoRootOf(resolve(values.repo ?? process.cwd()))
  if (!repoRoot) {
    process.stderr.write("agentproto sandbox checkpoint-gc: not inside a git repository; pass --repo <dir>.\n")
    return 2
  }
  if (values.apply && values["dry-run"]) {
    process.stderr.write("agentproto sandbox checkpoint-gc: --apply and --dry-run are mutually exclusive.\n")
    return 2
  }
  let plan: SandboxCheckpointGcPlan
  try {
    plan = await planSandboxCheckpointGc({ repoRoot })
  } catch (err) {
    process.stderr.write(`agentproto sandbox checkpoint-gc: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  if (!values.apply) {
    if (values.json) process.stdout.write(JSON.stringify(plan, null, 2) + "\n")
    else process.stdout.write(renderSandboxCheckpointGcPlan(plan) + "\n")
    const safe = plan.refs.filter(e => e.verdict === "safe").length
    process.stdout.write(
      `Dry run - ${plan.refs.length} checkpoint ref(s), ${safe} safe to delete. Pass --apply to delete them.\n`,
    )
    return 0
  }
  let result: SandboxCheckpointGcApplyResult
  try {
    result = await applySandboxCheckpointGc({ repoRoot })
  } catch (err) {
    process.stderr.write(`agentproto sandbox checkpoint-gc: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  if (values.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  else {
    for (const o of result.outcomes) {
      let detail: string = o.result
      if (o.result === "deleted") detail = "deleted"
      else if (o.result === "skipped-keep") detail = `skipped (${o.verdict}: ${o.message ?? "no proof"})`
      else if (o.result === "failed") detail = `failed: ${o.message ?? "git push --delete failed"}`
      process.stdout.write(`${o.ref.padEnd(50)}  ${detail}\n`)
    }
    const deleted = result.outcomes.filter(o => o.result === "deleted").length
    const failed = result.outcomes.filter(o => o.result === "failed").length
    process.stdout.write(`\n${deleted} deleted, ${failed} failed.\n`)
  }
  return result.outcomes.some(o => o.result === "failed") ? 1 : 0
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
      reconcile: { type: "boolean" },
    },
  })
  // Table mode probes (reconciles) by default — `--no-probe` opts out.
  // `--json` used to never probe at all (a raw ledger dump); `--reconcile`
  // asks for the exact same provider-liveness pass either way, so a script
  // reading `--json` output can force a fresh reconcile instead of reading
  // whatever the ledger last happened to record.
  const shouldReconcile = values.reconcile === true || (!values.json && !values["no-probe"])
  let reconciled: Awaited<ReturnType<typeof reconcileLedger>> | undefined
  if (shouldReconcile) {
    reconciled = await reconcileLedger()
  }
  // Re-read AFTER reconciling so a row the probe just found gone shows its
  // fresh "gone" state, not the stale one read before the pass ran.
  const entries = readSandboxLedger()
  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          sandboxes: entries,
          ...(reconciled
            ? {
                reconciled: {
                  checked: reconciled.checked,
                  alive: reconciled.alive,
                  gone: reconciled.gone,
                  unknown: reconciled.unknown,
                  skipped: reconciled.skipped,
                },
              }
            : {}),
        },
        null,
        2,
      ) + "\n",
    )
    return 0
  }
  if (entries.length === 0) {
    process.stdout.write("no sandboxes in the ledger (~/.agentproto/sandboxes.json)\n")
    return 0
  }
  const liveById = new Map(
    (reconciled?.rows ?? []).map(r => [
      r.sandboxId,
      r.verdict === "alive" ? "yes" : r.verdict === "gone" ? "no" : r.verdict === "unknown" ? "?" : "—",
    ]),
  )
  const rows: Array<string[]> = [
    ["ID", "PROVIDER", "LABEL", "STATE", "LIVE", "AGE", "EXPIRES", "ORIGIN SESSION", "ATTACHED"],
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
      liveById.get(e.sandboxId) ?? "—",
      relative(e.updatedAt),
      expires,
      e.originSessionId ?? "—",
      e.attachedSessions?.length ? e.attachedSessions.join(", ") : "—",
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
 * Reconcile the ledger against the real providers — probes every row still
 * claiming to be booted/connected/paused (`SandboxProvider.probe`, the
 * provider control plane, not the box) and stamps the verdict back
 * (`reconcileSandboxLedger`, which flips a dead row to "gone" via
 * `recordSandboxLiveness`). Never tears a box down. Best-effort per row —
 * one broken provider never fails the listing.
 */
async function reconcileLedger() {
  const resolver = makeSandboxResolver(makeSandboxCredsStore())
  return reconcileSandboxLedger({
    resolveProvider: resolver,
    readLedger: readSandboxLedger,
    recordLiveness: recordSandboxLiveness,
  })
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
  // Preferred path: a control-plane destroy WITHOUT connecting. Connecting
  // to a suspended computer RESUMES it first — needing free RAM to free RAM
  // (the observed `capacity exhausted (available 511)` on `sandbox rm
  // --box`). `remove` deletes the box as-is; already-gone is success.
  if (handle.provider.remove) {
    try {
      await handle.provider.remove(entry.sandboxId)
      return undefined
    } catch (err) {
      return `removing sandbox "${entry.sandboxId}" failed — ${err instanceof Error ? err.message : String(err)}`
    }
  }
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

/** Default live-session source: the daemon's `GET /sessions` (read-only).
 *  Only the fields the gc needs: the id, the status and the box id a
 *  remote session holds. */
async function defaultFetchLiveSessions(): Promise<SandboxGcLiveSession[]> {
  const report = await discoverDaemon()
  if (!report.found) {
    throw new Error(
      "no live daemon found - sandbox gc needs the daemon to read the live sessions " +
        "(start one with `agentproto serve`, or set AGENTPROTO_DAEMON_URL).",
    )
  }
  const body = await httpGetJson<{
    sessions?: Array<{ id?: unknown; status?: unknown; sandboxId?: unknown }>
  }>(`${report.found.url}/sessions`)
  const out: SandboxGcLiveSession[] = []
  for (const s of body.sessions ?? []) {
    out.push({
      ...(typeof s.id === "string" ? { id: s.id } : {}),
      ...(typeof s.status === "string" ? { status: s.status } : {}),
      ...(typeof s.sandboxId === "string" ? { sandboxId: s.sandboxId } : {}),
    })
  }
  return out
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
      provider: { type: "string", multiple: true },
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

  // The live sessions decide what is STILL IN USE: a box a live session
  // holds is never a gc candidate, whatever the provider's control plane
  // says about it. Without them the provider sweep is SKIPPED (never delete
  // what we cannot prove is unused); the ledger pass below still runs.
  let liveSessions: SandboxGcLiveSession[] | undefined
  let liveSessionsError: string | undefined
  try {
    liveSessions = await (deps.fetchLiveSessions ?? defaultFetchLiveSessions)()
  } catch (err) {
    liveSessionsError = err instanceof Error ? err.message : String(err)
  }

  const ledger = readSandboxLedger()
  const candidates = collectGcCandidates(ledger, statuses)

  // ORPHAN boxes: the PROVIDER's control plane still holds them (and their
  // RAM), but the daemon's sandbox registry never knew them and no live
  // session references them. The ledger pass above cannot see those: the
  // provider can.
  const resolveProvider = deps.resolveProvider ?? defaultResolveProvider
  const orphanPass =
    liveSessions === undefined
      ? { candidates: [], providerErrors: [], deleted: [], failed: [] }
      : await runSandboxOrphanGcPass({
          resolveProvider: resolveProvider as unknown as GcProviderResolver,
          providerSlugs:
            values.provider && values.provider.length > 0
              ? values.provider
              : deps.providerSlugs ?? DEFAULT_GC_PROVIDER_SLUGS,
          registryBoxIds: new Set(ledger.map(e => e.sandboxId)),
          liveBoxIds: liveSessionBoxIds(liveSessions),
          apply: values.apply === true,
        })
  const orphans = orphanPass.candidates
  if (liveSessionsError !== undefined) {
    process.stderr.write(
      `agentproto sandbox gc: cannot read the live sessions - ${liveSessionsError}; ` +
        "the provider sweep is skipped (no box is deleted without knowing what is in use)\n",
    )
  }
  for (const s of orphanPass.providerErrors) {
    process.stderr.write(
      `agentproto sandbox gc: provider "${s.provider}" could not be scanned - ${s.error}\n`,
    )
  }

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
            orphans: orphans.map(o => ({
              provider: o.provider,
              boxId: o.boxId,
              state: o.state,
              reason: o.reason,
              ...(o.sessions !== undefined ? { sessions: o.sessions } : {}),
              ...(o.memoryMiB !== undefined ? { memoryMiB: o.memoryMiB } : {}),
              ...(o.ageMs !== undefined ? { ageMs: o.ageMs } : {}),
            })),
            providerErrors: orphanPass.providerErrors,
            applied: false,
            results: [],
            orphanResults: [],
          },
          null,
          2,
        ) + "\n",
      )
      return orphanPass.providerErrors.length > 0 ? 1 : 0
    }
    if (candidates.length === 0) {
      process.stdout.write(
        "no orphan sandboxes — no ledger entries have an origin session in " +
          "error/killed/exited\n",
      )
    } else {
      const rows: Array<string[]> = [["ID", "PROVIDER", "STATE", "SESSION", "STATUS"]]
      for (const c of candidates) {
        const id =
          c.entry.sandboxId.length > 20 ? `${c.entry.sandboxId.slice(0, 17)}…` : c.entry.sandboxId
        rows.push([
          id,
          c.entry.provider,
          c.entry.state,
          c.entry.originSessionId ?? "-",
          c.sessionStatus,
        ])
      }
      const header = rows[0]
      if (header) {
        const widths = header.map((_, i) => Math.max(...rows.map(r => r[i]?.length ?? 0)))
        for (const [i, row] of rows.entries()) {
          process.stdout.write(row.map((cell, j) => cell.padEnd(widths[j] ?? 0)).join("  ") + "\n")
        }
      }
      process.stdout.write(
        `\n${candidates.length} orphan sandbox(es): dry run only. Re-run with --apply to tear them down` +
          `${values.pause ? "" : " (kill is the default; pass --pause to pause instead)"}.\n`,
      )
    }
    printOrphanPlan(orphans)
    return orphanPass.providerErrors.length > 0 ? 1 : 0
  }

  const results: Array<{ sandboxId: string; ok: boolean; action?: string; error?: string }> = []
  let failures = 0
  for (const c of candidates) {
    const res = await reapGcEntry(c.entry, {
      ...(values.pause ? { pause: true } : {}),
      resolveProvider: resolveProvider as unknown as GcProviderResolver,
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
  // The orphan boxes were DELETED by the pass above (forced: a stale
  // provider-side session slot would otherwise make the provider refuse the
  // destroy and keep the RAM pinned).
  const orphanResults: Array<{ boxId: string; provider: string; ok: boolean; error?: string }> = [
    ...orphanPass.deleted.map(boxId => ({
      boxId,
      provider: orphans.find(o => o.boxId === boxId)?.provider ?? "",
      ok: true,
    })),
    ...orphanPass.failed.map(f => ({
      boxId: f.boxId,
      provider: orphans.find(o => o.boxId === f.boxId)?.provider ?? "",
      ok: false,
      error: f.error,
    })),
  ]
  for (const f of orphanPass.failed) {
    failures++
    if (!values.json) process.stderr.write(`agentproto sandbox gc: ${f.error}\n`)
  }
  if (!values.json) {
    for (const boxId of orphanPass.deleted) {
      process.stdout.write(
        `orphan box ${boxId} (${orphans.find(o => o.boxId === boxId)?.provider ?? "?"}) deleted\n`,
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
          orphans: orphans.map(o => ({
            provider: o.provider,
            boxId: o.boxId,
            state: o.state,
            reason: o.reason,
            ...(o.sessions !== undefined ? { sessions: o.sessions } : {}),
            ...(o.memoryMiB !== undefined ? { memoryMiB: o.memoryMiB } : {}),
            ...(o.ageMs !== undefined ? { ageMs: o.ageMs } : {}),
          })),
          providerErrors: orphanPass.providerErrors,
          applied: true,
          results,
          orphanResults,
        },
        null,
        2,
      ) + "\n",
    )
  }
  return failures > 0 || orphanPass.providerErrors.length > 0 ? 1 : 0
}

/** Print the orphan-box plan (dry run). The RAM the pass would free is only
 *  known when the provider reports a per-box memory; otherwise the line says
 *  so rather than guessing. */
function printOrphanPlan(orphans: readonly SandboxOrphanCandidate[]): void {
  if (orphans.length === 0) {
    process.stdout.write("no orphan provider boxes - every box the provider lists is known or in use\n")
    return
  }
  process.stdout.write("\nOrphan boxes (provider control plane):\n")
  const rows: Array<string[]> = [["BOX", "PROVIDER", "STATE", "AGE", "SESSIONS", "MEMORY", "REASON"]]
  for (const o of orphans) {
    rows.push([
      o.boxId,
      o.provider,
      o.state,
      o.ageMs !== undefined ? relativeAge(o.ageMs) : "-",
      o.sessions !== undefined ? String(o.sessions) : "-",
      o.memoryMiB !== undefined ? `${o.memoryMiB} MiB` : "-",
      o.reason,
    ])
  }
  const header = rows[0]
  if (!header) return
  const widths = header.map((_, i) => Math.max(...rows.map(r => r[i]?.length ?? 0)))
  for (const [i, row] of rows.entries()) {
    process.stdout.write(row.map((cell, j) => cell.padEnd(widths[j] ?? 0)).join("  ") + "\n")
  }
  const known = orphans.filter(o => o.memoryMiB !== undefined)
  const ram = known.reduce((sum, o) => sum + (o.memoryMiB ?? 0), 0)
  const ramNote =
    known.length === orphans.length
      ? ` about ${ram} MiB of RAM`
      : known.length > 0
        ? ` about ${ram} MiB of RAM (the provider does not report the memory of every box)`
        : " (RAM unknown - the provider does not report per-box memory)"
  process.stdout.write(
    `\n${orphans.length} orphan provider box(es)${ramNote} - dry run only. Pass --apply to delete them.\n`,
  )
}

/** Age in ms -> a short "3h"/"2d" string. */
function relativeAge(ms: number): string {
  const units: Array<[number, string]> = [
    [1000, "s"],
    [60_000, "m"],
    [3_600_000, "h"],
    [86_400_000, "d"],
  ]
  let out = `${ms}ms`
  for (const [size, unit] of units) {
    if (ms >= size) out = `${Math.round(ms / size)}${unit}`
  }
  return out
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

/** Exit code for failures that never produced the box command's own code. */
export const SANDBOX_EXEC_INFRA_EXIT = 125

const posixQuote = (arg: string): string =>
  /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`

/** `NAME=value` → [name, value], splitting at the FIRST `=`. */
function splitAssignment(raw: string): [string, string] | undefined {
  const i = raw.indexOf("=")
  if (i <= 0) return undefined
  return [raw.slice(0, i), raw.slice(i + 1)]
}

function defaultPost(
  url: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = Buffer.from(JSON.stringify(body), "utf8")
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": payload.byteLength.toString(),
    }
    if (token) headers.authorization = `Bearer ${token}`
    const lib = u.protocol === "https:" ? https : http
    const req = lib.request(u, { method: "POST", headers }, res => {
      let raw = ""
      res.setEncoding("utf8")
      res.on("data", c => (raw += c))
      res.on("end", () => {
        let parsed: unknown = raw
        try {
          parsed = JSON.parse(raw)
        } catch {
          // non-JSON error body — surfaced verbatim below
        }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

async function runExec(args: readonly string[], deps: SandboxExecCliDeps = {}): Promise<number> {
  const usage = (message: string): number => {
    process.stderr.write(
      `agentproto sandbox exec: ${message}\n` +
        "  Usage: agentproto sandbox exec <provider> [flags] -- <command...>\n",
    )
    return 2
  }

  const dashdash = args.indexOf("--")
  const flagArgs = dashdash === -1 ? [...args] : args.slice(0, dashdash)
  const commandArgs = dashdash === -1 ? [] : args.slice(dashdash + 1)

  let parsed
  try {
    parsed = parseArgs({
      args: flagArgs,
      allowPositionals: true,
      strict: true,
      options: {
        "sandbox-id": { type: "string" },
        cwd: { type: "string" },
        timeout: { type: "string" },
        env: { type: "string", multiple: true },
        "env-profile": { type: "string", multiple: true },
        file: { type: "string", multiple: true },
        json: { type: "boolean" },
      },
    })
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err))
  }
  const { values, positionals } = parsed

  const provider = positionals[0]
  if (!provider) return usage("missing <provider>.")
  if (positionals.length > 1) {
    return usage(`unexpected argument "${positionals[1]}" — put the command after \`--\`.`)
  }
  if (commandArgs.length === 0 || commandArgs.every(a => a === "")) {
    return usage("missing the command — pass it after `--`.")
  }
  const command =
    commandArgs.length === 1 ? (commandArgs[0] as string) : commandArgs.map(posixQuote).join(" ")

  const env: Record<string, string> = {}
  for (const raw of values.env ?? []) {
    const kv = splitAssignment(raw)
    if (!kv) return usage(`--env expects NAME=value, got "${raw}".`)
    env[kv[0]] = kv[1]
  }
  const envProfiles: Record<string, string> = {}
  for (const raw of values["env-profile"] ?? []) {
    const kv = splitAssignment(raw)
    if (!kv || kv[1] === "") return usage(`--env-profile expects NAME=<profileId>, got "${raw}".`)
    if (Object.hasOwn(envProfiles, kv[0])) return usage(`--env-profile ${kv[0]} given twice.`)
    envProfiles[kv[0]] = kv[1]
  }

  let timeoutMs: number | undefined
  if (values.timeout !== undefined) {
    const d = parseDuration(values.timeout, "--timeout")
    if (!d.ok) return usage(d.error)
    timeoutMs = d.ms
  }

  const files: Array<{ path: string; content: string; encoding: "base64" }> = []
  for (const raw of values.file ?? []) {
    const i = raw.lastIndexOf(":/")
    if (i <= 0) return usage(`--file expects <local>:<absolute boxPath>, got "${raw}".`)
    const local = raw.slice(0, i)
    const boxPath = raw.slice(i + 1)
    try {
      files.push({ path: boxPath, content: (await readFile(local)).toString("base64"), encoding: "base64" })
    } catch (err) {
      return usage(`--file: cannot read "${local}" — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const infra = (message: string): number => {
    process.stderr.write(`agentproto sandbox exec: ${message}\n`)
    return SANDBOX_EXEC_INFRA_EXIT
  }

  const report = await (deps.discover ?? discoverDaemon)()
  if (!report.found) {
    return infra(
      "no live daemon found — exec runs through the daemon (start one with `agentproto serve`, " +
        "or set AGENTPROTO_DAEMON_URL).",
    )
  }

  const body = {
    provider,
    command,
    ...(values["sandbox-id"] !== undefined ? { sandboxId: values["sandbox-id"] } : {}),
    ...(values.cwd !== undefined ? { cwd: values.cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(envProfiles).length > 0 ? { envProfiles } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }

  let res: { status: number; body: unknown }
  try {
    res = await (deps.post ?? defaultPost)(`${report.found.url}/sandboxes/exec`, body, report.found.token)
  } catch (err) {
    return infra(`could not reach the daemon at ${report.found.url} — ${err instanceof Error ? err.message : String(err)}`)
  }

  const payload = (res.body ?? {}) as {
    ok?: boolean
    code?: string
    message?: string
    result?: { exitCode: number; stdout: string; stderr: string }
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(res.body, null, 2) + "\n")
  }

  if (res.status === 200 && payload.ok === true && payload.result) {
    const { exitCode, stdout, stderr } = payload.result
    if (!values.json) {
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
    }
    if (exitCode === 0) return 0
    const low = exitCode & 0xff
    return low === 0 ? 1 : low
  }

  if (values.json) return SANDBOX_EXEC_INFRA_EXIT
  if (res.status === 401 || res.status === 403) {
    return infra(`the daemon rejected the request (HTTP ${res.status}) — check AGENTPROTO_DAEMON_TOKEN.`)
  }
  const reason =
    typeof payload.message === "string"
      ? `${payload.code ? `[${payload.code}] ` : ""}${payload.message}`
      : `HTTP ${res.status}: ${typeof res.body === "string" ? res.body.slice(0, 500) : JSON.stringify(res.body).slice(0, 500)}`
  return infra(reason)
}
