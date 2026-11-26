/**
 * MCP 2026-07-28 elicitation transport (`InputRequiredResult` / MRTR) over the
 * daemon's existing human-input primitives.
 *
 * This module is strictly a transport adapter: it never replaces or bypasses
 * the underlying judge (`respondPermission`, `approval_consume`, or workflow
 * escalation resolvers). Secrets are forbidden in `form` mode.
 */

import type { AgentPromptAnswers, AgentPromptField } from "@agentproto/acp"
import type { PendingPermission, SessionsRegistry } from "../sessions.js"
import { BridgeError } from "./bridge.js"
import { ERR_INVALID_PARAMS } from "./constants.js"
import { canonicalArgsHash, type MrtrEntityKind, type MrtrStateStore } from "./mrtr-state.js"

// ── MCP 2026-07-28 MRTR & Elicitation wire shapes ──────────────────────────

export interface ElicitFormPropertySchema {
  type?: "string" | "number" | "integer" | "boolean" | "array"
  title?: string
  description?: string
  minLength?: number
  maxLength?: number
  format?: "email" | "uri" | "date" | "date-time"
  minimum?: number
  maximum?: number
  default?: string | number | boolean | string[]
  enum?: string[]
  oneOf?: Array<{ const: string; title: string }>
  items?:
    | { type: "string"; enum: string[] }
    | { anyOf: Array<{ const: string; title: string }> }
  minItems?: number
  maxItems?: number
}

export interface ElicitRequestedSchema {
  $schema?: string
  type: "object"
  properties: Record<string, ElicitFormPropertySchema>
  required?: string[]
}

export interface ElicitRequestFormParams {
  mode?: "form"
  message: string
  requestedSchema: ElicitRequestedSchema
}

export interface ElicitRequestUrlParams {
  mode: "url"
  message: string
  url: string
}

/**
 * Union per MCP 2026-07-28 MRTR specification.
 * This host only ever emits `elicitation/create` (never `sampling/createMessage` or `roots/list`).
 */
export type InputRequest =
  | { method: "elicitation/create"; params: ElicitRequestFormParams | ElicitRequestUrlParams }
  | { method: "sampling/createMessage"; params: Record<string, unknown> }
  | { method: "roots/list"; params: Record<string, unknown> }

export type InputRequests = Record<string, InputRequest>

export type ElicitResult =
  | { action: "accept"; content?: Record<string, string | number | boolean | string[]> }
  | { action: "decline" | "cancel" }

export interface InputRequiredResult {
  resultType: "input_required"
  inputRequests?: InputRequests
  requestState?: string
}

// ── Client capability inspection ───────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Check whether the client declared support for the requested elicitation mode
 * in `params._meta["io.modelcontextprotocol/clientCapabilities"].elicitation`.
 * Per MCP 2026-07-28, an empty `"elicitation": {}` object implies `{ form: {} }`.
 */
export function clientSupportsElicitation(
  clientCapabilities: Record<string, unknown> | undefined,
  mode: "form" | "url",
): boolean {
  if (!clientCapabilities) return false
  const elicit = clientCapabilities.elicitation
  if (!isRecord(elicit)) return false
  const keys = Object.keys(elicit)
  if (keys.length === 0) return mode === "form"
  return isRecord(elicit[mode])
}

// ── Secret & flat schema guards ────────────────────────────────────────────

const SECRET_HINT_RE =
  /(?:^|[^a-z0-9])(password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|credential|credentials|payment|credit[_-]?card|card[_-]?number|cvv|cvc|oauth|bearer[_-]?token|whsec)(?:$|[^a-z0-9])/i

/** True when a field key or prompt text indicates secret/payment/OAuth data forbidden in `form` mode. */
export function isSecretField(key: string, description?: string): boolean {
  if (SECRET_HINT_RE.test(key)) return true
  if (typeof description === "string" && SECRET_HINT_RE.test(description)) return true
  return false
}

const ALLOWED_STRING_FORMATS = new Set(["email", "uri", "date", "date-time"])

/**
 * Validate that a schema conforms strictly to the MCP 2026-07-28 flat
 * `requestedSchema` subset and contains no secret fields.
 */
export function validateFlatFormSchema(schema: unknown): { ok: true; schema: ElicitRequestedSchema } | { ok: false; reason: string } {
  if (!isRecord(schema)) return { ok: false, reason: "requestedSchema must be an object" }
  if (schema.type !== "object") return { ok: false, reason: "requestedSchema.type must be 'object'" }
  if ("$ref" in schema || "allOf" in schema || "anyOf" in schema || "oneOf" in schema) {
    return { ok: false, reason: "top-level $ref/combinators are not allowed in requestedSchema" }
  }
  if (!isRecord(schema.properties)) return { ok: false, reason: "requestedSchema.properties must be an object" }

  const propEntries = Object.entries(schema.properties)
  if (propEntries.length === 0) return { ok: false, reason: "requestedSchema.properties must not be empty" }

  for (const [key, rawProp] of propEntries) {
    if (!isRecord(rawProp)) return { ok: false, reason: `property '${key}' must be an object` }
    if ("$ref" in rawProp || "allOf" in rawProp || "properties" in rawProp) {
      return { ok: false, reason: `property '${key}' must be flat (no nested objects, $ref, or allOf)` }
    }
    const desc = typeof rawProp.description === "string" ? rawProp.description : undefined
    const title = typeof rawProp.title === "string" ? rawProp.title : undefined
    if (isSecretField(key, desc) || (title && isSecretField(key, title))) {
      return { ok: false, reason: `property '${key}' carries secret/sensitive data and is forbidden in form mode` }
    }

    const propType = rawProp.type
    if (propType === "object") {
      return { ok: false, reason: `property '${key}' cannot have type 'object' (must be flat)` }
    }
    if (propType === "array") {
      const items = rawProp.items
      if (!isRecord(items)) return { ok: false, reason: `array property '${key}' must declare enum items` }
      const hasStringEnum =
        items.type === "string" &&
        Array.isArray(items.enum) &&
        items.enum.length > 0 &&
        items.enum.every(v => typeof v === "string")
      const hasAnyOf =
        Array.isArray(items.anyOf) &&
        items.anyOf.length > 0 &&
        items.anyOf.every(v => isRecord(v) && typeof v.const === "string" && typeof v.title === "string")
      if (!hasStringEnum && !hasAnyOf) {
        return { ok: false, reason: `array property '${key}' only allows string enum or anyOf const/title items` }
      }
      continue
    }

    if (propType === "string") {
      if (rawProp.format !== undefined && (typeof rawProp.format !== "string" || !ALLOWED_STRING_FORMATS.has(rawProp.format))) {
        return { ok: false, reason: `property '${key}' has unsupported string format` }
      }
      if (rawProp.enum !== undefined && (!Array.isArray(rawProp.enum) || !rawProp.enum.every(v => typeof v === "string"))) {
        return { ok: false, reason: `property '${key}' enum must be a string array` }
      }
      if (
        rawProp.oneOf !== undefined &&
        (!Array.isArray(rawProp.oneOf) ||
          !rawProp.oneOf.every(v => isRecord(v) && typeof v.const === "string" && typeof v.title === "string"))
      ) {
        return { ok: false, reason: `property '${key}' oneOf must contain {const, title} strings` }
      }
      continue
    }

    if (propType === "number" || propType === "integer" || propType === "boolean") {
      continue
    }

    // Enum-only without explicit type is allowed if valid string enum or oneOf
    const validEnumOnly =
      Array.isArray(rawProp.enum) && rawProp.enum.length > 0 && rawProp.enum.every(v => typeof v === "string")
    const validOneOfOnly =
      Array.isArray(rawProp.oneOf) &&
      rawProp.oneOf.length > 0 &&
      rawProp.oneOf.every(v => isRecord(v) && typeof v.const === "string" && typeof v.title === "string")
    if (!validEnumOnly && !validOneOfOnly) {
      return { ok: false, reason: `property '${key}' has unsupported type '${String(propType)}'` }
    }
  }

  return { ok: true, schema: schema as unknown as ElicitRequestedSchema }
}

// ── Schema builders from existing daemon primitives ────────────────────────

function projectQuestionField(field: AgentPromptField): ElicitFormPropertySchema | null {
  if (isSecretField(field.id, field.prompt) || (field.header && isSecretField(field.id, field.header))) {
    return null
  }
  const base = {
    ...(field.header ? { title: field.header } : {}),
    description: field.prompt,
  }
  switch (field.input) {
    case "single": {
      const choices = field.choices ?? []
      if (choices.length > 0 && !field.allowFreeText) {
        return {
          ...base,
          type: "string",
          oneOf: choices.map(c => ({ const: c.value, title: c.label })),
          ...(field.recommended ? { default: field.recommended } : {}),
        }
      }
      // Free-text fallback when choices are empty or free text is permitted alongside choices.
      return {
        ...base,
        type: "string",
        ...(field.recommended ? { default: field.recommended } : {}),
      }
    }
    case "multi": {
      const choices = field.choices ?? []
      if (choices.length === 0) return null
      return {
        ...base,
        type: "array",
        items: { anyOf: choices.map(c => ({ const: c.value, title: c.label })) },
      }
    }
    case "text":
      return { ...base, type: "string" }
    case "boolean":
      return { ...base, type: "boolean" }
    case "number":
      return { ...base, type: "number" }
    default:
      return null
  }
}

export interface BuiltElicitation {
  kind: "permission" | "question"
  requestKey: string
  request: { method: "elicitation/create"; params: ElicitRequestFormParams }
  fields?: readonly AgentPromptField[]
  offersAlwaysScope?: boolean
}

/** Build an MCP 2026-07-28 `elicitation/create` form request for a parked permission or multi-field question. */
export function buildPermissionElicitation(pending: PendingPermission): BuiltElicitation | null {
  if (pending.question?.fields && pending.question.fields.length > 0) {
    const properties: Record<string, ElicitFormPropertySchema> = {}
    const required: string[] = []
    for (const field of pending.question.fields) {
      const prop = projectQuestionField(field)
      if (!prop) return null
      properties[field.id] = prop
      if (field.required) required.push(field.id)
    }
    const schemaCandidate: ElicitRequestedSchema = {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    }
    const validated = validateFlatFormSchema(schemaCandidate)
    if (!validated.ok) return null
    const message = pending.question.prompt || pending.text || "Session question requires input"
    if (isSecretField("message", message)) return null
    return {
      kind: "question",
      requestKey: `question_${pending.id}`,
      request: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message,
          requestedSchema: validated.schema,
        },
      },
      fields: pending.question.fields,
    }
  }

  // Standard tool-permission hold.
  const offersAlwaysScope = pending.options.some(o => o.kind === "allow_always")
  const properties: Record<string, ElicitFormPropertySchema> = {
    decision: {
      type: "string",
      title: "Decision",
      description: "Approve or deny this tool request",
      oneOf: [
        { const: "approve", title: "Approve" },
        { const: "deny", title: "Deny" },
      ],
    },
    ...(offersAlwaysScope
      ? {
          scope: {
            type: "string",
            title: "Scope",
            description: "Apply approval once or always for this session",
            oneOf: [
              { const: "once", title: "Once" },
              { const: "always", title: "Always" },
            ],
            default: "once",
          },
        }
      : {}),
  }
  const validated = validateFlatFormSchema({
    type: "object",
    properties,
    required: ["decision"],
  })
  if (!validated.ok) return null
  const label = pending.toolName ? `[${pending.toolName}] ${pending.text}` : pending.text
  return {
    kind: "permission",
    requestKey: `perm_${pending.id}`,
    request: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: label || `Permission required for session ${pending.sessionId}`,
        requestedSchema: validated.schema,
      },
    },
    offersAlwaysScope,
  }
}

// ── Scoping & self-approval boundary ───────────────────────────────────────

/**
 * Mirrors `orchestration-tools.ts`'s subtree check: the operator (`callerSessionId === undefined`)
 * can observe/respond to any session; a spawned session can only see sessions in its subtree.
 */
export function isSessionInSubtreeScope(
  registry: Pick<SessionsRegistry, "get">,
  callerSessionId: string | undefined,
  targetSessionId: string,
): boolean {
  if (!callerSessionId) return true
  if (targetSessionId === callerSessionId) return true
  const visited = new Set<string>([targetSessionId])
  let cur = registry.get(targetSessionId)?.parentSessionId
  while (cur && !visited.has(cur)) {
    if (cur === callerSessionId) return true
    visited.add(cur)
    cur = registry.get(cur)?.parentSessionId
  }
  return false
}

/**
 * Security boundary: a session agent MUST NEVER resolve a permission or question
 * targeting itself (`pending.sessionId === callerSessionId`), and may only resolve
 * descendants within its own subtree.
 */
export function canCallerResolvePermission(
  registry: Pick<SessionsRegistry, "get">,
  callerSessionId: string | undefined,
  pending: PendingPermission,
): boolean {
  if (!callerSessionId) return true
  if (pending.sessionId === callerSessionId) return false
  return isSessionInSubtreeScope(registry, callerSessionId, pending.sessionId)
}

// ── Answer extraction & application ────────────────────────────────────────

function convertFormContentToQuestionAnswers(
  fields: readonly AgentPromptField[],
  content: Record<string, unknown>,
): { ok: true; answers: AgentPromptAnswers } | { ok: false; missing: string[] } {
  const answers: AgentPromptAnswers = {}
  const missing: string[] = []
  for (const field of fields) {
    const raw = content[field.id]
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.length === 0)) {
      if (field.required) missing.push(field.id)
      continue
    }
    switch (field.input) {
      case "single": {
        if (typeof raw !== "string") {
          missing.push(field.id)
          break
        }
        const matchesChoice = (field.choices ?? []).some(c => c.value === raw)
        answers[field.id] = matchesChoice ? { selected: [raw] } : { text: raw }
        break
      }
      case "multi": {
        if (!Array.isArray(raw) || !raw.every(v => typeof v === "string")) {
          missing.push(field.id)
          break
        }
        if (field.required && raw.length === 0) {
          missing.push(field.id)
          break
        }
        answers[field.id] = { selected: raw as string[] }
        break
      }
      case "text": {
        if (typeof raw !== "string") {
          missing.push(field.id)
          break
        }
        answers[field.id] = { text: raw }
        break
      }
      case "boolean": {
        if (typeof raw !== "boolean") {
          missing.push(field.id)
          break
        }
        answers[field.id] = { value: raw }
        break
      }
      case "number": {
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          missing.push(field.id)
          break
        }
        answers[field.id] = { value: raw }
        break
      }
    }
  }
  if (missing.length > 0) return { ok: false, missing }
  return { ok: true, answers }
}

// ── HumanGate interface & runtime implementation ───────────────────────────

export interface HumanGateAuditEntry {
  principal: string
  kind: MrtrEntityKind
  entityId: string
  action: "accept" | "decline" | "cancel"
  applied: boolean
  detail?: string
}

export interface HumanGateToolCallContext {
  tool: string
  params: Record<string, unknown>
  callerSessionId?: string
  clientCapabilities?: Record<string, unknown>
}

export interface HumanGate {
  /** Handle a modern `tools/call`, either producing an `InputRequiredResult`, replaying an MRTR response, or forwarding normally. */
  handleToolCall(
    ctx: HumanGateToolCallContext,
    forward: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>
  /** Build open `inputRequests` for a target session (reused by Tasks projection). */
  inspectPendingForSession(
    sessionId: string,
    callerSessionId: string | undefined,
    clientCapabilities: Record<string, unknown> | undefined,
  ): InputRequests | undefined
  /** Apply `inputResponses` for a target session without MRTR token (used by `tasks/update`). */
  applyResponsesForSession(
    sessionId: string,
    callerSessionId: string | undefined,
    inputResponses: Record<string, unknown>,
  ): Promise<void>
}

export interface CreateHumanGateOptions {
  sessions: Pick<SessionsRegistry, "get" | "listPendingPermissions" | "respondPermission">
  stateStore: MrtrStateStore
  onAudit?: (entry: HumanGateAuditEntry) => void
}

function parseElicitResult(raw: unknown): ElicitResult | null {
  if (!isRecord(raw)) return null
  if (raw.action === "decline" || raw.action === "cancel") {
    return { action: raw.action }
  }
  if (raw.action === "accept") {
    if (raw.content === undefined) return { action: "accept" }
    if (!isRecord(raw.content)) return null
    return { action: "accept", content: raw.content as Record<string, string | number | boolean | string[]> }
  }
  return null
}

export function createHumanGate(opts: CreateHumanGateOptions): HumanGate {
  const { sessions, stateStore, onAudit } = opts

  const audit = (entry: HumanGateAuditEntry): void => {
    try {
      onAudit?.(entry)
    } catch {
      // Audit callback must never break request handling.
    }
  }

  const applyOnePermissionResponse = async (
    pending: PendingPermission,
    built: BuiltElicitation,
    elicitResult: ElicitResult,
    callerSessionId: string | undefined,
  ): Promise<"applied" | "incomplete" | "cancelled" | "gone"> => {
    const principal = callerSessionId ?? "operator"

    // CAS check: confirm the permission is still pending right before applying.
    const stillPending = sessions.listPendingPermissions({ sessionId: pending.sessionId }).find(p => p.id === pending.id)
    if (!stillPending) {
      audit({ principal, kind: built.kind, entityId: pending.id, action: elicitResult.action, applied: false, detail: "already_resolved" })
      return "gone"
    }

    if (elicitResult.action === "cancel") {
      audit({ principal, kind: built.kind, entityId: pending.id, action: "cancel", applied: false, detail: "user_cancelled" })
      return "cancelled"
    }

    if (elicitResult.action === "decline") {
      const res = await sessions.respondPermission(pending.id, { decision: "deny" })
      audit({ principal, kind: built.kind, entityId: pending.id, action: "decline", applied: res.ok })
      return res.ok ? "applied" : "gone"
    }

    // action === "accept"
    if (elicitResult.action !== "accept") return "incomplete"
    const content = elicitResult.content
    if (!content) return "incomplete"

    if (built.kind === "question" && built.fields) {
      const converted = convertFormContentToQuestionAnswers(built.fields, content)
      if (!converted.ok) return "incomplete"
      const res = await sessions.respondPermission(pending.id, {
        decision: "approve",
        answers: converted.answers,
      })
      audit({ principal, kind: "question", entityId: pending.id, action: "accept", applied: res.ok })
      return res.ok ? "applied" : "gone"
    }

    const decision = content.decision
    if (decision !== "approve" && decision !== "deny") return "incomplete"
    const scope = content.scope === "once" || content.scope === "always" ? content.scope : undefined
    const res = await sessions.respondPermission(pending.id, {
      decision,
      ...(decision === "approve" && scope && built.offersAlwaysScope ? { scope } : {}),
    })
    audit({ principal, kind: "permission", entityId: pending.id, action: "accept", applied: res.ok, detail: decision })
    return res.ok ? "applied" : "gone"
  }

  const mintPermissionInputRequired = (
    pending: PendingPermission,
    built: BuiltElicitation,
    tool: string,
    argsHash: string,
    callerSessionId: string | undefined,
  ): InputRequiredResult => {
    const requestState = stateStore.mint({
      kind: built.kind,
      entityId: pending.id,
      requestKey: built.requestKey,
      ...(callerSessionId !== undefined ? { callerSessionId } : {}),
      tool,
      argsHash,
    })
    return {
      resultType: "input_required",
      inputRequests: { [built.requestKey]: built.request },
      requestState,
    }
  }

  const findEligiblePending = (
    callerSessionId: string | undefined,
    sessionFilter?: string | readonly string[],
  ): { pending: PendingPermission; built: BuiltElicitation } | undefined => {
    const filterSet =
      typeof sessionFilter === "string"
        ? new Set([sessionFilter])
        : Array.isArray(sessionFilter) && sessionFilter.length > 0
          ? new Set(sessionFilter)
          : undefined
    const candidates = sessions.listPendingPermissions()
    for (const pending of candidates) {
      if (filterSet && !filterSet.has(pending.sessionId)) continue
      if (!canCallerResolvePermission(sessions, callerSessionId, pending)) continue
      const built = buildPermissionElicitation(pending)
      if (built) return { pending, built }
    }
    return undefined
  }

  return {
    async handleToolCall(ctx, forward) {
      const { tool, params, callerSessionId, clientCapabilities } = ctx
      const hasReplay = params.requestState !== undefined || params.inputResponses !== undefined
      const argsHash = canonicalArgsHash(params)

      if (hasReplay) {
        if (typeof params.requestState !== "string" || !isRecord(params.inputResponses)) {
          throw new BridgeError(ERR_INVALID_PARAMS, "MRTR replay requires both string requestState and object inputResponses")
        }
        const verified = stateStore.verifyAndConsume(params.requestState, {
          tool,
          argsHash,
          ...(callerSessionId !== undefined ? { callerSessionId } : {}),
        })
        if (!verified.ok) {
          throw new BridgeError(ERR_INVALID_PARAMS, verified.message, { reason: verified.reason })
        }

        const { state } = verified
        if (state.kind !== "permission" && state.kind !== "question") {
          throw new BridgeError(ERR_INVALID_PARAMS, "Unsupported requestState kind", { reason: "unsupported_kind" })
        }

        const pending = sessions.listPendingPermissions().find(p => p.id === state.entityId)
        if (!pending) {
          // Entity already resolved concurrently (CAS) — fall through cleanly to the original tool call.
          return forward()
        }
        if (!canCallerResolvePermission(sessions, callerSessionId, pending)) {
          throw new BridgeError(ERR_INVALID_PARAMS, "Caller is not permitted to resolve this input request", {
            reason: "forbidden_scope",
          })
        }

        const built = buildPermissionElicitation(pending)
        if (!built) return forward()

        const key = state.requestKey ?? built.requestKey
        const parsedResponse = parseElicitResult(params.inputResponses[key])
        if (!parsedResponse) {
          // Spec rule: missing/incomplete info produces a fresh InputRequiredResult rather than an error.
          if (clientSupportsElicitation(clientCapabilities, "form")) {
            return mintPermissionInputRequired(pending, built, tool, argsHash, callerSessionId) as unknown as Record<string, unknown>
          }
          return forward()
        }

        const outcome = await applyOnePermissionResponse(pending, built, parsedResponse, callerSessionId)
        if (outcome === "incomplete" && clientSupportsElicitation(clientCapabilities, "form")) {
          const fresh = sessions.listPendingPermissions().find(p => p.id === pending.id)
          if (fresh) {
            return mintPermissionInputRequired(fresh, built, tool, argsHash, callerSessionId) as unknown as Record<string, unknown>
          }
        }
        return forward()
      }

      // Initial call: only emit InputRequiredResult when the client declared elicitation.form.
      if (!clientSupportsElicitation(clientCapabilities, "form")) {
        return forward()
      }

      const args = isRecord(params.arguments) ? params.arguments : {}

      if (tool === "permissions_list") {
        const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined
        const match = findEligiblePending(callerSessionId, sessionId)
        if (match) {
          return mintPermissionInputRequired(match.pending, match.built, tool, argsHash, callerSessionId) as unknown as Record<string, unknown>
        }
      } else if (tool === "session_monitor") {
        const rawIds = Array.isArray(args.sessionIds)
          ? (args.sessionIds.filter((s): s is string => typeof s === "string"))
          : typeof args.sessionId === "string"
            ? [args.sessionId]
            : undefined
        if (rawIds && rawIds.length > 0) {
          const match = findEligiblePending(callerSessionId, rawIds)
          if (match) {
            return mintPermissionInputRequired(match.pending, match.built, tool, argsHash, callerSessionId) as unknown as Record<string, unknown>
          }
        }
      }

      return forward()
    },

    inspectPendingForSession(sessionId, callerSessionId, clientCapabilities) {
      if (!clientSupportsElicitation(clientCapabilities, "form")) return undefined
      const pendingList = sessions.listPendingPermissions({ sessionId })
      const requests: InputRequests = {}
      for (const pending of pendingList) {
        if (!canCallerResolvePermission(sessions, callerSessionId, pending)) continue
        const built = buildPermissionElicitation(pending)
        if (built) requests[built.requestKey] = built.request
      }
      return Object.keys(requests).length > 0 ? requests : undefined
    },

    async applyResponsesForSession(sessionId, callerSessionId, inputResponses) {
      const pendingList = sessions.listPendingPermissions({ sessionId })
      for (const pending of pendingList) {
        if (!canCallerResolvePermission(sessions, callerSessionId, pending)) continue
        const built = buildPermissionElicitation(pending)
        if (!built) continue
        if (!(built.requestKey in inputResponses)) continue
        const parsed = parseElicitResult(inputResponses[built.requestKey])
        if (!parsed) continue
        await applyOnePermissionResponse(pending, built, parsed, callerSessionId)
      }
    },
  }
}
