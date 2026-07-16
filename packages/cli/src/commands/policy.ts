/**
 * `agentproto policy <attach | status | wait | ack | ls | cancel>`
 *
 * A pure HTTP client over the daemon's `/policies` routes
 * (`packages/runtime/src/http-server.ts`) — the same
 * `CompletionPolicySupervisor` the MCP `policy_attach` / `policy_status` /
 * `policy_cancel` / `policy_ack` / `policy_list` tools drive
 * (`packages/runtime/src/orchestration-tools.ts`). Zero daemon change: this
 * file adds no route, no schema, no behaviour the engine didn't already have.
 *
 * Why this exists: the completion-policy engine (shell/judge gates, commit +
 * human-ack, retry-on-fail, DAG chaining) has been reachable over MCP and
 * REST for a while, but had no CLI surface — invisible to anyone not
 * speaking MCP, which is a real reason "attach a policy" wasn't part of
 * anyone's muscle memory. See the root `AGENTS.md` "Recipes" section for the
 * gates this makes reachable in one line (CI-status, review-accepted,
 * human-ack-before-merge).
 *
 * Flag design: the common case — one session, an optional shell gate, `then
 * emit|commit` — is one line via `--session`/`--sessions` + `-- <cmd>
 * [args...]` (same `--` argv-passthrough idiom as `sessions terminal --
 * <argv>`). The full recursive shape (fan-in `next` chains, judge-gate
 * detail) is reachable via `--attach-json <json|@file>`, which is sent as
 * the POST body verbatim — same `<field>-json <json|@file>` convention as
 * `sessions start --options-json`/`--mcp-servers-json`.
 *
 * `ack` is deliberately NOT gated in this file to an "operator-only" caller
 * check — there is no such check to add. The MCP layer's restriction (a
 * child-orchestrator scope cannot call `policy_ack`; `orchestration-tools.ts`
 * ~:1125) binds *nested* agent scopes reached over a scoped MCP session; a
 * bare CLI process holding the daemon's bearer token already has full
 * daemon-wide trust, same as every other mutating verb here (`sessions
 * stop`, `permissions approve`, …) and same as the ambient `gh` credentials
 * the root AGENTS.md was written about. Code in this file cannot tell a
 * human's shell from a delegated agent's — that attribution problem is
 * exactly what the AGENTS.md incident write-up says is unrecoverable after
 * the fact. So the boundary here is the same one AGENTS.md draws for `gh pr
 * merge`: declared, not enforced — `ack` is documented below and in the
 * command's own --help as an operator gesture a delegated session must not
 * reach for on its own initiative.
 */
import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  discoverDaemon,
  printNoDaemonError,
  httpGetJson,
  httpPostJson,
} from "./_daemon-helpers.js"
import { waitForPolicy } from "./_policy-wait.js"
import { parseDuration, type ParsedDuration } from "../util/duration.js"
import type { GateSpec, PolicyRunState } from "@agentproto/runtime"

const USAGE = `agentproto policy — attach and drive completion-policy gates

Usage:
  agentproto policy attach (--session <id> | --sessions <id,id,…>)
                           [--then emit|commit]                (default: emit)
                           [-- <gate-cmd> [args...]]            shell gate argv
                           [--gate-cwd <dir>] [--gate-timeout <duration>]
                           [--judge-adapter <slug> --judge-prompt <text>
                              [--judge-model <id>] [--judge-timeout <duration>]]
                           [--gate-json <json|@file>]           full GateSpec
                           [--commit-path <path>]... [--commit-message <text>]
                           [--ack | --no-ack]                   (default: ack)
                           [--on-fail-nudge <text>] [--on-fail-max-retries <n>]
                           [--attach-json <json|@file>]         full request body
                           [--wait] [--timeout <duration>] [--json]
  agentproto policy status <policyId> [--json]
  agentproto policy wait   <policyId> [--timeout <duration>] [--json]
  agentproto policy ack    <policyId> (--approve | --reject) [--json]
  agentproto policy ls     [--json]
  agentproto policy cancel <policyId> [--json]
  agentproto policy --help

  <duration>: bare integer = milliseconds (unchanged), or an explicit unit —
              500ms, 30s, 5m, 2h. A bare number under 1000 is rejected as an
              ambiguous units slip; say \`30s\` or \`30ms\` explicitly.

attach:
  Exactly one gate form: \`-- <cmd> [args...]\` (shell, exit 0 = pass),
  \`--judge-adapter/--judge-prompt\` (spawns a short-lived judge agent), or
  \`--gate-json\` (escape hatch for either shape verbatim). No gate at all
  means the policy passes immediately at turn-end.
  \`--then commit\` requires \`--commit-path\` (repeatable) and
  \`--commit-message\`; by default the commit parks in awaiting-ack and needs
  \`policy ack --approve\` — pass \`--no-ack\` to commit directly on a green gate.
  \`--attach-json\` sends its parsed content as the ENTIRE POST body, ignoring
  every other attach flag — the full shape (fan-in \`sessionIds\`, recursive
  \`next\` chaining, judge-gate detail) when flags would get unwieldy.
  \`--wait\` blocks (like \`policy wait\`) on the newly attached policyId before
  returning.

status vs wait:
  \`status\` is a non-blocking snapshot (composes over \`GET /policies\` — there
  is no plain \`GET /policies/:id\` route). \`wait\` long-polls
  \`GET /policies/:id/wait\` until the policy leaves watching/gating/queued/
  nudging/acting, chaining calls across the route's ~55s per-call ceiling.
  Default --timeout: 900000ms/15m (a gate can be a full test suite or a judge
  turn, not a quick check). Exit codes: 0 done/awaiting-ack, 2 blocked/
  cancelled/CLI-timeout, 3 not found/daemon too old. On CLI-timeout, the
  message states the resolved duration it waited (e.g. "timed out after
  15m") so a wrong unit is obvious rather than looking like a stuck gate.

ack:
  Operator gesture — see this file's docblock. Never invoke from a delegated
  agent session; that boundary is prose, the same one the root AGENTS.md
  draws for \`gh pr merge\`.
`

export async function runPolicy(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "attach":
      return runAttach(rest)
    case "status":
      return runStatus(rest)
    case "wait":
      return runWait(rest)
    case "ack":
      return runAck(rest)
    case "ls":
    case "list":
      return runLs(rest)
    case "cancel":
      return runCancel(rest)
    case undefined:
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto policy: unknown subcommand "${sub}"\n` +
          `  Known: attach | status | wait | ack | ls | cancel\n`,
      )
      return 2
  }
}

/** Read a `--flag <json>` / `--flag @<file>` value, per the `sessions start
 *  --options-json`/`--mcp-servers-json` convention. */
async function readJsonArg(raw: string, flagLabel: string): Promise<unknown> {
  const text = raw.startsWith("@")
    ? await readFile(resolve(raw.slice(1)), "utf8")
    : raw
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(
      `invalid ${flagLabel}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ── attach ───────────────────────────────────────────────────────────────

async function runAttach(args: readonly string[]): Promise<number> {
  // Split on `--` so `-- <gate-cmd> [args...]` is passed through verbatim,
  // matching `sessions terminal -- <argv>`.
  const sepIdx = args.indexOf("--")
  const verbArgs = sepIdx === -1 ? [...args] : args.slice(0, sepIdx)
  const gateArgv = sepIdx === -1 ? [] : args.slice(sepIdx + 1)

  const { values } = parseArgs({
    args: verbArgs,
    allowPositionals: false,
    strict: true,
    options: {
      session: { type: "string" },
      sessions: { type: "string" },
      then: { type: "string" },
      "gate-cwd": { type: "string" },
      "gate-timeout": { type: "string" },
      "judge-adapter": { type: "string" },
      "judge-model": { type: "string" },
      "judge-prompt": { type: "string" },
      "judge-timeout": { type: "string" },
      "gate-json": { type: "string" },
      "commit-path": { type: "string", multiple: true },
      "commit-message": { type: "string" },
      ack: { type: "boolean" },
      "no-ack": { type: "boolean" },
      "on-fail-nudge": { type: "string" },
      "on-fail-max-retries": { type: "string" },
      "attach-json": { type: "string" },
      wait: { type: "boolean" },
      timeout: { type: "string" },
      json: { type: "boolean" },
    },
  })

  const fail = (msg: string): number => {
    process.stderr.write(`agentproto policy attach: ${msg}\n`)
    return 2
  }

  let body: Record<string, unknown>

  if (values["attach-json"] !== undefined) {
    let parsed: unknown
    try {
      parsed = await readJsonArg(values["attach-json"], "--attach-json")
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("--attach-json must be a JSON object (the full policy_attach body)")
    }
    body = parsed as Record<string, unknown>
  } else {
    // ── session targeting ──
    if (!values.session && !values.sessions) {
      return fail(
        "missing --session <id> or --sessions <id,id,…>.\n" +
          "  Try: agentproto policy attach --session <id> --then emit -- pnpm test",
      )
    }
    const sessionIds = values.sessions
      ? values.sessions.split(",").map(s => s.trim()).filter(Boolean)
      : undefined
    if (values.sessions && sessionIds!.length === 0) {
      return fail("--sessions must list at least one non-empty id")
    }

    // ── then ──
    const then = values.then ?? "emit"
    if (then !== "emit" && then !== "commit") {
      return fail(`invalid --then "${then}" (expected emit or commit)`)
    }

    // ── gate ──
    const gateForms = [
      values["gate-json"] !== undefined,
      values["judge-adapter"] !== undefined || values["judge-prompt"] !== undefined,
      gateArgv.length > 0,
    ].filter(Boolean).length
    if (gateForms > 1) {
      return fail(
        "specify at most one gate form: --gate-json, --judge-adapter/--judge-prompt, or -- <cmd>",
      )
    }
    const hasShellGate = gateArgv.length > 0
    if ((values["gate-cwd"] || values["gate-timeout"]) && !hasShellGate) {
      return fail("--gate-cwd/--gate-timeout require a shell gate (pass -- <cmd> ...)")
    }

    let gate: GateSpec | undefined
    if (values["gate-json"] !== undefined) {
      let parsed: unknown
      try {
        parsed = await readJsonArg(values["gate-json"], "--gate-json")
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
      if (!parsed || typeof parsed !== "object") {
        return fail("--gate-json must be a JSON object")
      }
      gate = parsed as GateSpec
    } else if (values["judge-adapter"] !== undefined || values["judge-prompt"] !== undefined) {
      if (!values["judge-adapter"] || !values["judge-prompt"]) {
        return fail("--judge-adapter and --judge-prompt are both required for a judge gate")
      }
      let judgeTimeout: number | undefined
      if (values["judge-timeout"]) {
        const parsed = parseDuration(values["judge-timeout"], "--judge-timeout")
        if (!parsed.ok) return fail(parsed.error)
        judgeTimeout = parsed.ms
      }
      gate = {
        judge: {
          adapter: values["judge-adapter"],
          prompt: values["judge-prompt"],
          ...(values["judge-model"] ? { model: values["judge-model"] } : {}),
          ...(judgeTimeout !== undefined ? { timeoutMs: judgeTimeout } : {}),
        },
      }
    } else if (hasShellGate) {
      let gateTimeout: number | undefined
      if (values["gate-timeout"]) {
        const parsed = parseDuration(values["gate-timeout"], "--gate-timeout")
        if (!parsed.ok) return fail(parsed.error)
        gateTimeout = parsed.ms
      }
      gate = {
        command: gateArgv[0]!,
        ...(gateArgv.length > 1 ? { args: gateArgv.slice(1) } : {}),
        ...(values["gate-cwd"] ? { cwd: resolve(values["gate-cwd"]) } : {}),
        ...(gateTimeout !== undefined ? { timeoutMs: gateTimeout } : {}),
      }
    }

    // ── commit ──
    const commitPaths = values["commit-path"]
    const commitMessage = values["commit-message"]
    if (then === "commit") {
      if (!commitPaths || commitPaths.length === 0 || !commitMessage) {
        return fail(
          '--then commit requires --commit-path <path> (repeatable) and --commit-message <text>',
        )
      }
    } else if (commitPaths || commitMessage || values.ack || values["no-ack"]) {
      return fail("--commit-path/--commit-message/--ack/--no-ack only apply with --then commit")
    }
    if (values.ack && values["no-ack"]) {
      return fail("--ack and --no-ack are mutually exclusive")
    }

    // ── onFail ──
    const onFailNudge = values["on-fail-nudge"]
    const onFailMaxRetries = values["on-fail-max-retries"]
      ? Number.parseInt(values["on-fail-max-retries"], 10)
      : undefined
    if (
      onFailMaxRetries !== undefined &&
      (!Number.isFinite(onFailMaxRetries) || onFailMaxRetries < 1)
    ) {
      return fail(`invalid --on-fail-max-retries "${values["on-fail-max-retries"]}"`)
    }
    const onFail =
      onFailNudge !== undefined || onFailMaxRetries !== undefined
        ? {
            ...(onFailNudge !== undefined ? { nudge: onFailNudge } : {}),
            ...(onFailMaxRetries !== undefined ? { maxRetries: onFailMaxRetries } : {}),
          }
        : undefined

    body = {
      ...(sessionIds ? { sessionIds } : { sessionId: values.session }),
      ...(gate ? { gate } : {}),
      then,
      ...(then === "commit"
        ? {
            commit: {
              paths: commitPaths,
              message: commitMessage,
              requireHumanAck: !values["no-ack"],
            },
          }
        : {}),
      ...(onFail ? { onFail } : {}),
    }
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto policy attach")
    return 3
  }
  const endpoint = report.found

  let state: PolicyRunState
  try {
    state = await httpPostJson<PolicyRunState>(`${endpoint.url}/policies`, body, endpoint.token)
  } catch (err) {
    process.stderr.write(`agentproto policy attach: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (!values.wait) {
    return printPolicyResult(state, Boolean(values.json), "attach")
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(state, null, 2) + "\n")
  } else {
    process.stdout.write(`agentproto policy attach: ${state.policyId} → ${state.status}\n`)
  }
  const parsedTimeout = resolveTimeout(values.timeout, 900_000)
  if (!parsedTimeout.ok) return fail(parsedTimeout.error)
  return waitForPolicy({
    endpoint,
    policyId: state.policyId,
    totalTimeoutMs: parsedTimeout.ms,
    json: Boolean(values.json),
    verb: "agentproto policy attach",
  })
}

function printPolicyResult(state: PolicyRunState, json: boolean, verb: string): number {
  if (json) {
    process.stdout.write(JSON.stringify(state, null, 2) + "\n")
  } else {
    process.stdout.write(`agentproto policy ${verb}: ${state.policyId} → ${state.status}\n`)
  }
  return 0
}

/** Resolve `--timeout <duration>` against a fallback default, via the shared
 *  parser — bare = ms unchanged, explicit `500ms`/`30s`/`5m`/`2h`, sub-1000
 *  bare numbers rejected as an ambiguous units slip. */
function resolveTimeout(raw: string | undefined, fallback: number): ParsedDuration {
  if (!raw) return { ok: true, ms: fallback }
  return parseDuration(raw, "--timeout")
}

// ── status ───────────────────────────────────────────────────────────────

async function runStatus(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const policyId = positionals[0]
  if (!policyId) {
    process.stderr.write("agentproto policy status: missing <policyId>.\n  Try: agentproto policy ls\n")
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto policy status")
    return 3
  }

  // No plain GET /policies/:id route exists (only list/wait/cancel/ack) —
  // a non-blocking snapshot composes over the list route rather than
  // borrowing /wait's 1000ms-minimum timeout floor, which would make a pure
  // status check block for up to a second on a still-running policy.
  let listBody: { policies: PolicyRunState[] }
  try {
    listBody = await httpGetJson<{ policies: PolicyRunState[] }>(`${report.found.url}/policies`)
  } catch (err) {
    process.stderr.write(`agentproto policy status: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  const state = listBody.policies.find(p => p.policyId === policyId)
  if (!state) {
    process.stderr.write(`agentproto policy status: no policy "${policyId}".\n`)
    return 3
  }
  return printPolicyResult(state, Boolean(values.json), "status")
}

// ── wait ───────────────────────────────────────────────────────────────

async function runWait(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { timeout: { type: "string" }, json: { type: "boolean" } },
  })
  const policyId = positionals[0]
  if (!policyId) {
    process.stderr.write("agentproto policy wait: missing <policyId>.\n  Try: agentproto policy ls\n")
    return 2
  }
  const parsedTimeout = resolveTimeout(values.timeout, 900_000)
  if (!parsedTimeout.ok) {
    process.stderr.write(`agentproto policy wait: ${parsedTimeout.error}\n`)
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto policy wait")
    return 3
  }

  return waitForPolicy({
    endpoint: report.found,
    policyId,
    totalTimeoutMs: parsedTimeout.ms,
    json: Boolean(values.json),
    verb: "agentproto policy wait",
  })
}

// ── ack ───────────────────────────────────────────────────────────────

async function runAck(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      approve: { type: "boolean" },
      reject: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const policyId = positionals[0]
  if (!policyId) {
    process.stderr.write("agentproto policy ack: missing <policyId>.\n  Try: agentproto policy ls\n")
    return 2
  }
  if (values.approve === values.reject) {
    // Both false (neither given) or both true (both given) — either way,
    // an explicit, unambiguous decision is required. This is a host commit;
    // there is no sensible default to fall back on.
    process.stderr.write(
      "agentproto policy ack: pass exactly one of --approve or --reject.\n",
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto policy ack")
    return 3
  }
  const endpoint = report.found

  let result: { policyId: string; status: string; sha?: string; error?: string }
  try {
    result = await httpPostJson(
      `${endpoint.url}/policies/${encodeURIComponent(policyId)}/ack`,
      { approve: values.approve === true },
      endpoint.token,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(`agentproto policy ack: no policy "${policyId}".\n`)
      return 3
    }
    process.stderr.write(`agentproto policy ack: ${msg}\n`)
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  } else {
    process.stdout.write(
      `agentproto policy ack: ${result.policyId} → ${result.status}` +
        `${result.sha ? ` (${result.sha.slice(0, 10)})` : ""}` +
        `${result.error ? ` — ${result.error}` : ""}\n`,
    )
  }
  return result.error ? 1 : 0
}

// ── ls ───────────────────────────────────────────────────────────────

async function runLs(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto policy ls")
    return 3
  }

  let body: { policies: PolicyRunState[] }
  try {
    body = await httpGetJson<{ policies: PolicyRunState[] }>(`${report.found.url}/policies`)
  } catch (err) {
    process.stderr.write(`agentproto policy ls: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  const policies = body.policies ?? []

  if (values.json) {
    process.stdout.write(JSON.stringify(policies, null, 2) + "\n")
    return 0
  }
  if (policies.length === 0) {
    process.stdout.write("No policies.\n")
    return 0
  }
  process.stdout.write(
    `${"POLICY".padEnd(14)}  ${"STATUS".padEnd(13)}  ${"SESSIONS".padEnd(10)}  STARTED\n`,
  )
  for (const p of policies) {
    process.stdout.write(
      `${p.policyId.padEnd(14)}  ${p.status.padEnd(13)}  ${String(p.sessionIds.length).padEnd(10)}  ${p.startedAt}\n`,
    )
  }
  return 0
}

// ── cancel ───────────────────────────────────────────────────────────────

async function runCancel(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const policyId = positionals[0]
  if (!policyId) {
    process.stderr.write("agentproto policy cancel: missing <policyId>.\n  Try: agentproto policy ls\n")
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto policy cancel")
    return 3
  }
  const endpoint = report.found

  let result: { policyId: string; status: string }
  try {
    result = await httpPostJson(
      `${endpoint.url}/policies/${encodeURIComponent(policyId)}/cancel`,
      {},
      endpoint.token,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 404/.test(msg)) {
      process.stderr.write(`agentproto policy cancel: no policy "${policyId}".\n`)
      return 3
    }
    process.stderr.write(`agentproto policy cancel: ${msg}\n`)
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  } else {
    process.stdout.write(`agentproto policy cancel: ${result.policyId} → ${result.status}\n`)
  }
  return 0
}
