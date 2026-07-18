// WP2 — Transcript render. Reduces the session's durable event records into a
// PresentedConversation (ported reducer) and renders it structurally, keyed on
// turn.id / seg.id. Text is injected as pre-escaped HTML from the presentation
// layer (never raw daemon content).

import { useEffect, useMemo, useRef, useState } from "react"

import type { SessionEventRecord } from "../data/types"
import { escapeHtml, renderMarkdown } from "./markdown"
import {
  presentConversation,
  reduceConversation,
  type PlanEntry,
  type PresentedActivitySegment,
  type PresentedConversation,
  type PresentedPlanSegment,
  type PresentedQuestionSegment,
  type PresentedSegment,
  type PresentedTextSegment,
  type PresentedToolSegment,
} from "./conversation"
import "./transcript.css"

/** Re-render once a second while `active`, so pending elapsed timers tick. */
function useSecondsTicker(active: boolean): void {
  const [, force] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
}

function elapsedSeconds(ts: string | undefined): number {
  if (!ts) return 1
  const started = Date.parse(ts)
  if (Number.isNaN(started)) return 1
  return Math.max(1, Math.round((Date.now() - started) / 1000))
}

function Html({ html, className }: { html: string; className: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
}

function ReasoningCard({ seg }: { seg: PresentedTextSegment }) {
  return (
    <details className="reasoning">
      <summary className="re-summary">
        <span className="gi">✳</span>Reasoning<span className="chev">▸</span>
      </summary>
      <Html className="re-body" html={seg.html} />
    </details>
  )
}

function ToolCard({ seg }: { seg: PresentedToolSegment }) {
  const badge =
    seg.status === "pending" ? (
      <span className="badge pending" />
    ) : seg.status === "error" ? (
      <span className="badge error">✗</span>
    ) : (
      <span className="badge ok">✓</span>
    )
  const firstArgLine = seg.argsText ? seg.argsText.split("\n")[0] : ""
  const hasBody = Boolean(seg.argsText || seg.resultText)
  return (
    <details className="tool">
      <summary className="tl-summary">
        {badge}
        <span className="tl-name">{seg.toolName ?? "tool"}</span>
        <span className="tl-arg" dangerouslySetInnerHTML={{ __html: firstArgLine }} />
        {seg.status === "pending" ? (
          <span className="tl-elapsed">
            {elapsedSeconds(seg.ts) > 10 ? "still running · " : "running · "}
            {elapsedSeconds(seg.ts)}s
          </span>
        ) : null}
        <span className="chev">▸</span>
      </summary>
      {hasBody ? (
        <div className="tl-body">
          {seg.argsText ? (
            <>
              <div className="io-lab">input</div>
              <div className="io" dangerouslySetInnerHTML={{ __html: seg.argsText }} />
              {seg.argsClamped ? (
                <div className="io-more">⤢ open full input ({(seg.argsLines ?? 0) - 3} more lines)</div>
              ) : null}
            </>
          ) : null}
          {seg.resultText ? (
            <>
              <div className="io-lab">output</div>
              <div
                className={`io${seg.isError ? " err" : ""}`}
                dangerouslySetInnerHTML={{ __html: seg.resultText }}
              />
              {seg.resultClamped ? (
                <div className="io-more">
                  ⤢ open full output ({(seg.resultLines ?? 0) - 3} more lines)
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}

const PLAN_BOX: Record<string, string> = { completed: "✔", in_progress: "◐" }
function planClass(status: string): string {
  if (status === "completed") return "done"
  if (status === "in_progress") return "now"
  return "todo"
}
function planBox(status: string): string {
  return PLAN_BOX[status] ?? "○"
}

function PlanCard({ seg }: { seg: PresentedPlanSegment }) {
  return (
    <div className="plan">
      <h4>
        Plan{" "}
        <span className="n">
          {seg.done}/{seg.total}
        </span>
      </h4>
      <ul>
        {seg.entries.map((e: PlanEntry, i) => (
          <li key={i} className={planClass(e.status)}>
            <span className="bx">{planBox(e.status)}</span>
            {e.content}
          </li>
        ))}
      </ul>
    </div>
  )
}

function QuestionCard({ seg }: { seg: PresentedQuestionSegment }) {
  return (
    <div className="card card--input">
      <div className="ph">＋ Agent is asking</div>
      <div className="pa">
        {seg.options.length > 0 ? (
          seg.options.map((o, i) => (
            <button key={i} className={i === 0 ? "btn ghost" : "btn"}>
              {o}
            </button>
          ))
        ) : (
          <button className="btn">Respond</button>
        )}
      </div>
    </div>
  )
}

function ActivityGroup({ seg }: { seg: PresentedActivitySegment }) {
  const badge =
    seg.status === "pending" ? (
      <span className="badge pending" style={{ width: 13, height: 13 }} />
    ) : (
      <span className="gi">⚙</span>
    )
  return (
    <details className="activity">
      <summary className="act-summary">
        {badge}
        <span className="lab">{seg.status === "pending" ? "Thinking" : "Steps"}</span>
        <span className="n">· {seg.summary}</span>
        <span className="chev">▸</span>
      </summary>
      <div className="act-children">
        {seg.children.map((child) =>
          child.kind === "tool" ? (
            <ToolCard key={child.id} seg={child} />
          ) : (
            <ReasoningCard key={child.id} seg={child} />
          ),
        )}
      </div>
    </details>
  )
}

function SegmentView({ seg }: { seg: PresentedSegment }) {
  switch (seg.kind) {
    case "user":
    case "assistant-text":
      return <Html className="msg" html={seg.html} />
    case "reasoning":
      return <ReasoningCard seg={seg} />
    case "tool":
      return <ToolCard seg={seg} />
    case "plan":
      return <PlanCard seg={seg} />
    case "agent-question":
      return <QuestionCard seg={seg} />
    case "error":
      return (
        <div className="card card--err">
          <div className="ph">⚠ Error</div>
          <div className="pd" dangerouslySetInnerHTML={{ __html: seg.text }} />
        </div>
      )
    case "activity":
      return <ActivityGroup seg={seg} />
  }
}

interface TranscriptProps {
  sessionId: string
  records: readonly SessionEventRecord[]
}

export function Transcript({ sessionId, records }: TranscriptProps) {
  const presented: PresentedConversation = useMemo(
    () => presentConversation(reduceConversation(sessionId, records), { renderMarkdown, escapeHtml }),
    [sessionId, records],
  )

  const hasPending = useMemo(
    () =>
      presented.turns.some((t) =>
        t.segments.some(
          (s) =>
            (s.kind === "tool" && s.status === "pending") ||
            (s.kind === "activity" && s.status === "pending"),
        ),
      ),
    [presented],
  )
  useSecondsTicker(hasPending)

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [presented])

  if (presented.turns.length === 0) {
    return <div className="transcript-empty">No transcript yet for this session.</div>
  }

  return (
    <div className="transcript" ref={scrollRef}>
      {presented.turns.map((turn) => (
        <div className="turn" key={turn.id}>
          <div className={`avatar ${turn.role === "user" ? "user" : "agent"}`}>
            {turn.role === "user" ? "JA" : "◇"}
          </div>
          <div className="bubble">
            <div className="who">{turn.role === "user" ? "you" : "agent"}</div>
            {turn.segments.map((seg) => (
              <SegmentView key={seg.id} seg={seg} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
