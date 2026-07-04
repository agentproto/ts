/**
 * `agentproto chat-tui <adapter>` — the same daemon-hosted chat loop as
 * `chat`, but rendered as a split-pane TUI with @earendil-works/pi-tui.
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
import chalk from "chalk"
import {
  TUI,
  Text,
  Input,
  Loader,
  Markdown,
  Spacer,
  ProcessTerminal,
  matchesKey,
  Key,
  type MarkdownTheme,
  type Component,
} from "@earendil-works/pi-tui"
import { highlight } from "cli-highlight"
import type { SessionDescriptor } from "@agentproto/runtime"
import {
  discoverDaemon,
  printNoDaemonError,
  httpPostJson,
  type DaemonEndpoint,
} from "./_daemon-helpers.js"
import { classifyChatLine } from "./chat.js"

const USAGE = `agentproto chat-tui — pi-tui TUI over a daemon agent session

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

// Matches basic SGR ANSI escape sequences — used only for banner detection, not display.
// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\x1b\[[0-9;]*m/g

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
 *  original ordering (text → tool → text) is preserved. `raw` carries the
 *  cleaned text for passing to the Markdown renderer. */
type Part =
  | { kind: "tool"; line: string }
  | { kind: "prose"; raw: string }

function buildParts(lines: string[]): Part[] {
  const parts: Part[] = []
  let proseBuffer: string[] = []
  const flushProse = (): void => {
    if (proseBuffer.length === 0) return
    const raw = proseBuffer.join("\n")
    const cleaned = raw
      // Strip ** wrappers around inline code spans.
      .replace(/\*\*(`[^`\n]+`)\*\*/g, "$1")
      // Force a blank line before headings the agent ran into prose (e.g.
      // "…done!## Header") so the markdown renderer recognizes them as headings.
      .replace(/([^\n])(#{1,6} )/g, "$1\n\n$2")
      // If there are still literal **, strip them as a safety net.
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    if (cleaned.trim()) parts.push({ kind: "prose", raw: cleaned.trimEnd() })
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

/** Markdown rendering theme — ANSI styles matching the old Ink appearance. */
const MARKDOWN_THEME: MarkdownTheme = {
  heading: (s) => chalk.bold(s),
  link: (s) => chalk.underline(s),
  linkUrl: (s) => chalk.dim(s),
  code: (s) => chalk.yellow(s),
  codeBlock: (s) => s,
  codeBlockBorder: (s) => chalk.dim(s),
  quote: (s) => chalk.italic(s),
  quoteBorder: (s) => chalk.dim(s),
  hr: (s) => chalk.dim(s),
  listBullet: (s) => chalk.dim(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
  highlightCode: (code, lang) => {
    try {
      const opts = lang
        ? { language: lang, ignoreIllegals: true }
        : { ignoreIllegals: true }
      return highlight(code, opts).split("\n")
    } catch {
      return code.split("\n")
    }
  },
}

// ─── ChatController ──────────────────────────────────────────────────────────

interface ControllerOpts {
  endpoint: DaemonEndpoint
  desc: SessionDescriptor
  slug: string
  systemPrompt?: string
  keep: boolean
  resolveExit: () => void
}

class ChatController {
  private tui: TUI
  private endpoint: DaemonEndpoint
  private desc: SessionDescriptor
  private slug: string
  private systemPrompt?: string
  private keep: boolean
  private resolveExit!: () => void

  // TUI component references
  private headerText: Text
  private separatorText: Text
  private currentInputComponent: Component & { onSubmit?: (value: string) => void }
  private inputComponent: Input
  private placeholderText: Text
  private liveSlot?: Text
  private loader?: Loader

  // State
  private req?: http.ClientRequest
  private liveLines: string[] = []
  private turnInFlight = false
  private exited = false
  private setupPhase: boolean
  private setupTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(opts: ControllerOpts) {
    this.endpoint = opts.endpoint
    this.desc = opts.desc
    this.slug = opts.slug
    this.systemPrompt = opts.systemPrompt
    this.keep = opts.keep
    this.resolveExit = opts.resolveExit

    const term = new ProcessTerminal()
    this.tui = new TUI(term)

    // Build the initial TUI layout (top to bottom):
    //   headerText
    //   separatorText
    //   input
    const modelPart = this.desc.model ? ` · ${this.desc.model}` : ""
    this.headerText = this.buildHeaderComponent(
      `─ chat · ${this.slug}${modelPart} · session ${this.desc.id} ─`,
    )

    this.separatorText = new Text(chalk.dim("─────"), 0, 0)

    this.inputComponent = new Input()
    this.inputComponent.onSubmit = (value) => this.handleSubmit(value)
    this.currentInputComponent = this.inputComponent

    this.placeholderText = new Text(
      chalk.dim("(waiting for the agent…)"),
      0,
      0,
    )

    this.tui.children = [this.headerText, this.separatorText, this.inputComponent]

    // Keyboard listener for Ctrl-C
    this.tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.doExit()
        return { consume: true }
      }
      return undefined
    })

    // Setup phase flag
    this.setupPhase = Boolean(this.systemPrompt)
  }

  // ── Component Helpers ─────────────────────────────────────────────────────

  private buildHeaderComponent(text: string): Text {
    return new Text(chalk.dim(text), 0, 1)
  }

  private buildFinalizedUserTurn(text: string): Component[] {
    return [
      new Text(chalk.cyan.bold("you › ") + text, 0, 0),
      new Spacer(1),
    ]
  }

  private buildFinalizedAgentTurn(lines: string[]): Component[] {
    const parts = buildParts(lines)
    const result: Component[] = []

    // Header
    result.push(new Text(chalk.gray.dim("agent ›"), 0, 0))

    for (const part of parts) {
      if (part.kind === "tool") {
        result.push(new Text(chalk.cyan("⚙ " + part.line), 0, 0))
      } else {
        result.push(new Markdown(part.raw, 1, 0, MARKDOWN_THEME))
      }
    }

    result.push(new Spacer(1))
    return result
  }

  private insertBeforeSeparator(components: Component[]): void {
    const idx = this.tui.children.indexOf(this.separatorText)
    if (idx === -1) return
    this.tui.children.splice(idx, 0, ...components)
  }

  private getSeparatorIndex(): number {
    return this.tui.children.indexOf(this.separatorText)
  }

  // ── Loader ────────────────────────────────────────────────────────────────

  private startLoader(msg: string): void {
    if (this.loader) return
    this.loader = new Loader(
      this.tui,
      (s) => chalk.yellow(s),
      (s) => chalk.dim(s),
      msg,
    )
    this.loader.start()
    this.insertBeforeSeparator([this.loader])
    this.tui.requestRender()
  }

  private stopLoader(): void {
    if (!this.loader) return
    this.loader.stop()
    const idx = this.tui.children.indexOf(this.loader)
    if (idx !== -1) this.tui.children.splice(idx, 1)
    this.loader = undefined
    this.tui.requestRender()
  }

  // ── Live Slot (streaming agent output) ────────────────────────────────────

  private appendLine(raw: string): void {
    if (this.exited) return

    // Strip ANSI for banner-line detection only
    const plain = raw.replace(ANSI_SGR, "")
    // Drop the daemon's per-session banner
    if (/^── .+ agent session .+──/.test(plain)) return
    // Drop the daemon's prompt-echo frame
    if (/^[─—–]+ ► .+ [─—–]+$/.test(plain)) return

    const { suppress, turnBoundary } = classifyChatLine(raw)

    // During the silent setup turn, swallow all output — only the turn boundary
    // matters (it ends the setup phase). The agent's reply to the system prompt
    // should never appear in the chat history.
    if (this.setupPhase) {
      if (turnBoundary) this.endTurn()
      return
    }

    // Display non-suppressed lines first (including boundary lines like [awaiting input])
    if (!suppress) {
      if (!this.liveSlot) {
        const prefixText = new Text(chalk.gray.dim("agent ›"), 0, 0)
        this.liveSlot = new Text("", 0, 0)
        const sepIdx = this.getSeparatorIndex()
        if (sepIdx !== -1) {
          this.tui.children.splice(sepIdx, 0, prefixText, this.liveSlot)
        }
      }
      this.liveLines.push(raw)
      const displayLines = this.liveLines.map((l) =>
        isToolLine(l) ? chalk.cyan("⚙ " + l) : l,
      )
      this.liveSlot.setText(displayLines.join("\n"))
      this.tui.requestRender()
    }

    if (turnBoundary) {
      this.endTurn()
    }
  }

  private endTurn(): void {
    // Remove live slot components
    if (this.liveSlot) {
      const idx = this.tui.children.indexOf(this.liveSlot)
      if (idx !== -1) {
        // Remove the liveSlot and its prefix Text (one before it)
        if (idx > 0) {
          this.tui.children.splice(idx - 1, 2)
        } else {
          this.tui.children.splice(idx, 1)
        }
      }
    }

    // Finalize the turn into real components
    if (this.liveLines.length > 0) {
      const components = this.buildFinalizedAgentTurn(this.liveLines)
      this.insertBeforeSeparator(components)
    }

    // Clear state
    this.liveLines = []
    this.liveSlot = undefined

    // Stop loader, swap input back
    this.stopLoader()
    this.swapToInput()

    this.turnInFlight = false

    // End setup phase if active
    if (this.setupPhase) {
      this.setupPhase = false
      if (this.setupTimeout) {
        clearTimeout(this.setupTimeout)
        this.setupTimeout = null
      }
    }

    this.tui.requestRender()
  }

  // ── Input management ──────────────────────────────────────────────────────

  private swapToPlaceholder(text: string): void {
    const idx = this.tui.children.indexOf(this.currentInputComponent)
    if (idx !== -1) {
      this.placeholderText.setText(chalk.dim(text))
      this.tui.children[idx] = this.placeholderText
      this.currentInputComponent = this.placeholderText
      this.tui.requestRender()
    }
  }

  private swapToInput(): void {
    const idx = this.tui.children.indexOf(this.currentInputComponent)
    if (idx !== -1) {
      this.tui.children[idx] = this.inputComponent
      this.currentInputComponent = this.inputComponent
      this.tui.setFocus(this.inputComponent)
      this.tui.requestRender()
    }
  }

  // ── Submit / Exit ─────────────────────────────────────────────────────────

  private handleSubmit(value: string): void {
    const text = value.trim()
    if (text === "") return
    if (text === "/exit" || text === "/quit") {
      this.doExit()
      return
    }
    if (this.turnInFlight) return

    // Add user message as finalized component
    const userComponents = this.buildFinalizedUserTurn(text)
    this.insertBeforeSeparator(userComponents)
    this.inputComponent.setValue("")

    this.turnInFlight = true
    this.swapToPlaceholder(
      this.setupPhase ? "(configuring session…)" : "(waiting for the agent…)",
    )
    this.startLoader(this.setupPhase ? " configuring session…" : " thinking…")

    httpPostJson(
      `${this.endpoint.url}/sessions/${this.desc.id}/prompt`,
      { prompt: text },
      this.endpoint.token,
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      this.appendLine(`[prompt failed] ${msg}`)
      // endTurn() atomically finalises the error into the history and resets
      // all in-flight state (liveSlot, liveLines, loader, input swap).
      this.endTurn()
    })
  }

  private doExit(): void {
    this.exited = true
    if (this.setupTimeout) {
      clearTimeout(this.setupTimeout)
      this.setupTimeout = null
    }
    this.req?.destroy()
    this.tui.stop()
    this.resolveExit()
  }

  // ── Start ─────────────────────────────────────────────────────────────────

  start(): void {
    this.tui.start()

    // Open SSE output stream
    const url = new URL(
      `${this.endpoint.url}/sessions/${this.desc.id}/stream`,
    )
    const lib = url.protocol === "https:" ? https : http
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (this.endpoint.token)
      headers.authorization = `Bearer ${this.endpoint.token}`

    this.req = lib.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        this.appendLine(`[error] stream HTTP ${res.statusCode}`)
        return
      }
      let buf = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
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
              if (typeof json.line === "string")
                this.appendLine(json.line)
            } catch {
              // Ignore heartbeats / ill-formed frames.
            }
          }
          idx = buf.indexOf("\n\n")
        }
      })
      res.on("end", () => {
        // Flush any partial last frame that arrived without a trailing \n\n
        if (buf.trim()) {
          for (const evLine of buf.split("\n")) {
            if (!evLine.startsWith("data:")) continue
            try {
              const json = JSON.parse(evLine.slice(5).trim()) as { line?: string }
              if (typeof json.line === "string") this.appendLine(json.line)
            } catch { /* ignore */ }
          }
        }
        this.appendLine("[session ended]")
        // Flush any buffered live content if [session ended] wasn't a turn boundary
        if (this.liveSlot) this.endTurn()
      })
    })
    this.req.on("error", (err) => {
      this.appendLine(`[stream error] ${err.message}`)
    })

    // Inject system prompt as silent first turn
    if (this.systemPrompt) {
      this.turnInFlight = true
      this.swapToPlaceholder("(configuring session…)")
      this.startLoader(" configuring session…")

      this.setupTimeout = setTimeout(() => {
        if (this.setupPhase) {
          this.setupPhase = false
          this.turnInFlight = false
          this.stopLoader()
          this.swapToInput()
        }
      }, 10_000)

      httpPostJson(
        `${this.endpoint.url}/sessions/${this.desc.id}/prompt`,
        { prompt: this.systemPrompt },
        this.endpoint.token,
      ).catch(() => {
        if (this.setupPhase) {
          this.setupPhase = false
          this.turnInFlight = false
          this.stopLoader()
          this.swapToInput()
        }
      })
    }

    // Focus the input
    this.tui.setFocus(this.inputComponent)
  }
}

// ─── runChatTui (entry point) ───────────────────────────────────────────────

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
  let resolveExit!: () => void
  const exitPromise = new Promise<void>((r) => {
    resolveExit = r
  })
  const controller = new ChatController({
    endpoint,
    desc,
    slug,
    systemPrompt,
    keep,
    resolveExit,
  })
  controller.start()
  await exitPromise

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
