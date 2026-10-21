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
import { checkpointBranchOf, checkpointRefPrefixForSession } from "./sandbox-delivery.js"
import {
  appendFooterOnce,
  buildSessionPrFooter,
  hasProvenanceFooter,
  footerHasCost,
  footerOpenedBy,
  footerSessionId,
  footerIsRicherThan,
  collectBranchAuthors,
  sessionIdsFromTrailers,
  replaceProvenanceFooter,
  parseGhPrCreate,
  pickExecutorSession,
  type FooterAuthor,
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
  /** The registered sessions. `includeArchived` returns ARCHIVED sessions
   *  too, they are omitted by default, and an archived author must still be
   *  credited with its model/wallet/cost, not reduced to a bare id. */
  list(opts?: { includeArchived?: boolean }): readonly FooterSession[]
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
  /** The daemon's GLOBAL checkpoint ref namespace
   *  (`defaults.sandbox.checkpoint.refPrefix`). The session's own per-spawn
   *  override wins over it (see `checkpointRefPrefixForSession`). */
  checkpointRefPrefix?: string
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
      ...(input.checkpointRefPrefix ? { checkpointRefPrefix: input.checkpointRefPrefix } : {}),
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
 *
 * A body that already carries a footer naming THIS session (own-footer,
 * {@link footerSessionId}) is a distinct case from a body naming a DIFFERENT
 * session: same-session attribution is always safe, whether the existing
 * footer is a prior daemon stamp or the `gh` PATH shim's own thin one
 * (gh-provenance-shim.ts — session id + adapter + model + host + cwd only,
 * NEVER cost/tokens/auth-profile, since a bare `gh` subprocess can't know
 * any of that). Before this, an own-footer body other than "not yet stamped"
 * fell all the way through to the final no-op return with no
 * `recordOpenedPr` call at all — so a PR opened via the shim (every PR a
 * local session opens through its OWN shell when `provenance.wrapGh` is on,
 * which is every adapter, not just claude-code) was NEVER recorded on
 * `openedPrs`, and the reconciler's cost-refresh (which only ever iterates
 * `openedPrs`) had nothing to find — cost/auth NEVER rendered for it, no
 * matter how many later turns learned the session's spend.
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
  /** The branch's authoring sessions, rendered as "Authored by" entries with
   *  each one's model/wallet/provider + cost (the opener's cumulative ledger
   *  is then suppressed). Defaults to the branch's registered sandboxed
   *  sessions when absent — pass `[]` to skip authorship. */
  authors?: readonly FooterAuthor[]
  /** The session that opened the PR, when it isn't `session` itself (a
   *  daemon `pr_open` on behalf of a box session). */
  openedBy?: string
  /** The configured checkpoint ref namespace (`defaults.sandbox.checkpoint.
   *  refPrefix`) the trailer read goes through; defaults to the legacy
   *  `agentproto-checkpoint/` (see `checkpointBranchOf`). When the stamped
   *  session carries its own per-spawn override, that one wins, it is the
   *  namespace its delivery actually pushed to. */
  checkpointRefPrefix?: string
  /** Sessions credited as authors whatever the branch/workspace match says
   *  (the session a PR is opened FOR). */
  extraAuthorSessionIds?: readonly string[]
  /** Re-render an ALREADY-stamped footer when the session has learned its
   *  spend since the first stamp (the first stamp lands mid-turn, before a
   *  claude-code/claude-sdk session reports any cost). Only edits when the
   *  existing footer has no amount and the fresh one does; otherwise a no-op
   *  (`stamped: true, alreadyStamped: true, refreshed: false`). */
  refresh?: boolean
}): Promise<StampOutcome> {
  try {
    const run = input.run ?? defaultGhRunner
    const view = await run(["pr", "view", input.prUrl, "--json", "body", "--jq", ".body"], input.cwd)
    if (view.exitCode !== 0) return { stamped: false, reason: `gh pr view exit ${view.exitCode}` }
    const body = view.stdout.replace(/\n+$/, "")

    let authors = input.authors
    if (!authors) {
      // `Agentproto-Session:` trailers keep a box branch attributable after
      // the registry forgot its session. Two sources: the PR's own commits
      // (teardown delivery appends a trailer-bearing provenance commit to the
      // pushed work branch - `buildProvenanceStampCommand`), and the tip of the
      // `agentproto-checkpoint/<branch>` snapshot (carries the trailer while
      // uncommitted work is still parked there). Read on every stamp, legacy
      // opener path included. Best-effort: a failed read only loses that source.
      const trailerIds = new Set<string>()
      const commits = await run(
        ["pr", "view", input.prUrl, "--json", "commits", "--jq", '.commits[] | .messageHeadline + "\\n" + .messageBody'],
        input.cwd,
      )
      if (commits.exitCode === 0) for (const id of sessionIdsFromTrailers(commits.stdout)) trailerIds.add(id)
      // Key everything off the PR's HEAD branch - the branch whose work the PR
      // actually carries - never the resolved session's own branch (a host
      // orchestrator has none; a different session may have another). The
      // session's branch is only the fallback when the head can't be read.
      const headBranch = (await prHeadBranch(run, input.prUrl, input.cwd)) ?? input.session.sandboxDeliveryTarget?.branch
      // The checkpoint ref namespace the session's delivery actually used:
      // its own per-spawn override wins over the daemon's global default.
      const refPrefix = checkpointRefPrefixForSession(input.session, input.checkpointRefPrefix)
      for (const id of await checkpointTrailerIds(run, input.prUrl, input.cwd, headBranch, refPrefix)) {
        trailerIds.add(id)
      }
      // ARCHIVED sessions are authors too: `list()` drops them by default,
      // while `get()` still resolves them, so the registry side asks for
      // them explicitly and the trailer side resolves through `get()`, which
      // is what keeps an archived author's model/wallet/cost on the footer
      // instead of a bare id.
      const registrySessions = input.registry.list({ includeArchived: true })
      const trailerSessions = [...trailerIds]
        .map(id => input.registry.get(id))
        .filter((s): s is FooterSession => s !== undefined)
      const extraSessions = (input.extraAuthorSessionIds ?? [])
        .map(id => input.registry.get(id))
        .filter((s): s is FooterSession => s !== undefined)
      const sessions = [...registrySessions, ...trailerSessions, ...extraSessions]
      authors = collectBranchAuthors(sessions, headBranch ?? "", [...trailerIds], {
        // Branch names are repo-local: scope the registry side to the PR's
        // own workspace so another workspace's same-named branch doesn't
        // contribute its session (and its cost) to this PR.
        ...(input.session.workspaceSlug ? { workspaceSlug: input.session.workspaceSlug } : {}),
        ...(input.extraAuthorSessionIds?.length ? { extraSessionIds: input.extraAuthorSessionIds } : {}),
      })
    }
    // The opener survives a re-render: the refresh pass (the reconciler's
    // cost refresh) knows the session, not who opened the PR, so the
    // existing footer's "Opened by" is carried over instead of being
    // dropped from the PR.
    const openedBy = input.openedBy ?? footerOpenedBy(body)
    const footer = buildSessionPrFooter(input.session, {
      supervisor: input.supervisor,
      host: input.host ?? hostname(),
      sha: undefined,
      ...(authors.length ? { authors } : {}),
      ...(openedBy ? { openedBy } : {}),
    })

    const alreadyStamped = hasProvenanceFooter(body)
    const ownFooter = alreadyStamped && footerSessionId(body) === input.session.id

    // Record an own-footer PR the FIRST time it's seen (not on a `refresh`
    // pass — a refresh call only ever iterates PRs the reconciler already
    // pulled from `openedPrs`, so it's already recorded and re-recording
    // would just be a wasted registry call). Attribution is safe: the
    // footer names this exact session.
    if (ownFooter && input.refresh !== true) {
      input.registry.recordOpenedPr(input.session.id, {
        adapter: input.session.harness ?? input.session.adapterSlug ?? "gh",
        number: input.prNumber,
        url: input.prUrl,
      })
    }

    if (ownFooter || (alreadyStamped && input.refresh === true)) {
      // Own-footer: upgrade whenever the fresh render carries a genuinely
      // new signal (cost/auth-profile/tokens) — covers both a first-seen
      // shim stamp learning cost immediately, and any later refresh pass.
      // A footer naming a DIFFERENT session only ever reaches here via an
      // explicit `refresh: true` call (defensive — the reconciler's own
      // `openedPrs` should never hold another session's PR); keep the
      // narrower cost-only check for that case so it stays exactly as
      // conservative as before.
      const upgrade = ownFooter ? footerIsRicherThan(footer, body) : footerHasCost(footer) && !footerHasCost(body)
      if (!upgrade) {
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

/** The PR's head branch (`headRefName`), or undefined when it can't be read. */
async function prHeadBranch(run: GhRunner, prUrl: string, cwd: string): Promise<string | undefined> {
  try {
    const head = await run(["pr", "view", prUrl, "--json", "headRefName", "--jq", ".headRefName"], cwd)
    if (head.exitCode !== 0) return undefined
    return head.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/** Session ids from the `Agentproto-Session:` trailer on the tip of the PR
 *  branch's checkpoint snapshot (`agentproto-checkpoint/<branch>`). Every
 *  failure (no checkpoint, no `gh api`, unparsable url) yields `[]`. */
async function checkpointTrailerIds(
  run: GhRunner,
  prUrl: string,
  cwd: string,
  branch: string | undefined,
  refPrefix: string | undefined,
): Promise<string[]> {
  try {
    const repo = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(prUrl)?.[1]
    if (!repo || !branch) return []
    const tip = await run(
      ["api", `repos/${repo}/commits/${checkpointBranchOf(branch, refPrefix)}`, "--jq", ".commit.message"],
      cwd,
    )
    return tip.exitCode === 0 ? sessionIdsFromTrailers(tip.stdout) : []
  } catch {
    return []
  }
}

/** Real `gh` runner — spawns `gh` with the given argv, capturing stdout. */
export const defaultGhRunner: GhRunner = async (args, cwd) => {
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
