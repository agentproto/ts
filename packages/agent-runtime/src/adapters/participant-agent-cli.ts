/**
 * Agent-CLI participant — spawns a CLI binary, pipes the assembled prompt
 * over stdin, and uses captured stdout as the turn content.
 *
 * Works for any CLI that supports a one-shot "read prompt from stdin,
 * print response to stdout" mode (claude-code's `--print`, hermes' `-p`,
 * etc.).
 */

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import matter from "gray-matter"
import type {
  ParticipantExecuteInput,
  ParticipantExecuteOutput,
  ParticipantExecutor,
} from "../ports.js"

export type AgentCliParticipantOptions = {
  /** Executable to invoke. Examples: "claude", "hermes", "goose". */
  readonly command: string
  /** Static args. The prompt is fed over stdin, not as an argument. */
  readonly args?: readonly string[]
  /** Working directory. Defaults to process.cwd(). */
  readonly cwd?: string
  /** Hard timeout in ms. Default 90000. */
  readonly timeoutMs?: number
  /** Optional output parser — if returns null, content falls back to raw stdout. */
  readonly parseOutput?: (stdout: string) => string | null
}

export class AgentCliParticipant implements ParticipantExecutor {
  readonly kind = "agent-cli"

  constructor(private readonly opts: AgentCliParticipantOptions) {}

  async executeTurn(
    input: ParticipantExecuteInput
  ): Promise<ParticipantExecuteOutput> {
    const prompt = await assemblePrompt(input)
    const stdout = await spawnWithStdin({
      command: this.opts.command,
      args: this.opts.args ?? [],
      cwd: this.opts.cwd ?? process.cwd(),
      timeoutMs: this.opts.timeoutMs ?? 90000,
      stdin: prompt,
      signal: input.signal,
    })
    const parsed = this.opts.parseOutput?.(stdout) ?? null
    const content = parsed ?? stdout.trimEnd()
    return { content }
  }
}

async function assemblePrompt(
  input: ParticipantExecuteInput
): Promise<string> {
  const roleText = input.participant.role
    ? await loadRole(input.participant.role)
    : ""

  const transcript = input.recentTurns
    .map((t) => `[${t.participantId}] ${t.content}`)
    .join("\n\n")

  return [
    roleText && `# Your role\n\n${roleText}`,
    `# Recent conversation\n\n${transcript}`,
    `# Your turn\n\nYou are ${input.participant.displayName}. The latest message in the conversation triggered you (most likely because it mentions you). Read the transcript above and reply in character. Keep it conversational unless the trigger asks for detailed work. Output only your reply — no preamble, no role labels, no quotes around the response.`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

// File extensions we treat as a path-to-role-file. Anything else is
// inline role text — even strings that contain `/`, which are common
// in normal sentences ("I am an AI/ML reviewer").
const ROLE_FILE_EXTENSIONS = [".md", ".markdown", ".txt"]

async function loadRole(roleField: string): Promise<string> {
  if (!looksLikeRoleFile(roleField)) return roleField
  try {
    const raw = await readFile(roleField, "utf8")
    // Strip optional YAML frontmatter — lets a Claude Code agent
    // definition file (.claude/agents/*.md) double as a swarm role
    // without ferrying the agent's metadata into the prompt.
    const parsed = matter(raw)
    return parsed.content.trim()
  } catch (err) {
    // The string had a role-file extension but the file isn't readable
    // — surface a hint on stderr so authors don't silently get the
    // literal path as a prompt. Still fall back to inline so the swarm
    // doesn't crash on a typo.
    const code = (err as NodeJS.ErrnoException).code
    process.stderr.write(
      `agent-cli participant: role path '${roleField}' not readable (${code ?? "unknown"}); using the literal string as inline role text.\n`
    )
    return roleField
  }
}

function looksLikeRoleFile(s: string): boolean {
  const lower = s.toLowerCase()
  return ROLE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

type SpawnArgs = {
  command: string
  args: readonly string[]
  cwd: string
  timeoutMs: number
  stdin: string
  signal?: AbortSignal
}

async function spawnWithStdin(args: SpawnArgs): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(args.command, [...args.args], {
      cwd: args.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    const onAbort = () => proc.kill("SIGTERM")
    args.signal?.addEventListener("abort", onAbort)

    const timer = setTimeout(() => {
      proc.kill("SIGTERM")
    }, args.timeoutMs)

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    proc.on("error", (err) => {
      clearTimeout(timer)
      args.signal?.removeEventListener("abort", onAbort)
      rejectP(err)
    })
    proc.on("close", (code) => {
      clearTimeout(timer)
      args.signal?.removeEventListener("abort", onAbort)
      if (code === 0) {
        resolveP(stdout)
        return
      }
      rejectP(
        new Error(
          `agent-cli participant "${args.command}" exited with code ${code}: ${stderr.trim() || "(no stderr)"}`
        )
      )
    })

    proc.stdin.write(args.stdin)
    proc.stdin.end()
  })
}

/**
 * Parser for `claude --output-format=json` responses. Returns the
 * `result` field as the turn content, or null if the JSON doesn't have
 * the expected shape (caller falls back to raw stdout).
 */
export function parseClaudeJsonOutput(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "result" in parsed &&
      typeof (parsed as { result: unknown }).result === "string"
    ) {
      return (parsed as { result: string }).result
    }
    return null
  } catch {
    return null
  }
}
