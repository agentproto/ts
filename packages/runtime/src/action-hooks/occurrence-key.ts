/**
 * Action id grammar and occurrence keys for action hooks.
 */

import type { ActionKind } from "./types.js"

const ACTION_ID_RE = /^[a-z0-9][a-z0-9.-]*(:[a-z0-9][a-z0-9.-]*)?$/
const FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f]/

/** True for an AIP-39 action id (qualified or unqualified). */
export function isActionKind(value: string): value is ActionKind {
  if (typeof value !== "string") return false
  if (value.length < 2 || value.length > 80) return false
  if (FORBIDDEN.test(value)) return false
  return ACTION_ID_RE.test(value)
}

export interface OccurrenceKeyParts {
  sessionId: string
  event: string
  occurrenceId: string
  bindingId: string
}

function checkSegment(name: string, value: string, allowSlash: boolean): void {
  if (value.length === 0) {
    throw new Error(`Invalid occurrence key: ${name} must not be empty`)
  }
  if (FORBIDDEN.test(value)) {
    throw new Error(`Invalid occurrence key: ${name} must not contain whitespace or control characters`)
  }
  if (!allowSlash && value.includes("/")) {
    throw new Error(`Invalid occurrence key: ${name} must not contain "/"`)
  }
  if (allowSlash && value.split("/").some(part => part.length === 0)) {
    throw new Error(`Invalid occurrence key: ${name} must not contain empty segments`)
  }
}

/** Build `<session-id>/<event>/<occurrence-id>/<binding-id>`. */
export function buildOccurrenceKey(parts: OccurrenceKeyParts): string {
  checkSegment("session id", parts.sessionId, false)
  checkSegment("event", parts.event, false)
  checkSegment("occurrence id", parts.occurrenceId, false)
  checkSegment("binding id", parts.bindingId, true)
  return `${parts.sessionId}/${parts.event}/${parts.occurrenceId}/${parts.bindingId}`
}

/** Parse an occurrence key, or return undefined when it is malformed. */
export function parseOccurrenceKey(key: string): OccurrenceKeyParts | undefined {
  if (FORBIDDEN.test(key)) return undefined
  const first = key.indexOf("/")
  if (first === -1) return undefined
  const second = key.indexOf("/", first + 1)
  if (second === -1) return undefined
  const third = key.indexOf("/", second + 1)
  if (third === -1) return undefined
  const parts: OccurrenceKeyParts = {
    sessionId: key.slice(0, first),
    event: key.slice(first + 1, second),
    occurrenceId: key.slice(second + 1, third),
    bindingId: key.slice(third + 1),
  }
  try {
    buildOccurrenceKey(parts)
  } catch {
    return undefined
  }
  return parts
}
