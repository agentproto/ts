/**
 * Pure heuristic module that folds an exported session's messages into a
 * "story": chapters (inferred sub-tasks) + steps (one per fixed-height feed
 * row). Backs the `agentproto_session_story` MCP app panel.
 *
 * v1 = pure heuristics, NO LLM. Everything here is deterministic and
 * unit-testable so a future LLM-backed chaptering/summarizing pass can
 * replace the internals behind the same `buildStory(messages) => Story`
 * interface (mirrors the summarize_session heuristic → LLM swap path
 * described in agents-overview-app.ts).
 *
 * Folding rule (mirrors transcript-export.ts's own batching): an assistant
 * message plus every immediately-following `role: "tool"` message collapse
 * into ONE step. A user message is always its own step, and is also a
 * candidate chapter boundary.
 */

import { formatToolCall, formatToolResult } from "./tool-presenter.js"
import type { ExportedMessage } from "./transcript-export.js"

export type StoryStepKind = "text" | "edit" | "bash" | "read" | "user"
export type ChapterStatus = "done" | "cur"
export type RouteVerdict = "cont" | "newt"

export interface StoryChapter {
  id: string
  title: string
  status: ChapterStatus
}

export type StoryItem = { text: string } | { h: string; r: string }

export interface StoryStep {
  chap: string
  kind: StoryStepKind
  /** HH:MM:SS (UTC) when the source message carried a `ts`, else "". */
  ts: string
  sum: string
  raw1: string
  count: number
  facts: string[]
  items: StoryItem[]
  route?: RouteVerdict
}

export interface Story {
  chapters: StoryChapter[]
  steps: StoryStep[]
}

// ── formatting helpers ───────────────────────────────────────────────────

function formatTs(ts?: number): string {
  if (ts === undefined || Number.isNaN(ts)) return ""
  return new Date(ts).toISOString().slice(11, 19)
}

function firstMeaningfulLine(text?: string): string | undefined {
  if (!text) return undefined
  const line = text
    .split("\n")
    .map(l => l.trim())
    .find(l => l.length > 0)
  return line
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function parseArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson)
  } catch {
    return {}
  }
}

function lineCount(text: string): number {
  return text.split("\n").filter(l => l.trim().length > 0).length || 1
}

// ── kind classification ──────────────────────────────────────────────────

/** Dominant kind for a group of tool calls: edit/write → edit, bash/terminal/
 *  command → bash, read/grep/glob → read, else text (pure assistant text). */
export function classifyKind(toolCalls?: readonly { name: string }[]): StoryStepKind {
  if (!toolCalls || toolCalls.length === 0) return "text"
  const names = toolCalls.map(t => t.name.toLowerCase())
  if (names.some(n => /edit|write/.test(n))) return "edit"
  if (names.some(n => /bash|terminal|command/.test(n))) return "bash"
  if (names.some(n => /read|grep|glob/.test(n))) return "read"
  return "text"
}

// ── chapter routing (mockup's `classify()`, ported verbatim) ────────────

const NEW_CHAPTER_RE =
  /\b(aussi|autre|ensuite|nouveau|nouvelle|plut[oô]t|maintenant|apr[eè]s ça|il faudrait|peux[- ]tu|on pourrait|ajoute|g[eè]re)\b/iu

export function classifyRoute(text: string): { route: RouteVerdict; title?: string } {
  const newt = NEW_CHAPTER_RE.test(text)
  if (!newt) return { route: "cont" }
  const title = text.replace(/[.?!].*$/, "").slice(0, 42)
  return { route: "newt", title }
}

// ── folding: raw messages → steps (chapter unassigned) ───────────────────

interface FoldedStep {
  kind: StoryStepKind
  ts: string
  sum: string
  raw1: string
  count: number
  facts: string[]
  items: StoryItem[]
  /** Present only for user steps — drives chapter routing. */
  userText?: string
}

function foldToolStep(assistant: ExportedMessage, toolResults: ExportedMessage[]): FoldedStep {
  const toolCalls = assistant.toolCalls ?? []
  const kind = classifyKind(toolCalls)
  const count = toolCalls.length || 1

  const items: StoryItem[] = []
  const facts: string[] = []
  if (assistant.text?.trim()) items.push({ text: assistant.text.trim() })
  toolCalls.forEach((tc, i) => {
    const args = parseArgs(tc.args)
    const h = formatToolCall(tc.name, args)
    const resultMsg = toolResults[i]
    const resultText = resultMsg?.text ?? ""
    const isError = resultText.startsWith("[error]")
    const r = isError ? resultText.slice("[error]".length).trim() : resultText
    items.push({ h, r })
    const fact = formatToolResult(tc.name, r, isError)
    if (fact) facts.push(fact)
  })

  const firstLine = firstMeaningfulLine(assistant.text)
  const firstToolCall = toolCalls[0]
  const sum =
    firstLine ??
    (firstToolCall ? formatToolCall(firstToolCall.name, parseArgs(firstToolCall.args)) : "…")

  let raw1: string
  if (toolCalls.length === 0) {
    raw1 = `assistant · ${lineCount(assistant.text ?? "")} ligne(s)`
  } else if (toolCalls.length === 1 && firstToolCall) {
    raw1 = formatToolCall(firstToolCall.name, parseArgs(firstToolCall.args))
  } else {
    raw1 = `${firstToolCall?.name ?? "tool"} ×${toolCalls.length}`
  }

  return {
    kind,
    ts: formatTs(assistant.ts),
    sum,
    raw1,
    count,
    facts,
    items,
  }
}

function foldUserStep(msg: ExportedMessage): FoldedStep {
  const text = msg.text ?? ""
  const sum = `« ${truncate(text, 80)} »`
  return {
    kind: "user",
    ts: formatTs(msg.ts),
    sum,
    raw1: `user · ${lineCount(text)} ligne(s)`,
    count: 1,
    facts: [],
    items: [{ text }],
    userText: text,
  }
}

function foldOrphanToolStep(msg: ExportedMessage): FoldedStep {
  const text = msg.text ?? ""
  const isError = text.startsWith("[error]")
  const r = isError ? text.slice("[error]".length).trim() : text
  const name = msg.toolName ?? "tool"
  const fact = formatToolResult(name, r, isError)
  return {
    kind: classifyKind([{ name }]),
    ts: formatTs(msg.ts),
    sum: msg.toolName ? `${msg.toolName} · résultat` : "Résultat d'outil",
    raw1: msg.toolName ?? "tool",
    count: 1,
    facts: fact ? [fact] : [],
    items: [{ h: name, r }],
  }
}

function foldSystemStep(msg: ExportedMessage): FoldedStep {
  const text = msg.text ?? ""
  return {
    kind: "text",
    ts: formatTs(msg.ts),
    sum: firstMeaningfulLine(text) ?? text,
    raw1: "system",
    count: 1,
    facts: [],
    items: text ? [{ text }] : [],
  }
}

function foldMessages(messages: readonly ExportedMessage[]): FoldedStep[] {
  const steps: FoldedStep[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]!
    if (msg.role === "user") {
      steps.push(foldUserStep(msg))
      i += 1
      continue
    }
    if (msg.role === "assistant") {
      let j = i + 1
      const toolResults: ExportedMessage[] = []
      while (j < messages.length && messages[j]!.role === "tool") {
        toolResults.push(messages[j]!)
        j += 1
      }
      steps.push(foldToolStep(msg, toolResults))
      i = j
      continue
    }
    if (msg.role === "tool") {
      // Orphan tool result with no preceding assistant message — rare, but
      // render it as its own read-only step rather than dropping data.
      steps.push(foldOrphanToolStep(msg))
      i += 1
      continue
    }
    // system
    steps.push(foldSystemStep(msg))
    i += 1
  }
  return steps
}

// ── chaptering: assign each folded step to a chapter ─────────────────────

export function buildStory(messages: readonly ExportedMessage[]): Story {
  const folded = foldMessages(messages)
  const chapters: StoryChapter[] = []
  const steps: StoryStep[] = []

  let currentChapterId: string | undefined
  let sawFirstUser = false

  const closeCurrent = (): void => {
    const cur = chapters.find(c => c.id === currentChapterId)
    if (cur) cur.status = "done"
  }
  const openChapter = (title: string): string => {
    const id = `c${chapters.length + 1}`
    chapters.push({ id, title, status: "cur" })
    return id
  }

  for (const step of folded) {
    let route: RouteVerdict | undefined
    if (step.kind === "user" && step.userText !== undefined) {
      if (!sawFirstUser) {
        sawFirstUser = true
        currentChapterId = openChapter("Cadrage")
      } else {
        const verdict = classifyRoute(step.userText)
        route = verdict.route
        if (verdict.route === "newt") {
          closeCurrent()
          currentChapterId = openChapter(verdict.title || "Nouvelle sous-tâche")
        }
      }
    } else if (currentChapterId === undefined) {
      // Transcript opens with assistant/system output before any user
      // message (unusual, but keep every step chaptered).
      currentChapterId = openChapter("Cadrage")
    }

    steps.push({
      chap: currentChapterId!,
      kind: step.kind,
      ts: step.ts,
      sum: step.sum,
      raw1: step.raw1,
      count: step.count,
      facts: step.facts,
      items: step.items,
      ...(route ? { route } : {}),
    })
  }

  return { chapters, steps }
}
