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
  MARKER,
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
  /** Injected `gh` runner; defaults to a real subprocess spawn. */
  run?: GhRunner
  /** Host label for the footer; defaults to `os.hostname()`. */
  host?: string
}

export type StampOutcome =
  | { stamped: false; reason: string }
  | { stamped: true; url: string; number: number; sessionId: string; alreadyStamped: boolean }

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

    const session = pickExecutorSession(input.registry.list(), input.cwd)
    if (!session) return { stamped: false, reason: "no executor session to attribute" }

    const supervisor =
      session.parentSessionId != null
        ? input.registry.get(session.parentSessionId) ?? { id: session.parentSessionId }
        : null

    const footer = buildSessionPrFooter(session, {
      supervisor,
      host: input.host ?? hostname(),
      sha: undefined,
    })

    const run = input.run ?? defaultGhRunner
    // Read the current body so the footer is APPENDED, not clobbered. `gh pr
    // edit --body` replaces the whole body, so we must round-trip it — and if
    // the read fails we must NOT edit, or we'd overwrite the real body with
    // just the footer.
    const view = await run(["pr", "view", created.url, "--json", "body", "--jq", ".body"], input.cwd)
    if (view.exitCode !== 0) return { stamped: false, reason: `gh pr view exit ${view.exitCode}` }
    const body = view.stdout.replace(/\n+$/, "")

    const alreadyStamped = body.includes(MARKER)
    if (!alreadyStamped) {
      const newBody = appendFooterOnce(body, footer)
      const edit = await run(["pr", "edit", created.url, "--body", newBody], input.cwd)
      if (edit.exitCode !== 0) {
        return { stamped: false, reason: `gh pr edit exit ${edit.exitCode}` }
      }
    }

    // Record the opened PR against the executor session (idempotent per URL).
    input.registry.recordOpenedPr(session.id, {
      adapter: session.harness ?? session.adapterSlug ?? "gh",
      number: created.number,
      url: created.url,
    })

    return { stamped: true, url: created.url, number: created.number, sessionId: session.id, alreadyStamped }
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
