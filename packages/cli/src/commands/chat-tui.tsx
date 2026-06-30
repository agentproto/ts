/**
 * `agentproto chat-tui <adapter>` — the same daemon-hosted chat loop as
 * `chat`, but rendered as a split-pane TUI with Ink (React for CLIs).
 *
 * Where `chat` interleaves a readline prompt with raw stream lines, this
 * surface gives you a scrolling, styled history (alternating `you ›` /
 * `agent ›` turns), a live "thinking…" spinner while the agent streams,
 * dimmed `[tool]` lines, and a bottom input box that disables itself for the
 * duration of an in-flight turn.
 *
 *   agentproto chat-tui mastra-agent --model anthropic/claude-sonnet-4-6
 *   agentproto chat-tui claude-code --cwd .
 *
 * The session is spawned fresh and killed on exit (`/exit`, Ctrl-C) unless
 * `--keep` is passed. All rendering of agent output already happens in the
 * daemon; we just classify each SSE line and lay it out.
 */
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import http from "node:http"
import https from "node:https"
import { useEffect, useRef, useState } from "react"
import { Box, Static, Text, render, useApp, useInput } from "ink"
import TextInput from "ink-text-input"
import Spinner from "ink-spinner"
import { marked, type Renderer } from "marked"
import TerminalRenderer from "marked-terminal"
import { highlight } from "cli-highlight"
import type { SessionDescriptor } from "@agentproto/runtime"
import {
  discoverDaemon,
  printNoDaemonError,
  httpPostJson,
  type DaemonEndpoint,
} from "./_daemon-helpers.js"
import { classifyChatLine } from "./chat.js"

// Configure marked once for terminal (ANSI) output. Ink passes ANSI codes
// through transparently, so a finalized agent turn can be rendered as a
// single styled string.
// `@types/marked-terminal`'s renderer predates marked 14's `Renderer`
// shape, so cast across the version gap — the runtime contract is intact.
// marked-terminal renders fenced code blocks via its renderer's `code` method.
// The constructor options only expose a chalk *style* for code (not a renderer
// fn), so override the method on the instance to run cli-highlight for ANSI
// syntax colors. Cast across the @types/marked-terminal version gap.
const terminalRenderer = new TerminalRenderer() as unknown as {
  code: (code: string, lang?: string) => string
  codespan: (text: string) => string
}
terminalRenderer.code = (code: string, lang?: string): string => {
  let body: string
  try {
    // cli-highlight has no "auto" language; omit `language` to let it detect.
    const opts = lang
      ? { language: lang, ignoreIllegals: true }
      : { ignoreIllegals: true }
    body = highlight(code, opts)
  } catch {
    body = code
  }
  return `\n${body}\n\n`
}
// marked-terminal's default codespan keeps literal backticks; render inline
// code as plain ANSI yellow instead (no backticks), matching most renderers.
terminalRenderer.codespan = (text: string): string => `\x1b[33m${text}\x1b[0m`
marked.setOptions({ renderer: terminalRenderer as unknown as Renderer })

const USAGE = `agentproto chat-tui — Ink TUI over a daemon agent session

Usage:
  agentproto chat-tui <adapter> [--model <id>] [--cwd <dir>] [--workspace <slug>]
                                [--label <text>] [--system <text>] [--keep]

Examples:
  agentproto chat-tui mastra-agent --model anthropic/claude-sonnet-4-6
  agentproto chat-tui claude-code --cwd .
  agentproto chat-tui claude-code --system "Answer in French."

Options:
  --system <text>  Override the default CLI formatting prompt (injected as a
                   silent first turn). Pass --system "" to disable it.

In-session commands:
  /exit, /quit   end the chat (and stop the session unless --keep)
  Ctrl-C         same as /exit

Needs a running daemon (\`agentproto serve\`). Each typed line is one turn;
the agent's reply streams back live into the history pane.`

/** A `you ›` turn — a single typed prompt. */
type UserMsg = { kind: "user"; lines: string[] }
/** An `agent ›` turn. Accumulates `lines` as the SSE stream arrives;
 *  `streaming` flips false at the turn boundary. */
type AgentMsg = { kind: "agent"; lines: string[]; streaming: boolean }
/** The one-shot session header, rendered once via `<Static>` so it doesn't
 *  re-appear above every appended history item (Ink re-renders the live tree). */
type HeaderMsg = { kind: "header"; text: string }
type Msg = UserMsg | AgentMsg | HeaderMsg

/** Tool / structured daemon lines render with a `⚙` gutter. They arrive already
 *  bracketed (`[tool:…]`, `[thought]`, etc.) from the runtime projector. */
function isToolLine(line: string): boolean {
  const t = line.trimStart()
  return (
    t.startsWith("[tool:") ||
    t.startsWith("[tool]") ||
    t.startsWith("[thought]") ||
    t.startsWith("[awaiting input]") ||
    t.startsWith("[error]") ||
    t.startsWith("[session")
  )
}

/** A completed turn, split into interleaved tool lines and prose runs so the
 *  original ordering (text → tool → text) is preserved. Markdown is rendered
 *  per contiguous prose run; tool lines stay plain between them. */
type Part =
  | { kind: "tool"; line: string }
  | { kind: "prose"; rendered: string }

function buildParts(lines: string[]): Part[] {
  const parts: Part[] = []
  let proseBuffer: string[] = []
  const flushProse = (): void => {
    if (proseBuffer.length === 0) return
    const raw = proseBuffer.join("\n")
    const cleaned = raw
      // Strip ** wrappers around inline code spans — marked-terminal doesn't
      // handle **`code`** cleanly.
      .replace(/\*\*(`[^`\n]+`)\*\*/g, "$1")
      // Force a blank line before headings the agent ran into prose (e.g.
      // "…done!## Header") so marked recognizes them as headings.
      .replace(/([^\n])(#{1,6} )/g, "$1\n\n$2")
    const rendered = String(marked.parse(cleaned, { async: false }))
      // If marked-terminal leaves literal **, strip them as a safety net.
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    if (rendered.trim()) parts.push({ kind: "prose", rendered: rendered.trimEnd() })
    proseBuffer = []
  }
  for (const line of lines) {
    if (isToolLine(line)) {
      flushProse()
      parts.push({ kind: "tool", line })
    } else {
      proseBuffer.push(line)
    }
  }
  flushProse()
  return parts
}

function LineText({ line }: { line: string }): React.ReactElement {
  if (isToolLine(line)) {
    return (
      <Text color="cyan" dimColor>
        ⚙ {line}
      </Text>
    )
  }
  return <Text>{line}</Text>
}

function MessageView({ msg }: { msg: Msg }): React.ReactElement {
  if (msg.kind === "header") {
    return <Text dimColor>{msg.text}</Text>
  }
  if (msg.kind === "user") {
    return (
      <Box>
        <Text bold color="cyan">
          you ›{" "}
        </Text>
        <Text>{msg.lines.join("\n")}</Text>
      </Box>
    )
  }
  // Completed turn: render markdown prose as ANSI-styled text, keeping tool
  // lines plain and inline so the original text↔tool ordering is preserved.
  if (!msg.streaming) {
    const parts = buildParts(msg.lines)
    return (
      <Box flexDirection="column">
        <Text color="gray" dimColor>
          agent ›
        </Text>
        {parts.map((part, i) =>
          part.kind === "tool" ? (
            <LineText key={i} line={part.line} />
          ) : (
            <Text key={i}>{part.rendered}</Text>
          ),
        )}
      </Box>
    )
  }
  // Streaming: plain text — incomplete markdown can't be parsed.
  return (
    <Box flexDirection="column">
      <Text color="gray" dimColor>
        agent ›
      </Text>
      {msg.lines.map((line, i) => (
        <LineText key={i} line={line} />
      ))}
    </Box>
  )
}

interface AppProps {
  endpoint: DaemonEndpoint
  desc: SessionDescriptor
  slug: string
  systemPrompt?: string
}

function ChatApp({
  endpoint,
  desc,
  slug,
  systemPrompt,
}: AppProps): React.ReactElement {
  const { exit } = useApp()
  const [messages, setMessages] = useState<Msg[]>(() => [
    {
      kind: "header",
      text: `─ chat · ${slug}${desc.model ? ` · ${desc.model}` : ""} · session ${desc.id} ─`,
    },
  ])
  const [turnInFlight, setTurnInFlight] = useState(false)
  const [input, setInput] = useState("")
  // Setup phase: while a system prompt is being injected as a silent first
  // turn, swallow the agent's response so it never reaches the UI.
  const [setupPhase, setSetupPhase] = useState(Boolean(systemPrompt))
  const setupRef = useRef(Boolean(systemPrompt))
  setupRef.current = setupPhase
  // Hard-stop for the silent setup turn: if its boundary never arrives (agent
  // crash, dropped stream), this fires so the input doesn't wedge forever.
  const setupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const endSetup = (): void => {
    if (setupTimeoutRef.current) {
      clearTimeout(setupTimeoutRef.current)
      setupTimeoutRef.current = null
    }
    setupRef.current = false
    setSetupPhase(false)
    setTurnInFlight(false)
  }
  const endSetupRef = useRef(endSetup)
  endSetupRef.current = endSetup
  // Keep the live flag readable inside the (stable) line handler.
  const turnRef = useRef(false)
  turnRef.current = turnInFlight

  // ── SSE output stream (opened outside React, pushes into state) ──────────
  useEffect(() => {
    const url = new URL(`${endpoint.url}/sessions/${desc.id}/stream`)
    const lib = url.protocol === "https:" ? https : http
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (endpoint.token) headers.authorization = `Bearer ${endpoint.token}`

    const appendLine = (line: string): void => {
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last && last.kind === "agent" && last.streaming) {
          const next = prev.slice(0, -1)
          next.push({ ...last, lines: [...last.lines, line] })
          return next
        }
        return [...prev, { kind: "agent", lines: [line], streaming: true }]
      })
    }

    const endTurn = (): void => {
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last && last.kind === "agent" && last.streaming) {
          const next = prev.slice(0, -1)
          next.push({ ...last, streaming: false })
          return next
        }
        return prev
      })
      setTurnInFlight(false)
    }

    // eslint-disable-next-line no-control-regex
    const ANSI = /\x1b\[[0-9;]*m/g
    const handleLine = (raw: string): void => {
      const plain = raw.replace(ANSI, "")
      // Drop the daemon's per-session banner (`── … agent session … ──`); it
      // re-emits on every render and isn't agent content.
      if (/^── .+ agent session .+──/.test(plain)) return
      // Drop the daemon's prompt-echo frame (`—— ► <prompt> ——`). The daemon
      // uses em-dashes (U+2014), not box-drawing dashes, so match any dash run.
      if (/^[─—–\s]* ► .+/.test(plain)) return
      const { turnBoundary, suppress } = classifyChatLine(raw)
      // During the silent setup turn, swallow every line; the only thing we
      // care about is its boundary, which ends the suppression.
      if (setupRef.current) {
        if (turnBoundary) endSetupRef.current()
        return
      }
      if (!suppress) appendLine(raw)
      if (turnBoundary) endTurn()
    }

    const req = lib.get(url, { headers }, res => {
      if (res.statusCode !== 200) {
        appendLine(`[error] stream HTTP ${res.statusCode}`)
        return
      }
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", chunk => {
        buf += chunk
        let idx = buf.indexOf("\n\n")
        while (idx !== -1) {
          const event = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const evLine of event.split("\n")) {
            if (!evLine.startsWith("data:")) continue
            try {
              const json = JSON.parse(evLine.slice(5).trim()) as {
                line?: string
              }
              if (typeof json.line === "string") handleLine(json.line)
            } catch {
              // Ignore heartbeats / ill-formed frames.
            }
          }
          idx = buf.indexOf("\n\n")
        }
      })
      res.on("end", () => {
        appendLine("[session ended]")
      })
    })
    req.on("error", err => {
      appendLine(`[stream error] ${err.message}`)
    })

    return () => {
      req.destroy()
    }
  }, [endpoint, desc.id])

  // Inject the system/formatting prompt as a silent first turn. The daemon's
  // spawn body doesn't accept a system prompt, so we send it as a normal turn
  // and suppress the agent's reply (see setupRef in handleLine above).
  useEffect(() => {
    if (!systemPrompt) return
    setTurnInFlight(true)
    // Hard timeout: if no turn boundary arrives within 10s, unblock the input.
    setupTimeoutRef.current = setTimeout(() => {
      endSetupRef.current()
    }, 10_000)
    httpPostJson(
      `${endpoint.url}/sessions/${desc.id}/prompt`,
      { prompt: systemPrompt },
      endpoint.token,
    ).catch(() => {
      // If the setup turn never lands, don't wedge the input forever.
      endSetupRef.current()
    })
    return () => {
      if (setupTimeoutRef.current) {
        clearTimeout(setupTimeoutRef.current)
        setupTimeoutRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ctrl-C → graceful exit (the daemon kill happens in runChatTui).
  useInput((_inputChar, key) => {
    if (key.ctrl && _inputChar === "c") exit()
  })

  const submit = (value: string): void => {
    const text = value.trim()
    setInput("")
    if (text === "") return
    if (text === "/exit" || text === "/quit") {
      exit()
      return
    }
    if (turnRef.current) return // a turn is still streaming — ignore.
    setMessages(prev => [...prev, { kind: "user", lines: [text] }])
    setTurnInFlight(true)
    httpPostJson(
      `${endpoint.url}/sessions/${desc.id}/prompt`,
      { prompt: text },
      endpoint.token,
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setMessages(prev => [
        ...prev,
        { kind: "agent", lines: [`[prompt failed] ${msg}`], streaming: false },
      ])
      setTurnInFlight(false)
    })
  }

  // Split history: finalized turns go in <Static> (rendered once), the
  // in-flight agent turn stays live below so its appends re-render.
  const last = messages[messages.length - 1]
  const live = last && last.kind === "agent" && last.streaming ? last : null
  const finalized = live ? messages.slice(0, -1) : messages

  return (
    <Box flexDirection="column">
      <Static items={finalized}>
        {(msg, i) => (
          <Box key={i} marginBottom={1}>
            <MessageView msg={msg} />
          </Box>
        )}
      </Static>

      {live ? (
        <Box marginTop={1}>
          <MessageView msg={live} />
        </Box>
      ) : null}

      {turnInFlight ? (
        <Box marginTop={1}>
          <Text color="yellow">
            <Spinner type="dots" />
          </Text>
          <Text dimColor>{setupPhase ? " configuring session…" : " thinking…"}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} />

      <Box marginTop={1}>
        <Text dimColor>─────</Text>
      </Box>
      <Box>
        <Text bold color="cyan">
          you ›{" "}
        </Text>
        {turnInFlight ? (
          <Text dimColor>
            {setupPhase ? "(configuring session…)" : "(waiting for the agent…)"}
          </Text>
        ) : (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            placeholder="type a message — /exit to quit"
          />
        )}
      </Box>
    </Box>
  )
}

export async function runChatTui(args: readonly string[]): Promise<number> {
  let values: {
    model?: string
    cwd?: string
    workspace?: string
    label?: string
    system?: string
    keep?: boolean
    "no-color"?: boolean
    help?: boolean
  }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        model: { type: "string" },
        cwd: { type: "string" },
        workspace: { type: "string" },
        label: { type: "string" },
        system: { type: "string" },
        keep: { type: "boolean" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    process.stderr.write(
      `agentproto chat-tui: ${(err as Error).message}\n\n${USAGE}\n`,
    )
    return 2
  }

  if (values.help) {
    process.stdout.write(USAGE + "\n")
    return 0
  }

  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto chat-tui: missing adapter slug.\n" +
        "  Try: agentproto chat-tui mastra-agent\n",
    )
    return 2
  }
  if (positionals.length > 1) {
    process.stderr.write(
      `agentproto chat-tui: unexpected extra positionals: ${positionals
        .slice(1)
        .join(" ")}\n`,
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto chat-tui")
    return 2
  }
  const endpoint = report.found

  // Spawn the session idle — we drive it turn by turn, so no initial prompt.
  const body: Record<string, string> = { adapter: slug }
  if (values.cwd) body.cwd = resolve(values.cwd)
  if (values.workspace) body.workspaceSlug = values.workspace
  if (values.model) body.model = values.model
  body.label = values.label ?? "chat-tui"

  let desc: SessionDescriptor
  try {
    desc = await httpPostJson<SessionDescriptor>(
      `${endpoint.url}/sessions/agent`,
      body,
      endpoint.token,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/HTTP 401/.test(msg)) {
      process.stderr.write(
        `agentproto chat-tui: ${msg}\n` +
          "  The daemon requires a bearer token — set AGENTPROTO_DAEMON_TOKEN " +
          "or run from a workspace whose .agentproto/runtime.json carries it.\n",
      )
    } else {
      process.stderr.write(`agentproto chat-tui: ${msg}\n`)
    }
    return 1
  }

  // Default formatting hint so replies render cleanly in the terminal; the
  // daemon spawn body doesn't take a system prompt, so ChatApp injects this
  // as a silent first turn. `--system` overrides it; `--system ""` disables.
  const CLI_FORMAT_PROMPT =
    "You are responding inside a terminal (CLI). Format all replies using clean markdown: " +
    "## for headers, - for bullets, backtick code spans, fenced code blocks. " +
    "Never mix bold with inline code (avoid **`...`**). Be concise."
  const systemPrompt = values.system ?? CLI_FORMAT_PROMPT

  const keep = values.keep === true
  const instance = render(
    <ChatApp
      endpoint={endpoint}
      desc={desc}
      slug={slug}
      systemPrompt={systemPrompt}
    />,
  )
  await instance.waitUntilExit()

  if (!keep) {
    // Best-effort stop; don't fail the command on a kill error.
    await httpPostJson(
      `${endpoint.url}/sessions/${encodeURIComponent(desc.id)}/kill`,
      {},
      endpoint.token,
    ).catch(() => undefined)
  } else {
    process.stdout.write(
      `─ session ${desc.id} left running (agentproto sessions) ─\n`,
    )
  }
  return 0
}
