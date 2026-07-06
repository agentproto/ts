/**
 * Agent-CLI participant — spawns a CLI binary, pipes the assembled prompt
 * over stdin, and uses captured stdout as the turn content.
 *
 * Works for any CLI that supports a one-shot "read prompt from stdin,
 * print response to stdout" mode (claude-code's `--print`, hermes' `-p`,
 * etc.).
 */

import { readFile } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import matter from "gray-matter"
import { spawnWithStdin } from "@agentproto/cli-exec"
import type {
  ParticipantExecuteInput,
  ParticipantExecuteOutput,
  ParticipantExecutor,
} from "../ports.js"

// Re-exported for back-compat: the JSON-envelope parser now lives in the shared
// @agentproto/cli-exec package alongside the spawn helper.
export { parseClaudeJsonOutput } from "@agentproto/cli-exec"

export type AgentCliParticipantOptions = {
  /** Executable to invoke. Examples: "claude", "hermes", "goose". */
  readonly command: string
  /** Static args. The prompt is fed over stdin, not as an argument. */
  readonly args?: readonly string[]
  /** Working directory. Defaults to process.cwd(). */
  readonly cwd?: string
  /** Manifest base directory; relative role paths resolve against this. */
  readonly baseDir?: string
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
    const prompt = await assemblePrompt(input, this.opts.baseDir)
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
  input: ParticipantExecuteInput,
  baseDir?: string
): Promise<string> {
  const roleText = input.participant.role
    ? await loadRole(input.participant.role, baseDir)
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

async function loadRole(roleField: string, baseDir?: string): Promise<string> {
  if (!looksLikeRoleFile(roleField)) return roleField
  const path = baseDir ? resolvePath(baseDir, roleField) : roleField
  try {
    const raw = await readFile(path, "utf8")
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
      `agent-cli participant: role path '${roleField}' (resolved to ${path}) not readable (${code ?? "unknown"}); using the literal string as inline role text.\n`
    )
    return roleField
  }
}

function looksLikeRoleFile(s: string): boolean {
  const lower = s.toLowerCase()
  return ROLE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
