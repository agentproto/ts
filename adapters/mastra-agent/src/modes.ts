/**
 * Plan → build → review modes for the AgentController, plus a parser that
 * lets an AGENT.md override them with its own `## Modes` section.
 *
 * Mode shape is `AgentControllerMode` (installed @mastra/core 1.57.0):
 * `availableTools` is a visibility allowlist of FINAL exposed tool names —
 * `undefined` means no restriction (all tools visible), `[]` means none.
 * `transitionsTo` is the mode `submit_plan` approval switches to; unset
 * falls back to the controller's default mode.
 */

import type { AgentControllerMode } from "@mastra/core/agent-controller"

export const PLAN_MODE: AgentControllerMode = {
  id: "plan",
  name: "Plan",
  description: "Investigate the task and get a plan approved before touching code.",
  instructions:
    "Investigate the task: read the relevant code and history, run read-only commands to understand " +
    "current behavior. Do not write or edit files in this mode. Once you have a plan, call `submit_plan` " +
    "with the path to the plan you've written for the user to review — do not paste the plan into chat. " +
    "Wait for approval before implementing.",
  availableTools: ["read_file", "list_dir", "read_diff", "run_command", "submit_plan"],
  transitionsTo: "build",
  metadata: { default: true },
}

export const BUILD_MODE: AgentControllerMode = {
  id: "build",
  name: "Build",
  description: "Implement the approved plan.",
  instructions:
    "Implement the approved plan. Write and edit files and run commands as needed, keeping changes " +
    "scoped to what the plan described. When the implementation is done, move on to review.",
  transitionsTo: "review",
}

export const REVIEW_MODE: AgentControllerMode = {
  id: "review",
  name: "Review",
  description: "Review the changes, run checks, and report.",
  instructions:
    "Review the changes made in build mode: read the diff, run type-checks and tests, and report the " +
    "result. If something is broken, describe what's wrong so planning can resume.",
  availableTools: ["read_file", "read_diff", "run_command", "run_tests", "list_dir"],
  transitionsTo: "plan",
}

/** The built-in mode set, used when an AGENT.md carries no `## Modes` section. */
export const DEFAULT_MODES: readonly AgentControllerMode[] = [PLAN_MODE, BUILD_MODE, REVIEW_MODE]

/** The built-in default mode id — matches `PLAN_MODE.metadata.default`. */
export const DEFAULT_MODE_ID = "plan"

export interface ParsedModes {
  modes: AgentControllerMode[]
  defaultModeId: string
}

const MODES_HEADING_RE = /^##\s+Modes\s*$/i
const TOP_HEADING_RE = /^##\s+/
const MODE_SUBHEADING_RE = /^###\s+(.*)$/

/** Title-case a kebab/snake-case mode id for a display `name` (`code-review` -> `Code Review`). */
function titleCase(id: string): string {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Parse an AGENT.md body's `## Modes` section, if present.
 *
 * Format — one `### <id>` subsection per mode:
 *
 * ```md
 * ## Modes
 *
 * ### plan
 * default: true
 * tools: read_file, list_dir, run_command, submit_plan
 * transitions_to: build
 *
 * Investigate the task and propose a plan. Call submit_plan when ready.
 *
 * ### build
 * transitions_to: review
 *
 * Implement the approved plan.
 * ```
 *
 * Recognized per-mode keys, one per line, at the top of the subsection (in any
 * order): `tools:` (comma-separated tool ids — omit for "all tools visible"),
 * `transitions_to:` (target mode id), `default: true` (marks the mode entered
 * when a thread has no persisted mode). Everything after the last recognized
 * key line, up to the next `### ` subsection, is the mode's `instructions`.
 *
 * The default mode is whichever mode is flagged `default: true`, or the first
 * subsection when none is flagged. At most one mode may be flagged default.
 *
 * Returns `undefined` when the body has no `## Modes` heading at all (callers
 * fall back to {@link DEFAULT_MODES}). Throws a descriptive `Error` for a
 * `## Modes` section that parses to zero modes, a `### ` subsection with no
 * id, a duplicate mode id, or more than one `default: true` flag — all signal
 * a typo'd AGENT.md rather than a shape this parser should silently paper
 * over.
 */
export function parseModesFromAgentMd(body: string): ParsedModes | undefined {
  const lines = body.split(/\r?\n/)

  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (MODES_HEADING_RE.test(lines[i]!)) {
      start = i + 1
      break
    }
  }
  if (start === -1) return undefined

  let end = lines.length
  for (let i = start; i < lines.length; i++) {
    if (TOP_HEADING_RE.test(lines[i]!)) {
      end = i
      break
    }
  }
  const sectionLines = lines.slice(start, end)

  const subsections: Array<{ id: string; lines: string[] }> = []
  let current: { id: string; lines: string[] } | undefined
  for (const line of sectionLines) {
    const heading = MODE_SUBHEADING_RE.exec(line)
    if (heading) {
      const id = heading[1]!.trim()
      if (!id) {
        throw new Error("AGENT.md '## Modes': a '### ' subsection has no mode id.")
      }
      current = { id, lines: [] }
      subsections.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (subsections.length === 0) {
    throw new Error(
      "AGENT.md declares a '## Modes' section but no '### <mode-id>' subsections were found — " +
        "each mode needs its own '### <id>' heading.",
    )
  }

  const seenIds = new Set<string>()
  const modes: AgentControllerMode[] = []
  let explicitDefaultId: string | undefined

  for (const { id, lines: bodyLines } of subsections) {
    if (seenIds.has(id)) {
      throw new Error(`AGENT.md '## Modes': duplicate mode id '${id}'.`)
    }
    seenIds.add(id)

    let tools: string[] | undefined
    let transitionsTo: string | undefined
    let isDefault = false
    let bodyStart = 0

    for (; bodyStart < bodyLines.length; bodyStart++) {
      const line = bodyLines[bodyStart]!.trim()
      if (line === "") continue
      const toolsMatch = /^tools:\s*(.*)$/i.exec(line)
      const transitionsMatch = /^transitions_to:\s*(.*)$/i.exec(line)
      const defaultMatch = /^default:\s*(true|false)\s*$/i.exec(line)
      if (toolsMatch) {
        tools = toolsMatch[1]!
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      } else if (transitionsMatch) {
        transitionsTo = transitionsMatch[1]!.trim() || undefined
      } else if (defaultMatch) {
        isDefault = defaultMatch[1]!.toLowerCase() === "true"
      } else {
        break // first non-key line starts the instructions body
      }
    }
    const instructions = bodyLines.slice(bodyStart).join("\n").trim()

    if (isDefault) {
      if (explicitDefaultId) {
        throw new Error(
          `AGENT.md '## Modes': more than one mode flagged 'default: true' ` +
            `('${explicitDefaultId}', '${id}').`,
        )
      }
      explicitDefaultId = id
    }

    modes.push({
      id,
      name: titleCase(id),
      ...(instructions ? { instructions } : {}),
      ...(tools ? { availableTools: tools } : {}),
      ...(transitionsTo ? { transitionsTo } : {}),
    })
  }

  const defaultModeId = explicitDefaultId ?? modes[0]!.id
  const defaultMode = modes.find((m) => m.id === defaultModeId)!
  defaultMode.metadata = { ...defaultMode.metadata, default: true }

  return { modes, defaultModeId }
}

/**
 * Resolve the mode set for an AGENT.md body: its own `## Modes` section when
 * present, else {@link DEFAULT_MODES}.
 */
export function resolveModes(body: string): ParsedModes {
  return (
    parseModesFromAgentMd(body) ?? {
      modes: [...DEFAULT_MODES],
      defaultModeId: DEFAULT_MODE_ID,
    }
  )
}
