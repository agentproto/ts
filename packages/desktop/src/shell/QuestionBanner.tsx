// Structured-question banner — when the selected session is awaiting input
// with a known question (context-continuity's continue-fresh/keep-going
// prompt, or any other structured/heuristic awaitingQuestion the daemon
// derives), show the question text and one button per option instead of
// leaving the composer blank. Clicking a button sends that option's exact
// text through the normal prompt path — the daemon's structured-question
// dispatch (sessions.ts) recognizes an exact option match as an answer.

import { useState } from "react"

import { daemonPrompt } from "../data/daemon"
import { questionView } from "../data/session-view"
import type { SessionDescriptor } from "../data/types"

interface QuestionBannerProps {
  session: SessionDescriptor
  daemonUrl?: string
}

export function QuestionBanner({ session, daemonUrl }: QuestionBannerProps) {
  const [sending, setSending] = useState<string | null>(null)
  const question = questionView(session)
  if (!question) return null

  const answer = async (option: string) => {
    setSending(option)
    try {
      await daemonPrompt(session.id, option, daemonUrl)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("daemonPrompt (question answer) failed:", e)
    } finally {
      setSending(null)
    }
  }

  return (
    <div className="question-banner">
      <div className="question-card">
        <div className="question-text">{question.text}</div>
        {question.options.length > 0 ? (
          <div className="question-options">
            {question.options.map((option) => (
              <button
                key={option}
                className="btn ghost xs"
                disabled={sending !== null}
                onClick={() => void answer(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
