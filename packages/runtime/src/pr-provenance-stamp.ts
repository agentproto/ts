/**
 * Daemon-lane PR provenance STAMPER.
 *
 * When an executor agent-cli session opens a PR through the daemon's
 * `command_execute` → `gh pr create` path (how sessions spawned via
 * `agent_start` open PRs), no CI runner is around to stamp the provenance
 * footer the way `scripts/stamp-pr-footer.mjs` does for the CI lane. This
 * closes that gap: the daemon itself stamps the SAME footer
 * (`@agentproto-bot`, see `pr-provenance.ts`) onto the just-created PR body,
 * built from the executor session + its supervisor, and records the opened
 * PR against that session (`recordOpenedPr`).
 *
 * The runner owns the footer — never the model — so this runs as a
 * post-command side effect the agent can't influence, and it is strictly
 * best-effort: a missing `gh`, an un-authed host, a lost network reply must
 * never turn a green `command_execute` red. Every failure is swallowed into
 * the returned {@link StampOutcome} for logging, never thrown.
 *
 * The pure decisions (is this a `gh pr create`? which session? what footer?
 * append-once) live in `pr-provenance.ts` and are unit-tested there; this
 * module is only the I/O wiring, with the `gh` runner injected so it can be
 * driven with a fake in tests.
 */

import { hostname } from "node:os"
import {
  appendFooterOnce,
  buildSessionPrFooter,
  hasProvenanceFooter,
  footerHasCost,
  replaceProvenanceFooter,
  parseGhPrCreate,
  pickExecutorSession,
  type FooterSession,
} from "./pr-provenance.js"

/** A minimal `gh` runner — resolves with the captured exit code + stdout.
 *  Injected so tests drive stamping without spawning a real `gh`. */
export type GhRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string }>

/** The slice of `SessionsRegistry` this stamper touches — kept structural so
 *  the module doesn't drag the full registry type (and its imports) in. */
export interface StampRegistry {
  list(): readonly FooterSession[]
  get(id: string): FooterSession | undefined
  recordOpenedPr(sessionId: string, input: { adapter: string; number: number; url: string }): unknown
}

export interface StampPrInput {
  command: string
  args: readonly string[]
  cwd: string
  exitCode: number
  stdout: string
  registry: StampRegistry
  /** The session that actually issued this `command_execute` call, when the
   *  daemon genuinely knows it (`RegisterCommandToolsOptions.callerSessionId`
   *  — PR 7 / Gap 7 provenance, threaded from the request's own
   *  `?callerSessionId=`). When present this is the authoritative
   *  attribution and wins over the {@link pickExecutorSession} guess below —
   *  it names the exact session, not a same-cwd sibling. Absent for a call
   *  arriving through the shared daemon-wide `/mcp` mount (no per-caller
   *  binding), in which case the heuristic is the only option. */
  callerSessionId?: string
  /** Injected `gh` runner; defaults to a real subprocess spawn. */
  run?: GhRunner
  /** Host label for the footer; defaults to `os.hostname()`. */
  host?: string
}

export type StampOutcome =
  | { stamped: false; reason: string }
  | {
      stamped: true
      url: string
      number: number
      sessionId: string
      alreadyStamped: boolean
      /** True when an existing footer was re-rendered (refresh mode) — see
       *  {@link replaceProvenanceFooter}. */
      refreshed?: boolean
    }

/**
 * Inspect a completed `command_execute` run and, if it was a successful
 * `gh pr create` attributable to an executor session, stamp the provenance
 * footer onto the created PR and record it. Returns a structured outcome for
 * the caller to log; never throws.
 */
export async function stampPrProvenance(input: StampPrInput): Promise<StampOutcome> {
  try {
    if (input.exitCode !== 0) return { stamped: false, reason: "command failed" }
    const created = parseGhPrCreate(input.command, input.args, input.stdout)
    if (!created) return { stamped: false, reason: "not a gh pr create" }

    // Prefer the exact calling session over the cwd-guess: a `callerSessionId`
    // names the session that issued THIS command_execute call, so it can't be
    // fooled by an unrelated sibling session that merely happens to share (or
    // contain) the same cwd — the failure mode that misattributed a PR to a
    // live-but-unrelated benchmark session sharing the workspace root.
    const session =
      (input.callerSessionId ? input.registry.get(input.callerSessionId) : undefined) ??
      pickExecutorSession(input.registry.list(), input.cwd)
    if (!session) return { stamped: false, reason: "no executor session to attribute" }

    const supervisor =
      session.parentSessionId != null
        ? input.registry.get(session.parentSessionId) ?? { id: session.parentSessionId }
        : null

    return await stampFooterOnPr({
      registry: input.registry,
      session,
      supervisor,
      prNumber: created.number,
      prUrl: created.url,
      cwd: input.cwd,
      ...(input.run ? { run: input.run } : {}),
      ...(input.host ? { host: input.host } : {}),
    })
  } catch (err) {
    return { stamped: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The tool-agnostic core: given an already-resolved PR (its number + url) and
 * the executor session (+ supervisor) it belongs to, append the provenance
 * footer to the PR body once and record the PR against the session. Shared by
 * {@link stampPrProvenance} (which resolves the PR from a `gh pr create`
 * stdout) and the daemon reconciler (which resolves it from the session's
 * branch). Reads the current body first so the footer is APPENDED, not
 * clobbered — `gh pr edit --body` replaces the whole body — and never edits
 * when the read fails, so a failed read can't overwrite a real body with just
 * the footer. Idempotent by the rendered-footer guard ({@link
 * hasProvenanceFooter} — a body that merely MENTIONS the marker in prose
 * still gets its footer); never throws (every failure is swallowed into the
 * returned {@link StampOutcome}).
 */
export async function stampFooterOnPr(input: {
  registry: StampRegistry
  session: FooterSession
  supervisor: { id: string } | null
  prNumber: number
  prUrl: string
  cwd: string
  run?: GhRunner
  host?: string
  /** Re-render an ALREADY-stamped footer when the session has learned its
   *  spend since the first stamp (the first stamp lands mid-turn, before a
   *  claude-code/claude-sdk session reports any cost). Only edits when the
   *  existing footer has no amount and the fresh one does; otherwise a no-op
   *  (`stamped: true, alreadyStamped: true, refreshed: false`). */
  refresh?: boolean
}): Promise<StampOutcome> {
  try {
    const footer = buildSessionPrFooter(input.session, {
      supervisor: input.supervisor,
      host: input.host ?? hostname(),
      sha: undefined,
    })

    const run = input.run ?? defaultGhRunner
    const view = await run(["pr", "view", input.prUrl, "--json", "body", "--jq", ".body"], input.cwd)
    if (view.exitCode !== 0) return { stamped: false, reason: `gh pr view exit ${view.exitCode}` }
    const body = view.stdout.replace(/\n+$/, "")

    const alreadyStamped = hasProvenanceFooter(body)
    if (alreadyStamped && input.refresh === true) {
      if (footerHasCost(body) || !footerHasCost(footer)) {
        return { stamped: true, url: input.prUrl, number: input.prNumber, sessionId: input.session.id, alreadyStamped, refreshed: false }
      }
      const refreshedBody = replaceProvenanceFooter(body, footer)
      const edit = await run(["pr", "edit", input.prUrl, "--body", refreshedBody], input.cwd)
      if (edit.exitCode !== 0) return { stamped: false, reason: `gh pr edit exit ${edit.exitCode}` }
      return { stamped: true, url: input.prUrl, number: input.prNumber, sessionId: input.session.id, alreadyStamped, refreshed: true }
    }
    if (!alreadyStamped) {
      const newBody = appendFooterOnce(body, footer)
      const edit = await run(["pr", "edit", input.prUrl, "--body", newBody], input.cwd)
      if (edit.exitCode !== 0) {
        return { stamped: false, reason: `gh pr edit exit ${edit.exitCode}` }
      }
      // Record the opened PR against the executor session (idempotent per
      // URL) — but ONLY on a real stamp. An already-marked body means the PR
      // was already attributed to its rightful session; recording it here too
      // would misattribute it onto whichever session happened to re-resolve
      // the same PR (e.g. the reconciler polling a shared cwd).
      input.registry.recordOpenedPr(input.session.id, {
        adapter: input.session.harness ?? input.session.adapterSlug ?? "gh",
        number: input.prNumber,
        url: input.prUrl,
      })
    }

    return {
      stamped: true,
      url: input.prUrl,
      number: input.prNumber,
      sessionId: input.session.id,
      alreadyStamped,
    }
  } catch (err) {
    return { stamped: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Real `gh` runner — spawns `gh` with the given argv, capturing stdout. */
const defaultGhRunner: GhRunner = async (args, cwd) => {
  const { spawn } = await import("node:child_process")
  return await new Promise(resolve => {
    let stdout = ""
    const child = spawn("gh", [...args], { cwd, shell: false })
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8")
    })
    child.on("error", () => resolve({ exitCode: 1, stdout }))
    child.on("close", code => resolve({ exitCode: code ?? 1, stdout }))
  })
}
