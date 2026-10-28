// AIP-45 typed `agent-prompt` requests and `mode-changed` events, read at the
// daemon's JSON boundary. A prompt with no (or an unusable) typed payload is a
// plain tool permission: `parseAgentPrompt` returns undefined and every caller
// keeps its pre-AIP-45 rendering, which is what an older daemon sends.

export interface PromptChoice {
  optionId: string
  label: string
  description?: string
}

export interface QuestionPrompt {
  request: "question"
  prompt: string
  choices: PromptChoice[]
  /** The option that carries a free-text answer in the resolution's `feedback`. */
  freeTextOptionId?: string
}

export interface PlanApprovalPrompt {
  request: "plan-approval"
  plan?: string
  planRef?: string
  targetModeId?: string
  approveOptionId: string
  rejectOptionId: string
}

export type TypedAgentPrompt = QuestionPrompt | PlanApprovalPrompt

export interface AgentPromptInput {
  request?: unknown
  question?: unknown
  planApproval?: unknown
  /** The prompt's offered options; when given, a typed payload may only name these. */
  options?: unknown
}

/** What the webview posts back for one answer (the resolveQuestion payload minus its ids). */
export interface PromptAnswer {
  decision: "approve" | "deny"
  optionId: string
  feedback?: string
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** The optionIds a prompt offers, or undefined when the options were not sent. */
function offeredIds(options: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(options)) return undefined
  const ids = new Set<string>()
  for (const o of options) {
    const id = str(asObject(o)?.optionId)
    if (id) ids.add(id)
  }
  return ids
}

/** The typed request of a prompt, or undefined for a tool permission. */
export function parseAgentPrompt(input: AgentPromptInput): TypedAgentPrompt | undefined {
  const offered = offeredIds(input.options)
  const isOffered = (id: string): boolean => offered === undefined || offered.has(id)

  if (input.request === "question") {
    const q = asObject(input.question)
    const prompt = str(q?.prompt)
    if (!q || !prompt || !Array.isArray(q.choices)) return undefined
    const choices: PromptChoice[] = []
    for (const c of q.choices) {
      const o = asObject(c)
      const optionId = str(o?.optionId)
      const label = str(o?.label)
      if (!o || !optionId || !label || !isOffered(optionId)) continue
      const description = str(o.description)
      choices.push({ optionId, label, ...(description ? { description } : {}) })
    }
    const freeTextOptionId = str(q.freeTextOptionId)
    return {
      request: "question",
      prompt,
      choices,
      ...(q.allowFreeText === true && freeTextOptionId && isOffered(freeTextOptionId)
        ? { freeTextOptionId }
        : {}),
    }
  }

  if (input.request === "plan-approval") {
    const p = asObject(input.planApproval)
    const approveOptionId = str(p?.approveOptionId)
    const rejectOptionId = str(p?.rejectOptionId)
    if (!p || !approveOptionId || !rejectOptionId) return undefined
    if (!isOffered(approveOptionId) || !isOffered(rejectOptionId)) return undefined
    const plan = str(p.plan)
    const planRef = str(p.planRef)
    const targetModeId = str(p.targetModeId)
    return {
      request: "plan-approval",
      ...(plan ? { plan } : {}),
      ...(planRef ? { planRef } : {}),
      ...(targetModeId ? { targetModeId } : {}),
      approveOptionId,
      rejectOptionId,
    }
  }

  return undefined
}

/** A pick among a question's choices (or any offered option). */
export function answerChoice(optionId: string): PromptAnswer {
  return { decision: "approve", optionId }
}

/** A typed answer; undefined when the question takes no free text or the text is blank. */
export function answerFreeText(view: QuestionPrompt, text: string): PromptAnswer | undefined {
  const feedback = text.trim()
  if (!view.freeTextOptionId || !feedback) return undefined
  return { decision: "approve", optionId: view.freeTextOptionId, feedback }
}

/** Approve or reject a plan; feedback only travels with a rejection. */
export function answerPlan(
  view: Pick<PlanApprovalPrompt, "approveOptionId" | "rejectOptionId">,
  verdict: "approve" | "reject",
  feedback?: string,
): PromptAnswer {
  if (verdict === "approve") return { decision: "approve", optionId: view.approveOptionId }
  const reason = feedback?.trim()
  return { decision: "deny", optionId: view.rejectOptionId, ...(reason ? { feedback: reason } : {}) }
}

export interface ModeChange {
  modeId: string
  previousModeId?: string
  cause?: string
  reason?: string
}

/** The transcript row for a mode change: "Mode: plan -> execute · by agent · plan approved". */
export function modeChangedLabel(change: ModeChange): string {
  const parts = [
    change.previousModeId ? `Mode: ${change.previousModeId} -> ${change.modeId}` : `Mode: ${change.modeId}`,
  ]
  if (change.cause === "agent") parts.push("by agent")
  if (change.reason) parts.push(change.reason)
  return parts.join(" · ")
}
