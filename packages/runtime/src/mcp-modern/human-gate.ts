/**
 * MCP 2026-07-28 elicitation transport (`InputRequiredResult` / MRTR) over the
 * daemon's existing human-input primitives.
 *
 * This module is strictly a transport adapter: it never replaces or bypasses
 * the underlying judge (`respondPermission`, `approval_consume`, or workflow
 * escalation resolvers). Secrets are forbidden in `form` mode.
 */

import type { AgentPromptAnswers, AgentPromptField, AgentPromptQuestion } from "@agentproto/acp"
import type { PendingPermission, SessionsRegistry } from "../sessions.js"
import { BridgeError } from "./bridge.js"
import { ERR_INVALID_PARAMS } from "./constants.js"
import { canonicalArgsHash, type MrtrEntityKind, type MrtrStateStore } from "./mrtr-state.js"

/** A refused MRTR retry is invalid params, answered with HTTP 400 on the modern era (AIP-77 "Error mapping"). */
const refusedRetry = (message: string, data?: unknown): BridgeError => new BridgeError(ERR_INVALID_PARAMS, message, data, 400)

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

// A compound term ("api key") matches with an underscore, a hyphen, nothing, or a run of whitespace
// (spaces, a no-break space) between its words: "Paste your API key" is the same ask as "api_key".
const SECRET_HINT_RE =
  /(?:^|[^a-z0-9])(password|passwd|passphrase|secret|api(?:[_-]|\s+)?key|access(?:[_-]|\s+)?token|auth(?:[_-]|\s+)?token|refresh(?:[_-]|\s+)?token|private(?:[_-]|\s+)?key|credential|credentials|payment|credit(?:[_-]|\s+)?card|card(?:[_-]|\s+)?number|cvv|cvc|oauth|bearer(?:[_-]|\s+)?token|whsec)(?:$|[^a-z0-9])/i

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
  /** A question without `fields`, answered by `optionId` through its one `answer` property. */
  answer?: { choiceOptionIds: readonly string[]; freeTextOptionId?: string }
  /** A `plan-approval` whose options are named by id: `approve` and `deny` select them. */
  plan?: { approveOptionId: string; rejectOptionId: string }
  offersAlwaysScope?: boolean
}

/**
 * The `planApproval` ids of a `plan-approval` prompt, when both are strings naming an offered
 * option. `PendingPermission.planApproval` is carried untyped from the driver, so anything else
 * reads as no plan payload and the prompt keeps the tool-permission selection by kind.
 */
function planApprovalIds(pending: PendingPermission): { approveOptionId: string; rejectOptionId: string } | undefined {
  if (pending.request !== "plan-approval" || !isRecord(pending.planApproval)) return undefined
  const { approveOptionId, rejectOptionId } = pending.planApproval
  if (typeof approveOptionId !== "string" || typeof rejectOptionId !== "string") return undefined
  const offered = (id: string) => pending.options.some(o => o.optionId === id)
  return offered(approveOptionId) && offered(rejectOptionId) ? { approveOptionId, rejectOptionId } : undefined
}

/**
 * A question without `fields` as a form with one `answer` property (AIP-45, MCP transport of a
 * question): a `oneOf` of its choices, or a plain string when free text is allowed. Null when it
 * cannot be written faithfully (a secret, an option that is not offered, nothing to answer with):
 * it is then not projected, never carried as the tool-permission form.
 */
function buildQuestionAnswerElicitation(pending: PendingPermission, question: AgentPromptQuestion): BuiltElicitation | null {
  const offered = (id: string | undefined) => id !== undefined && pending.options.some(o => o.optionId === id)
  const choices = Array.isArray(question.choices) ? question.choices : []
  if (!choices.every(c => isRecord(c) && typeof c.optionId === "string" && typeof c.label === "string" && offered(c.optionId))) {
    return null
  }
  const freeText = question.allowFreeText === true
  if (freeText && !offered(question.freeTextOptionId)) return null
  if (!freeText && choices.length === 0) return null
  const message = question.prompt || pending.text || "Session question requires input"
  if (isSecretField("message", message) || isSecretField("message", pending.text)) return null
  if (choices.some(c => isSecretField(c.optionId, c.label))) return null
  const answer: ElicitFormPropertySchema = {
    type: "string",
    title: "Answer",
    description: message,
    ...(freeText ? {} : { oneOf: choices.map(c => ({ const: c.optionId, title: c.label })) }),
  }
  const validated = validateFlatFormSchema({ type: "object", properties: { answer }, required: ["answer"] })
  if (!validated.ok) return null
  return {
    kind: "question",
    requestKey: `question_${pending.id}`,
    request: { method: "elicitation/create", params: { mode: "form", message, requestedSchema: validated.schema } },
    answer: {
      choiceOptionIds: choices.map(c => c.optionId),
      ...(freeText ? { freeTextOptionId: question.freeTextOptionId! } : {}),
    },
  }
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

  if (pending.question) return buildQuestionAnswerElicitation(pending, pending.question)

  // Standard tool-permission hold. A plan approval named by id gets no `scope`: `approve`
  // always selects `approveOptionId`, so a scope could not change the outcome.
  const plan = planApprovalIds(pending)
  const offersAlwaysScope = !plan && pending.options.some(o => o.kind === "allow_always")
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
    ...(plan ? { plan } : {}),
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

/** Read-only view of the approvals engine; the gate never decides or consumes an approval. */
export interface ApprovalLookup {
  get(id: string): { id: string; status: string; title?: string } | undefined
}

/** The slice of the workflow runner used to observe a suspended run and resume it through its own resolver. */
export interface RunSuspendLookup {
  status(runId: string): {
    status: string
    awaitingSuspend?: { stepId: string; reason?: string; prompt?: string; schema?: Record<string, unknown> }
  } | undefined
  resumeSuspend(
    runId: string,
    input: { stepId?: string; payload?: unknown },
  ): { ok: true } | { ok: false; error: string; message: string }
}

/** Per-kind switches resolved on every request, so each surface can be turned off on its own. */
export interface HumanGateSurfaces {
  /** Project pending approvals as `url` elicitations (needs `approvalsUiBaseUrl`). */
  approvals: boolean
  /** Project runs parked on a human question as `form` elicitations. */
  runs: boolean
  /** Base URL of the authenticated human approval page (an external console). */
  approvalsUiBaseUrl?: string
}

export interface CreateHumanGateOptions {
  sessions: Pick<SessionsRegistry, "get" | "listPendingPermissions" | "respondPermission">
  stateStore: MrtrStateStore
  onAudit?: (entry: HumanGateAuditEntry) => void
  approvals?: ApprovalLookup
  workflowRunner?: RunSuspendLookup
  surfaces?: () => HumanGateSurfaces | Promise<HumanGateSurfaces>
  /**
   * Operator log line sink. Called once per configured console URL that is refused, with the
   * reason only (never the URL, which may hold a credential).
   */
  log?: (line: string) => void
}

/** Words that mark a query key as credential-like. */
const URL_SECRET_WORDS = ["token", "secret", "key", "sig", "auth", "pass", "code", "session"] as const

/**
 * Split a query key into lower-cased words on `_`, `-`, `.` and camelCase boundaries
 * (`accessToken` -> `access`, `token`; `APIKey` -> `api`, `key`).
 */
function queryKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 0)
}

/**
 * True when one word of the key is, starts with, or ends with a listed word
 * (`token`, `password`, `apikey`, `sessionid`), so `designer` or `insight` pass.
 */
export function isSecretQueryKey(key: string): boolean {
  return queryKeyWords(key).some(word =>
    URL_SECRET_WORDS.some(secret => word === secret || word.startsWith(secret) || word.endsWith(secret)),
  )
}

/** Why a console base URL produced no approval link. */
export type ApprovalUrlRefusal =
  | "missing_base"
  | "invalid_url"
  | "unsupported_scheme"
  | "credential_in_url"
  | "secret_query_key"

export type ApprovalUrlCheck = { ok: true; url: string } | { ok: false; reason: ApprovalUrlRefusal }

/**
 * Build the human approval page link (the configured console URL plus the approval id), or say
 * why none is produced: no base, not a plain http(s) URL, userinfo or fragment, credential-like
 * query key. The reason never carries the base itself.
 */
export function checkApprovalUrl(base: string | undefined, approvalId: string): ApprovalUrlCheck {
  if (!base) return { ok: false, reason: "missing_base" }
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return { ok: false, reason: "invalid_url" }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "unsupported_scheme" }
  if (url.username || url.password || url.hash) return { ok: false, reason: "credential_in_url" }
  for (const key of url.searchParams.keys()) {
    if (isSecretQueryKey(key)) return { ok: false, reason: "secret_query_key" }
  }
  url.searchParams.set("approval", approvalId)
  return { ok: true, url: url.toString() }
}

/**
 * Build the human approval page link, or undefined (no elicitation is produced) when
 * `checkApprovalUrl` refuses the base.
 */
export function buildApprovalUrl(base: string | undefined, approvalId: string): string | undefined {
  const checked = checkApprovalUrl(base, approvalId)
  return checked.ok ? checked.url : undefined
}

/**
 * Validate `content` against a flat form schema and keep only declared properties.
 * Returns `missing` for absent required fields or wrongly typed values.
 */
export function coerceFormContent(
  schema: ElicitRequestedSchema,
  content: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; missing: string[] } {
  const value: Record<string, unknown> = {}
  const missing: string[] = []
  const required = new Set(schema.required ?? [])
  for (const [key, prop] of Object.entries(schema.properties)) {
    const raw = content[key]
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.length === 0 && required.has(key))) {
      if (required.has(key)) missing.push(key)
      continue
    }
    const choices = [
      ...(prop.enum ?? []),
      ...(prop.oneOf ?? []).map(o => o.const),
    ]
    let valid = false
    if (prop.type === "array") {
      const itemChoices =
        prop.items && "enum" in prop.items ? prop.items.enum : (prop.items?.anyOf ?? []).map(o => o.const)
      valid = Array.isArray(raw) && raw.every(v => typeof v === "string" && itemChoices.includes(v))
    } else if (prop.type === "boolean") {
      valid = typeof raw === "boolean"
    } else if (prop.type === "number" || prop.type === "integer") {
      valid = typeof raw === "number" && Number.isFinite(raw) && (prop.type !== "integer" || Number.isInteger(raw))
    } else {
      valid = typeof raw === "string" && (choices.length === 0 || choices.includes(raw))
    }
    if (valid) value[key] = raw
    else missing.push(key)
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, value }
}

export function parseElicitResult(raw: unknown): ElicitResult | null {
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
  const { sessions, stateStore, onAudit, approvals, workflowRunner } = opts

  const resolveSurfaces = async (): Promise<HumanGateSurfaces> =>
    opts.surfaces ? await opts.surfaces() : { approvals: false, runs: workflowRunner !== undefined }

  // The base last reported as refused, so a bad config is logged once and not on every request.
  let reportedRefusedBase: string | undefined
  const approvalUrl = (base: string | undefined, approvalId: string): string | undefined => {
    const checked = checkApprovalUrl(base, approvalId)
    if (checked.ok) return checked.url
    if (base !== undefined && checked.reason !== "missing_base" && base !== reportedRefusedBase) {
      reportedRefusedBase = base
      try {
        opts.log?.(
          `[mcp-human-gate] approvals.uiBaseUrl refused (${checked.reason}): no approval elicitation is produced until it is fixed`,
        )
      } catch {
        // Logging must never break request handling.
      }
    }
    return undefined
  }

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
      const res = await sessions.respondPermission(
        pending.id,
        built.plan ? { decision: "deny", optionId: built.plan.rejectOptionId } : { decision: "deny" },
      )
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

    if (built.kind === "question" && built.answer) {
      // Answered by optionId (AIP-45 agent-prompt rule 3), never with `{ answers }`.
      const answer = content.answer
      if (typeof answer !== "string" || answer.trim().length === 0) return "incomplete"
      const { choiceOptionIds, freeTextOptionId } = built.answer
      const input = choiceOptionIds.includes(answer)
        ? { decision: "approve" as const, optionId: answer }
        : freeTextOptionId !== undefined
          ? { decision: "approve" as const, optionId: freeTextOptionId, feedback: answer }
          : undefined
      if (!input) return "incomplete"
      const res = await sessions.respondPermission(pending.id, input)
      audit({ principal, kind: "question", entityId: pending.id, action: "accept", applied: res.ok })
      return res.ok ? "applied" : "gone"
    }

    const decision = content.decision
    if (decision !== "approve" && decision !== "deny") return "incomplete"
    const scope = content.scope === "once" || content.scope === "always" ? content.scope : undefined
    const res = await sessions.respondPermission(
      pending.id,
      built.plan
        ? { decision, optionId: decision === "approve" ? built.plan.approveOptionId : built.plan.rejectOptionId }
        : { decision, ...(decision === "approve" && scope && built.offersAlwaysScope ? { scope } : {}) },
    )
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

  const mintApprovalInputRequired = (
    approval: { id: string; title?: string },
    url: string,
    tool: string,
    argsHash: string,
    callerSessionId: string | undefined,
  ): InputRequiredResult => {
    const requestKey = `approval_${approval.id}`
    const label = approval.title && !isSecretField("title", approval.title) ? `: ${approval.title}` : ""
    const requestState = stateStore.mint({
      kind: "approval",
      entityId: approval.id,
      requestKey,
      ...(callerSessionId !== undefined ? { callerSessionId } : {}),
      tool,
      argsHash,
    })
    return {
      resultType: "input_required",
      inputRequests: {
        [requestKey]: {
          method: "elicitation/create",
          params: {
            mode: "url",
            message: `An approval is pending${label}. Open the link to review it and decide there.`,
            url,
          },
        },
      },
      requestState,
    }
  }

  /** Form for a run parked on a human question; undefined when the schema is not in the flat non-secret subset. */
  const buildRunElicitation = (
    runId: string,
    awaiting: { stepId: string; reason?: string; prompt?: string; schema?: Record<string, unknown> },
  ): { requestKey: string; entityId: string; request: InputRequest; schema: ElicitRequestedSchema } | undefined => {
    if (awaiting.reason !== "input-required" || !awaiting.prompt || !awaiting.schema) return undefined
    if (isSecretField("prompt", awaiting.prompt)) return undefined
    const validated = validateFlatFormSchema(awaiting.schema)
    if (!validated.ok) return undefined
    const requestKey = `run_${runId}`
    return {
      requestKey,
      entityId: `${runId}:${awaiting.stepId}`,
      schema: validated.schema,
      request: {
        method: "elicitation/create",
        params: { mode: "form", message: awaiting.prompt, requestedSchema: validated.schema },
      },
    }
  }

  const mintRunInputRequired = (
    built: { requestKey: string; entityId: string; request: InputRequest },
    tool: string,
    argsHash: string,
  ): InputRequiredResult => ({
    resultType: "input_required",
    inputRequests: { [built.requestKey]: built.request },
    requestState: stateStore.mint({
      kind: "run-input",
      entityId: built.entityId,
      requestKey: built.requestKey,
      tool,
      argsHash,
    }),
  })

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

  const replayApproval = async (
    approvalId: string,
    params: Record<string, unknown>,
    tool: string,
    argsHash: string,
    callerSessionId: string | undefined,
    clientCapabilities: Record<string, unknown> | undefined,
    forward: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const surfaces = await resolveSurfaces()
    const record = approvals?.get(approvalId)
    const response = parseElicitResult(isRecord(params.inputResponses) ? params.inputResponses[`approval_${approvalId}`] : undefined)
    // An accept only says the human opened the link: it is logged as a display acknowledgement and decides nothing.
    audit({
      principal: callerSessionId ?? "operator",
      kind: "approval",
      entityId: approvalId,
      action: response?.action ?? "cancel",
      applied: false,
      detail: "display_ack",
    })
    // Only a url-capable client can receive the link, so only then is a refused base worth a log line.
    const url = clientSupportsElicitation(clientCapabilities, "url")
      ? approvalUrl(surfaces.approvalsUiBaseUrl, approvalId)
      : undefined
    const retry = response === null || response.action === "accept"
    if (surfaces.approvals && record?.status === "pending" && retry && url) {
      return mintApprovalInputRequired(record, url, tool, argsHash, callerSessionId) as unknown as Record<string, unknown>
    }
    return forward()
  }

  const replayRunInput = async (
    entityId: string,
    params: Record<string, unknown>,
    tool: string,
    argsHash: string,
    callerSessionId: string | undefined,
    forward: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    if (callerSessionId !== undefined) {
      throw refusedRetry("Caller is not permitted to resolve this input request", {
        reason: "forbidden_scope",
      })
    }
    const args = isRecord(params.arguments) ? params.arguments : {}
    const runId = typeof args.runId === "string" ? args.runId : ""
    const view = workflowRunner?.status(runId)
    const awaiting = view?.status === "awaiting-input" ? view.awaitingSuspend : undefined
    const built = awaiting ? buildRunElicitation(runId, awaiting) : undefined
    // The run moved on (resumed, cancelled, or another step is parked): nothing to apply.
    if (!workflowRunner || !built || built.entityId !== entityId) return forward()

    const response = parseElicitResult(isRecord(params.inputResponses) ? params.inputResponses[built.requestKey] : undefined)
    if (response && response.action !== "accept") {
      audit({ principal: "operator", kind: "run-input", entityId, action: response.action, applied: false, detail: "not_resumed" })
      return forward()
    }
    const coerced = response?.content ? coerceFormContent(built.schema, response.content) : undefined
    if (!coerced?.ok) {
      return mintRunInputRequired(built, tool, argsHash) as unknown as Record<string, unknown>
    }
    const res = workflowRunner.resumeSuspend(runId, { stepId: awaiting!.stepId, payload: coerced.value })
    audit({
      principal: "operator",
      kind: "run-input",
      entityId,
      action: "accept",
      applied: res.ok,
      ...(res.ok ? {} : { detail: res.error }),
    })
    return forward()
  }

  return {
    async handleToolCall(ctx, forward) {
      const { tool, params, callerSessionId, clientCapabilities } = ctx
      const hasReplay = params.requestState !== undefined || params.inputResponses !== undefined
      const argsHash = canonicalArgsHash(params)

      if (hasReplay) {
        if (typeof params.requestState !== "string" || !isRecord(params.inputResponses)) {
          throw refusedRetry("MRTR replay requires both string requestState and object inputResponses")
        }
        const verified = stateStore.verifyAndConsume(params.requestState, {
          tool,
          argsHash,
          ...(callerSessionId !== undefined ? { callerSessionId } : {}),
        })
        if (!verified.ok) {
          throw refusedRetry(verified.message, { reason: verified.reason })
        }

        const { state } = verified
        if (state.kind === "approval") {
          return replayApproval(state.entityId, params, tool, argsHash, callerSessionId, clientCapabilities, forward)
        }
        if (state.kind === "run-input") {
          return replayRunInput(state.entityId, params, tool, argsHash, callerSessionId, forward)
        }
        if (state.kind !== "permission" && state.kind !== "question") {
          throw refusedRetry("Unsupported requestState kind", { reason: "unsupported_kind" })
        }

        const pending = sessions.listPendingPermissions().find(p => p.id === state.entityId)
        if (!pending) {
          // Entity already resolved concurrently (CAS) — fall through cleanly to the original tool call.
          return forward()
        }
        if (!canCallerResolvePermission(sessions, callerSessionId, pending)) {
          throw refusedRetry("Caller is not permitted to resolve this input request", {
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

      const supportsForm = clientSupportsElicitation(clientCapabilities, "form")
      const supportsUrl = clientSupportsElicitation(clientCapabilities, "url")
      if (!supportsForm && !supportsUrl) {
        return forward()
      }

      const args = isRecord(params.arguments) ? params.arguments : {}

      if (tool === "approval_get" || tool === "approval_wait") {
        const surfaces = await resolveSurfaces()
        const id = typeof args.id === "string" ? args.id : ""
        const url = supportsUrl ? approvalUrl(surfaces.approvalsUiBaseUrl, id) : undefined
        const record = surfaces.approvals && url ? approvals?.get(id) : undefined
        if (record?.status === "pending" && url) {
          return mintApprovalInputRequired(record, url, tool, argsHash, callerSessionId) as unknown as Record<string, unknown>
        }
        return forward()
      }

      if (tool === "workflow_status") {
        // Only the operator observes a run; the parked step's own session is never asked.
        const runId = typeof args.runId === "string" ? args.runId : ""
        if (callerSessionId === undefined && supportsForm && workflowRunner && (await resolveSurfaces()).runs) {
          const view = workflowRunner.status(runId)
          const built = view?.status === "awaiting-input" && view.awaitingSuspend ? buildRunElicitation(runId, view.awaitingSuspend) : undefined
          if (built) return mintRunInputRequired(built, tool, argsHash) as unknown as Record<string, unknown>
        }
        return forward()
      }

      if (!supportsForm) return forward()

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
