/**
 * Pure session-arg normalization + quick-pick mapping. No `vscode` import
 * so this is directly unit-testable; sessionActions.ts's interactive
 * commands call into these.
 */

import type { SessionDescriptor, SessionSummary } from "../client/types.js"

export interface SessionQuickPickItem {
  label: string
  description?: string
  session: SessionDescriptor
}

/**
 * Command args arrive in one of three shapes: a tree item carrying
 * `{ session: SessionDescriptor }`, a raw SessionDescriptor (direct
 * programmatic invocation), or undefined (command palette — caller falls
 * back to a quick-pick).
 */
export function normalizeSessionArg(arg: unknown): SessionDescriptor | undefined {
  if (!arg || typeof arg !== "object") return undefined
  if (isSessionDescriptor(arg)) return arg
  const wrapped = (arg as { session?: unknown }).session
  if (isSessionDescriptor(wrapped)) return wrapped
  return undefined
}

function isSessionDescriptor(value: unknown): value is SessionDescriptor {
  if (!value || typeof value !== "object") return false
  const v = value as { id?: unknown; kind?: unknown; status?: unknown }
  return typeof v.id === "string" && typeof v.kind === "string" && typeof v.status === "string"
}

export function isLiveSession(session: SessionSummary): boolean {
  return session.status === "running" || session.status === "starting"
}

export function describeSession(session: SessionDescriptor): string {
  return session.label ?? session.slug ?? session.name ?? session.id
}

/**
 * Whether a session answers to a caller-supplied reference string. The daemon's
 * ONE resolver (`resolveSessionRef`) is authoritative for the wire; this is a
 * convenience match over the local snapshot so a command arg, a slug typed into
 * a picker filter, etc. resolves without a round-trip. It mirrors the same
 * three handles the shared surface accepts — id, slug, legacy name — and adds
 * NO precedence/ambiguity logic of its own (the daemon already enforces slug
 * uniqueness). Keep subsequent tool calls on `session.id`.
 */
export function sessionMatchesRef(session: SessionDescriptor, ref: string): boolean {
  return session.id === ref || session.slug === ref || session.name === ref
}

/** First session in the snapshot answering to `ref` (id, slug, or legacy name). */
export function findSessionByRef(
  sessions: readonly SessionDescriptor[],
  ref: string,
): SessionDescriptor | undefined {
  return sessions.find(session => sessionMatchesRef(session, ref))
}

export function mapSessionsToQuickPickItems(sessions: SessionDescriptor[]): SessionQuickPickItem[] {
  return sessions.map(session => ({
    label: describeSession(session),
    description: [session.slug, session.adapterSlug ?? session.kind, session.status]
      .filter(Boolean)
      .join(" · "),
    session,
  }))
}
