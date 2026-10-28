// Permission banner — polls surface pending ACP permission requests for the
// selected session. Each option is answered via POST /permissions/:id with the
// optionId and a decision inferred from the option's kind. ACP option kinds are
// allow_once / allow_always / reject_once / reject_always, so reject_* → deny and
// everything else → approve (matching the VS Code client's approval semantics).
//
// AIP-45 typed prompts ride the same response path: a `question` shows its
// choices (and a text field when it takes free text), a `plan-approval` shows
// the plan with Approve / Reject. A prompt without a usable typed payload keeps
// the plain option buttons.

import { useState } from "react"

import {
  answerChoice,
  answerFreeText,
  answerPlan,
  parseAgentPrompt,
  type PlanApprovalPrompt,
  type QuestionPrompt,
} from "../data/agent-prompt"
import { respondPermission } from "../data/daemon"
import type { PendingPermission, RespondPermissionInput } from "../data/types"
import { renderMarkdown } from "../transcript/markdown"

interface PermissionBannerProps {
  permissions: PendingPermission[]
  onResponded: () => void
  daemonUrl?: string
}

function decisionForOption(kind: string | undefined): "approve" | "deny" {
  if (typeof kind === "string" && kind.startsWith("reject_")) return "deny"
  return "approve"
}

type Respond = (input: RespondPermissionInput) => Promise<void>

function QuestionBody({
  prompt,
  others,
  respond,
}: {
  prompt: QuestionPrompt
  /** Offered options that are neither a choice nor the free-text one (decline). */
  others: PendingPermission["options"]
  respond: Respond
}) {
  const [text, setText] = useState("")
  const answer = answerFreeText(prompt, text)
  return (
    <>
      <div className="perm-text">{prompt.prompt}</div>
      <div className="perm-options">
        {prompt.choices.map((choice) => (
          <button
            key={choice.optionId}
            className="btn ghost xs"
            title={choice.description}
            onClick={() => void respond(answerChoice(choice.optionId))}
          >
            {choice.label}
          </button>
        ))}
        {others.map((opt) => (
          <button
            key={opt.optionId}
            className="btn ghost xs"
            onClick={() => void respond({ decision: decisionForOption(opt.kind), optionId: opt.optionId })}
          >
            {opt.name || opt.optionId}
          </button>
        ))}
      </div>
      {prompt.freeTextOptionId ? (
        <form
          className="perm-reply"
          onSubmit={(e) => {
            e.preventDefault()
            if (answer) void respond(answer)
          }}
        >
          <input
            value={text}
            placeholder="Type your answer"
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn ghost xs" disabled={!answer}>
            Send
          </button>
        </form>
      ) : null}
    </>
  )
}

function PlanBody({ prompt, respond }: { prompt: PlanApprovalPrompt; respond: Respond }) {
  const [feedback, setFeedback] = useState("")
  return (
    <>
      {prompt.plan ? (
        <div className="perm-plan" dangerouslySetInnerHTML={{ __html: renderMarkdown(prompt.plan) }} />
      ) : null}
      {prompt.planRef ? <div className="perm-text">Plan: {prompt.planRef}</div> : null}
      {prompt.targetModeId ? (
        <div className="perm-text">Approving switches to {prompt.targetModeId} mode.</div>
      ) : null}
      <div className="perm-options">
        <button className="btn ghost xs" onClick={() => void respond(answerPlan(prompt, "approve"))}>
          Approve
        </button>
        <button
          className="btn ghost xs"
          onClick={() => void respond(answerPlan(prompt, "reject", feedback))}
        >
          Reject
        </button>
      </div>
      <div className="perm-reply">
        <input
          value={feedback}
          placeholder="Feedback on reject (optional)"
          onChange={(e) => setFeedback(e.target.value)}
        />
      </div>
    </>
  )
}

function otherOptions(perm: PendingPermission, prompt: QuestionPrompt): PendingPermission["options"] {
  const covered = new Set(prompt.choices.map((c) => c.optionId))
  if (prompt.freeTextOptionId) covered.add(prompt.freeTextOptionId)
  return perm.options.filter((o) => !covered.has(o.optionId))
}

export function PermissionBanner({ permissions, onResponded, daemonUrl }: PermissionBannerProps) {
  const respond = async (permission: PendingPermission, input: RespondPermissionInput) => {
    try {
      await respondPermission(permission.id, input, daemonUrl)
      onResponded()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("respondPermission failed:", e)
    }
  }

  if (permissions.length === 0) return null

  return (
    <div className="perm-banner">
      {permissions.map((perm) => {
        const typed = parseAgentPrompt(perm)
        const answer: Respond = (input) => respond(perm, input)
        return (
          <div key={perm.id} className="perm-card">
            <div className="perm-meta">
              {perm.toolName ? <span className="perm-tool">{perm.toolName}</span> : null}
              <span className="perm-when">{perm.requestedAt}</span>
            </div>
            {typed?.request === "question" ? (
              <QuestionBody prompt={typed} others={otherOptions(perm, typed)} respond={answer} />
            ) : typed?.request === "plan-approval" ? (
              <PlanBody prompt={typed} respond={answer} />
            ) : (
              <>
                <div className="perm-text">{perm.text}</div>
                <div className="perm-options">
                  {perm.options.map((opt) => (
                    <button
                      key={opt.optionId}
                      className="btn ghost xs"
                      onClick={() =>
                        void answer({ decision: decisionForOption(opt.kind), optionId: opt.optionId })
                      }
                    >
                      {opt.name || opt.optionId}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
