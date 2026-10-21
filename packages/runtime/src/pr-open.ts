/**
 * Daemon-side `pr_open` — open a PR on behalf of a SANDBOX session.
 *
 * Boxes (E2B, computer) have no `gh` and never get a GitHub token — they
 * push their work branch (`sandboxDeliveryTarget.branch` via
 * `sandbox-delivery.ts`) and stop. Today the host's orchestrator session
 * then runs `gh pr create` itself, so the provenance footer credits the
 * ORCHESTRATOR: its model, its wallet, its cumulative cost — none of which
 * is the PR's. This module lets the daemon open that PR against the branch
 * a named authoring session pushed, using the HOST's `gh` (full token,
 * never exposed to the box), and attribute the provenance to the right
 * sessions:
 *
 *   - the branch's authoring sessions ("Authored by", each with its own
 *     model/wallet/box provider and per-session cost — registry sessions on
 *     the branch plus `Agentproto-Session:` trailers on the PR's commits,
 *     resolved by `stampFooterOnPr` via `collectBranchAuthors`);
 *   - the opener, as reported by the caller ("Opened by") — usually the
 *     orchestrator session that invoked `pr_open`, shown for what it IS;
 *   - cost rendered is the AUTHORS' spend, never the opener's ledger.
 *
 * The `gh` runner is injected so tests drive everything without `gh`.
 */

import { parseGhPrCreate, type FooterSession } from "./pr-provenance.js"
import { stampFooterOnPr, defaultGhRunner, type GhRunner } from "./pr-provenance-stamp.js"

/** Registry slice `openPrForSession` needs — the full `SessionsRegistry`
 *  satisfies it structurally; a fake suffices in tests. */
export interface OpenPrRegistry {
  get(id: string): (FooterSession & { remote?: boolean }) | undefined
  list(): readonly FooterSession[]
  recordOpenedPr(sessionId: string, input: { adapter: string; number: number; url: string }): unknown
}

export interface OpenPrForSessionInput {
  /** The authoring session whose work branch the PR opens — resolves the
   *  branch from `sandboxDeliveryTarget.branch`; its `kind` must be
   *  `agent-cli`. */
  sessionId: string
  registry: OpenPrRegistry
  /** Host checkout the PR is opened against — the workspace's local repo
   *  path (a sandboxed session's own cwd lives inside its box). Required:
   *  `gh` has no session for a cwd we can't resolve. */
  workspacePath?: string
  /** PR title and body (both required — `--fill` is not supported). */
  title: string
  body: string
  /** The session that invoked the open (e.g. the orchestrator) — rendered
   *  as "Opened by" when it differs from the authoring session. */
  openedBy?: string
  /** Injected `gh` runner; defaults to the real subprocess spawn shared
   *  with the stamp lane. */
  run?: GhRunner
  host?: string
  /** Configured checkpoint ref namespace (`defaults.sandbox.checkpoint.
   *  refPrefix`), when the deployment moved it. */
  checkpointRefPrefix?: string
  /** Gate on the exact `gh` argv about to run (the MCP lane checks it
   *  against the workspace's `allowed-commands.json`). A returned string
   *  refuses the open with that reason; nothing has run yet. */
  authorizeArgs?: (args: readonly string[]) => string | undefined
}

/** The `gh` argv `openPrForSession` runs to create the PR. */
export function prCreateArgs(branch: string, title: string, body: string): string[] {
  return ["pr", "create", "--head", branch, "--title", title, "--body", body]
}

/** Descriptor slice {@link checkPrOpenScope} reads. */
export interface PrOpenScopeRow {
  id: string
  parentSessionId?: string | null
  sandboxId?: string | null
}

/**
 * Whether `callerSessionId` may open a PR for `targetId`: its own session,
 * a session on its own sandbox box, or a session it (transitively) spawned
 * through the `parentSessionId` chain. Returns the refusal reason, or
 * `undefined` when allowed. No caller id (the daemon-wide `/mcp` mount, an
 * operator lane) is not scoped, same as the other session tools.
 */
export function checkPrOpenScope(input: {
  callerSessionId?: string
  targetId: string
  rows: readonly PrOpenScopeRow[]
}): string | undefined {
  const caller = input.callerSessionId
  if (!caller || caller === input.targetId) return undefined
  const byId = new Map(input.rows.map(r => [r.id, r]))
  // Walk the target's ancestry: the caller must be on it.
  const seen = new Set<string>()
  let cursor = byId.get(input.targetId)?.parentSessionId ?? undefined
  while (cursor && !seen.has(cursor)) {
    if (cursor === caller) return undefined
    seen.add(cursor)
    cursor = byId.get(cursor)?.parentSessionId ?? undefined
  }
  const callerBox = byId.get(caller)?.sandboxId
  if (callerBox && byId.get(input.targetId)?.sandboxId === callerBox) return undefined
  return (
    `session ${caller} may only open a PR for its own session, a session on its own ` +
    `sandbox box, or a session it spawned (directly or transitively); ${input.targetId} is none of these`
  )
}

export type OpenPrForSessionOutcome =
  | { opened: true; url: string; number: number; sessionId: string; stamped: boolean }
  | { opened: false; reason: string }

/**
 * Run `gh pr create` on the host for a box session's work branch, then
 * stamp the authorship-aware provenance footer and record the PR against
 * the authoring session. Never throws — every failure returns a `{ opened:
 * false, reason }` outcome; the caller decides how to surface it.
 * Attribution is the point: boxes can't hold `gh`, so whoever runs this on
 * the host opens it AS the authoring session, not as themselves.
 */
export async function openPrForSession(input: OpenPrForSessionInput): Promise<OpenPrForSessionOutcome> {
  try {
    const desc = input.registry.get(input.sessionId)
    if (!desc) return { opened: false, reason: `session ${input.sessionId} not found` }
    if (desc.kind !== "agent-cli") {
      return { opened: false, reason: `session ${input.sessionId} is not an agent-cli session` }
    }
    const branch = desc.sandboxDeliveryTarget?.branch
    if (!branch) {
      return { opened: false, reason: `session ${input.sessionId} has no sandbox work branch to open a PR against` }
    }
    if (!input.workspacePath) {
      return { opened: false, reason: "no host checkout (workspace path) to run gh from" }
    }
    if (!input.title || !input.body) {
      return { opened: false, reason: "title and body are required" }
    }

    const run = input.run ?? defaultGhRunner
    const args = prCreateArgs(branch, input.title, input.body)
    const refused = input.authorizeArgs?.(args)
    if (refused) return { opened: false, reason: refused }
    const create = await run(args, input.workspacePath)
    if (create.exitCode !== 0) return { opened: false, reason: `gh pr create exit ${create.exitCode}` }
    const created = parseGhPrCreate("gh", args, create.stdout)
    if (!created) return { opened: false, reason: "gh pr create printed no PR url" }

    const supervisor =
      desc.parentSessionId != null
        ? (input.registry.get(desc.parentSessionId) ?? { id: desc.parentSessionId })
        : null
    const stamp = await stampFooterOnPr({
      registry: input.registry,
      session: desc,
      supervisor,
      prNumber: created.number,
      prUrl: created.url,
      cwd: input.workspacePath,
      ...(input.openedBy && input.openedBy !== desc.id ? { openedBy: input.openedBy } : {}),
      ...(input.run ? { run: input.run } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(input.checkpointRefPrefix ? { checkpointRefPrefix: input.checkpointRefPrefix } : {}),
    })
    // A stamped footer already recorded the PR; otherwise record it here so
    // a created PR is never lost to a failed footer edit.
    if (!stamp.stamped) {
      input.registry.recordOpenedPr(input.sessionId, {
        adapter: desc.harness ?? desc.adapterSlug ?? "gh",
        number: created.number,
        url: created.url,
      })
    }
    return {
      opened: true,
      url: created.url,
      number: created.number,
      sessionId: input.sessionId,
      stamped: stamp.stamped,
    }
  } catch (err) {
    return { opened: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
