/**
 * PR provenance footer — daemon/MCP lane.
 *
 * This is the SAME footer the runner-side agentflow scripts stamp on the
 * CI-PR, review, and local-`gh_open_pr` lanes; `scripts/lib/provenance-
 * footer.mjs` re-exports {@link buildFooter}/{@link MARKER}/{@link fmtTokens}
 * from HERE so there is exactly one format, one marker, one renderer. The
 * only reason this canonical copy lives in `@agentproto/runtime` rather than
 * in `scripts/` is direction of dependency: the daemon is a package and
 * cannot import a loose script, but a script can import a package's built
 * `dist/` (it already does for `computeProvenance`).
 *
 * What the DAEMON lane adds over the runner lanes: the footer is built from
 * a live {@link SessionDescriptor} (the executor agent-cli session that ran
 * `gh pr create`) plus its supervisor/parent session, rather than from a
 * `computeProvenance` join over the worktree. So this file also owns the
 * mapping from a session descriptor to the footer's provenance shape
 * ({@link sessionFooterProvenance}) and the small pure helpers the
 * command_execute stamp path needs ({@link parseGhPrCreate},
 * {@link pickExecutorSession}, {@link appendFooterOnce}).
 *
 * Pure by construction — only `node:path`, no daemon imports, no I/O — so it
 * bundles to a standalone `dist/pr-provenance.mjs` the scripts can import
 * without pulling the rest of the runtime in. Keep it that way. The
 * side-effecting orchestration (spawning `gh`, editing the PR body, recording
 * the opened PR) lives in `pr-provenance-stamp.ts`.
 */

import { basename } from "node:path"

/** Deterministic marker the runner owns — a reliable native-vs-legacy
 *  discriminator across every lane (CI-PR, review, local, daemon). */
export const MARKER = "@agentproto-bot"

export const fmtTokens = (n: unknown): string | null => {
  if (typeof n !== "number" || !Number.isFinite(n)) return null
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** The footer's provenance shape — field names are the renderer's, not the
 *  session registry's (see {@link sessionFooterProvenance} for the mapping). */
export interface FooterProvenance {
  sessionId?: string
  label?: string
  /** Adapter / harness slug that ran ("claude-code", "codex", …). */
  adapter?: string
  model?: string
  /** Bound auth-profile IDENTITY — a label or ref, NEVER the credential. */
  authProfile?: string
  sandboxId?: string
  /** Supervisor / parent session that spawned the executor. */
  parentSessionId?: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  /** "adapter" | "local" | "daemon" — drives host/cwd vs run-link rendering. */
  source?: string
  host?: string
  cwd?: string
  /** The session's registered workspace slug (`SessionDescriptor.workspaceSlug`,
   *  e.g. "ts", "default"). Rendered alongside `cwd`'s leaf directory name so
   *  the footer identifies WHICH workspace ran the command, not just an
   *  arbitrary trailing path segment — a bare `basename(cwd)` reads as
   *  meaningless (or actively misleading) when the session's cwd is a
   *  workspace root rather than a per-branch worktree. */
  workspaceSlug?: string
}

/**
 * Render the footer's `cwd` value. A bare `basename(cwd)` collapses to a
 * meaningless (or actively misleading) fragment whenever the session's cwd IS
 * the workspace root rather than a per-branch worktree dir — e.g. a checkout
 * literally named `ts` renders as the opaque `cwd \`ts\`` with no indication
 * that's a workspace name, not a worktree/branch leaf. Prefixing the
 * registered workspace slug disambiguates it, and is dropped when it's
 * identical to the leaf (the common per-worktree case) so the common case
 * stays exactly as compact as before.
 */
function cwdLabel(cwd: string, workspaceSlug?: string): string {
  const leaf = basename(cwd)
  if (!workspaceSlug || workspaceSlug === leaf) return workspaceSlug ?? leaf
  return `${workspaceSlug}/${leaf}`
}

export interface BuildFooterInput {
  prov?: FooterProvenance
  authMode?: string
  runId?: string
  runUrl?: string
  sha?: string
  kind?: string
}

export const buildFooter = ({
  prov,
  authMode,
  runId,
  runUrl,
  sha,
  kind = "review",
}: BuildFooterInput): string => {
  const parts = [`🤖 **${MARKER}** — ${kind}`]
  if (prov?.sessionId) {
    parts.push(`session \`${prov.sessionId}\`${prov.label ? ` (\`${prov.label}\`)` : ""}`)
  }
  // Engine label: "adapter / authMode" when an adapter ran; "legacy fallback
  // (authMode)" when no agent session exists at all (the API-key fallback path);
  // bare authMode only if a session ran without a resolved adapter slug.
  if (prov?.adapter) parts.push([prov.adapter, authMode].filter(Boolean).join(" / "))
  else if (!prov?.sessionId) parts.push(`legacy fallback${authMode ? ` (${authMode})` : ""}`)
  else if (authMode) parts.push(authMode)
  // Bound auth profile identity (the "wallet") — daemon lane; NEVER the secret.
  if (prov?.authProfile) parts.push(`auth-profile \`${prov.authProfile}\``)
  if (prov?.model) parts.push(`model \`${prov.model}\``)
  if (prov?.sandboxId) parts.push(`e2b \`${prov.sandboxId}\``)
  if (prov?.parentSessionId) parts.push(`supervisor \`${prov.parentSessionId}\``)
  const tin = fmtTokens(prov?.tokensIn)
  const tout = fmtTokens(prov?.tokensOut)
  if (tin || tout) parts.push(`${tin ?? "?"} in / ${tout ?? "?"} out`)
  if (typeof prov?.costUsd === "number") {
    parts.push(`$${prov.costUsd.toFixed(4)}${prov.source && prov.source !== "adapter" ? ` (${prov.source})` : ""}`)
  }
  const showLocalHostCwd = prov?.source === "local" || prov?.source === "daemon" || !runId
  if (runId && !showLocalHostCwd) parts.push(`run [${runId}](${runUrl})`)
  if (showLocalHostCwd) {
    if (prov?.host) parts.push(`host \`${prov.host}\``)
    if (prov?.cwd) parts.push(`cwd \`${cwdLabel(prov.cwd, prov.workspaceSlug)}\``)
  }
  if (sha) parts.push(`sha \`${sha}\``)
  return `\n\n---\n<sub>${parts.join(" · ")}</sub>`
}

/** Structural subset of `SessionDescriptor` the footer needs. The runtime's
 *  full descriptor satisfies this; keeping it structural is what lets this
 *  module stay free of a `./sessions.js` import (and thus standalone). */
export interface FooterSession {
  id: string
  kind?: string
  status?: string
  startedAt?: string
  label?: string
  cwd?: string
  workspaceSlug?: string
  adapterSlug?: string
  harness?: string
  model?: string
  parentSessionId?: string
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  auth?: { mode?: string }
  accessProfile?: { profileRef: string; label?: string }
}

export interface SessionFooterOptions {
  /** The supervisor/parent session descriptor, when resolvable. */
  supervisor?: { id: string } | null
  host?: string
  /** Provenance source tag; defaults to "daemon". */
  source?: string
}

/**
 * Map a live executor session (+ its supervisor) onto the footer's provenance
 * shape and the `authMode` the renderer takes separately. The adapter is the
 * canonical harness slug, falling back to `adapterSlug`. The bound auth
 * profile is the profile's human label (or its ref), never the credential.
 */
export function sessionFooterProvenance(
  session: FooterSession,
  options: SessionFooterOptions = {},
): { prov: FooterProvenance; authMode: string | undefined } {
  const prov: FooterProvenance = {
    sessionId: session.id,
    label: session.label,
    adapter: session.harness ?? session.adapterSlug,
    model: session.model,
    authProfile: session.accessProfile?.label ?? session.accessProfile?.profileRef,
    parentSessionId: options.supervisor?.id,
    costUsd: session.costUsd,
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    source: options.source ?? "daemon",
    host: options.host,
    cwd: session.cwd,
    workspaceSlug: session.workspaceSlug,
  }
  return { prov, authMode: session.auth?.mode }
}

/** Build the daemon-lane PR footer for one executor session directly. */
export function buildSessionPrFooter(
  session: FooterSession,
  options: SessionFooterOptions & { sha?: string } = {},
): string {
  const { prov, authMode } = sessionFooterProvenance(session, options)
  return buildFooter({ prov, authMode, sha: options.sha, kind: "PR" })
}

/**
 * Append the footer to a PR body exactly once. Idempotent by the marker: a
 * body that already carries a `@agentproto-bot` footer is returned unchanged,
 * so a retried stamp (network reply lost after the edit landed) never stacks
 * a second footer.
 */
export function appendFooterOnce(body: string, footer: string): string {
  if (hasProvenanceFooter(body)) return body
  return `${body}${footer}`
}

/**
 * Whether a PR/review body already carries a RENDERED provenance footer — the
 * `<sub>…@agentproto-bot…</sub>` line {@link buildFooter} emits — as opposed
 * to merely MENTIONING the marker in prose. The distinction matters: a PR
 * whose description discusses the provenance machinery itself (they exist —
 * #999 explains a footer bug and quotes the marker) would otherwise read as
 * "already stamped" forever and never receive its real footer.
 */
export function hasProvenanceFooter(body: string): boolean {
  return new RegExp(`<sub>[^\\n]*${MARKER}`).test(body)
}

/** The rendered footer block, as {@link buildFooter} emits it (with the
 *  `\n\n---\n` lead-in when present). */
const FOOTER_BLOCK_RE = new RegExp(`(?:\\n+---)?\\n*<sub>[^\\n]*${MARKER}[^\\n]*</sub>`)

/** Just the `<sub>…</sub>` span of a rendered footer within `body` (or a
 *  standalone footer string, which is itself `<sub>…</sub>`-shaped) — every
 *  "read a signal out of an existing footer" helper below shares this
 *  extraction so they agree on what "the footer" means. Undefined when `body`
 *  carries no rendered footer at all. */
function extractFooterBlock(body: string): string | undefined {
  return new RegExp(`<sub>[^\\n]*${MARKER}[^\\n]*</sub>`).exec(body)?.[0]
}

/** True when a body's provenance footer already carries a spend figure. */
export function footerHasCost(body: string): boolean {
  const block = extractFooterBlock(body)
  return block !== undefined && /\$\d/.test(block)
}

/**
 * The `session \`<id>\`` a rendered footer names, or undefined when the body
 * carries no footer or the footer names no session (the legacy-fallback
 * shape, e.g. a bare CI API-key run with no agent session behind it).
 *
 * Used to recognize "this footer already names ME" — both the daemon's own
 * `buildSessionPrFooter` render and the `gh` PATH shim's thin one
 * (gh-provenance-shim.ts) render the SAME `session \`<id>\`` segment, so a
 * footer this returns OUR session id for is safe to enrich/upgrade: the
 * misattribution risk `hasProvenanceFooter`'s callers guard against is a
 * footer naming a DIFFERENT session, not our own.
 */
export function footerSessionId(body: string): string | undefined {
  const block = extractFooterBlock(body)
  if (block === undefined) return undefined
  return /session `([^`]+)`/.exec(block)?.[1]
}

/**
 * Whether `candidate` (a standalone footer, as {@link buildFooter} renders
 * it, or a full body containing one) carries a provenance signal — spend,
 * bound auth-profile identity, or token counts — that `existing` doesn't.
 * Used to decide whether replacing an already-posted footer with a fresh
 * daemon render is a genuine UPGRADE rather than a no-op re-render: the `gh`
 * PATH shim's thin footer (gh-provenance-shim.ts) can only ever render
 * session/adapter/model/host/cwd — never cost, auth-profile, or tokens, since
 * those aren't known to a bare `gh` subprocess — so a shim-stamped body
 * always has ROOM for this kind of upgrade once the daemon knows more.
 */
export function footerIsRicherThan(candidate: string, existing: string): boolean {
  const candidateBlock = extractFooterBlock(candidate) ?? ""
  const existingBlock = extractFooterBlock(existing) ?? ""
  const gained = (has: (block: string) => boolean) => has(candidateBlock) && !has(existingBlock)
  const hasCost = (block: string) => /\$\d/.test(block)
  const hasAuthProfile = (block: string) => /auth-profile `/.test(block)
  const hasTokens = (block: string) => / in \/ .{1,20} out\b/.test(block)
  return gained(hasCost) || gained(hasAuthProfile) || gained(hasTokens)
}

/**
 * Replace an existing footer with a fresh one (append when there is none).
 * The daemon stamps a PR the instant `gh pr create` returns — mid-turn, when
 * a claude-code/claude-sdk session has reported no usage yet (cost only
 * arrives on the turn's `result`), so the first footer has no amount. At
 * turn-end the reconciler re-renders it with what the session now knows.
 */
export function replaceProvenanceFooter(body: string, footer: string): string {
  if (!hasProvenanceFooter(body)) return appendFooterOnce(body, footer)
  return body.replace(FOOTER_BLOCK_RE, footer)
}

/**
 * Recognise a successful `gh pr create` from its argv + stdout and pull the
 * created PR's URL + number out. Returns null for anything that isn't a
 * PR-creating `gh` invocation, or a create whose stdout carried no PR URL.
 *
 * `gh pr create` prints the PR URL on its own line (often the last line,
 * after any advisory notices) — we take the LAST `…/pull/<n>` match so a
 * "Warning: …/pull/…" style notice can't shadow the real one.
 */
export function parseGhPrCreate(
  command: string,
  args: readonly string[],
  stdout: string,
): { url: string; number: number } | null {
  if (basename(command) !== "gh") return null
  // Skip global flags; the first two non-flag tokens must be `pr` then `create`.
  const positionals = args.filter(a => !a.startsWith("-"))
  if (positionals[0] !== "pr" || positionals[1] !== "create") return null
  const re = /https?:\/\/\S+?\/pull\/(\d+)/g
  let match: RegExpExecArray | null
  let last: { url: string; number: number } | null = null
  while ((match = re.exec(stdout)) !== null) {
    last = { url: match[0], number: Number(match[1]) }
  }
  return last
}

/**
 * String-form counterpart of {@link parseGhPrCreate} for the in-agent tool
 * lane: an ACP harness's Bash-style tool reports ONE shell string (possibly
 * compound — `git push && gh pr create … | tail -1`), not an argv, so the
 * argv parser above can't see it. Detects "this call created a PR" from the
 * command string plus the call's recorded result text, and returns the
 * created PR (LAST `…/pull/<n>` match in the result, same shadowing rule as
 * {@link parseGhPrCreate} — `gh pr create` prints its URL after any notices).
 *
 * Quoted spans are stripped before matching so a command that merely
 * MENTIONS the phrase — `grep "gh pr create" src/` over a result that quotes
 * a PR url — can never read as a create. Best-effort by design: the caller
 * additionally gates on the call's own `isError` (a failed create whose
 * stderr cites an existing PR must not attribute that PR here).
 */
export function detectShellPrCreate(
  command: string | undefined,
  resultText: string | undefined,
): { url: string; number: number } | null {
  if (!command || !resultText) return null
  const unquoted = command.replace(/'[^']*'/g, " ").replace(/"(?:[^"\\]|\\.)*"/g, " ")
  if (!/(^|[\s;&|({])gh\s+pr\s+create(\s|$)/.test(unquoted)) return null
  const re = /https?:\/\/\S+?\/pull\/(\d+)/g
  let match: RegExpExecArray | null
  let last: { url: string; number: number } | null = null
  while ((match = re.exec(resultText)) !== null) {
    last = { url: match[0], number: Number(match[1]) }
  }
  return last
}

/** `session.cwd == cwd || one contains the other` — the executor's cwd is
 *  usually the worktree root while the command may run in a subdir (or vice
 *  versa), so containment is checked in both directions. */
function cwdRelated(sessionCwd: string, cwd: string): boolean {
  if (sessionCwd === cwd) return true
  const sep = "/"
  return cwd.startsWith(sessionCwd + sep) || sessionCwd.startsWith(cwd + sep)
}

/**
 * Best-effort attribution of a `command_execute` run to the executor agent
 * session that most likely issued it: the newest agent-cli session whose cwd
 * is related to the command's cwd, preferring a still-alive one. Returns
 * undefined when no agent-cli session matches (e.g. a bare shell opened the
 * PR) — the caller then skips stamping rather than emit a misleading "legacy
 * fallback" footer.
 */
export function pickExecutorSession<T extends FooterSession>(
  sessions: readonly T[],
  cwd: string,
): T | undefined {
  const candidates = sessions.filter(
    s => s.kind === "agent-cli" && typeof s.cwd === "string" && cwdRelated(s.cwd, cwd),
  )
  if (candidates.length === 0) return undefined
  const alive = (s: T) => s.status === "running" || s.status === "starting"
  const byRecency = (a: T, b: T) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
  const live = candidates.filter(alive).sort(byRecency)
  if (live.length > 0) return live[0]
  return [...candidates].sort(byRecency)[0]
}
