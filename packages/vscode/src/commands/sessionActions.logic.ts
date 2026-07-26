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
  return session.label ?? session.name ?? session.id
}

export function mapSessionsToQuickPickItems(sessions: SessionDescriptor[]): SessionQuickPickItem[] {
  return sessions.map(session => ({
    label: describeSession(session),
    description: [session.adapterSlug ?? session.kind, session.status].filter(Boolean).join(" · "),
    session,
  }))
}
