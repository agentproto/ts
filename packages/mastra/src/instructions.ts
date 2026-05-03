/**
 * Default instructions composer.
 *
 * AIP-42 says the markdown body of an AGENT.md is the agent's primary
 * system prompt. Boundaries, persona inline content, and trait scores
 * are appended in that order so the body — the human-authored part —
 * stays at the top where the model sees it first.
 */

import type { AgentHandle } from "@agentproto/agent"

const HEADER_RULE = "Hard rules — these MUST be followed:"

/**
 * Compose the AGENT.md body + structural fields into a system prompt.
 *
 * Order:
 *   1. body (markdown after frontmatter), or `description` if absent
 *   2. inline persona block (when `persona` is `{ inline: ... }`)
 *   3. boundaries (rendered as a bulleted "hard rules" block)
 *   4. traits (rendered as a one-line guidance hint when present)
 *
 * Refs (`persona: "@some/persona"`) are NOT inlined — the host is
 * expected to resolve them externally and inject them via
 * `formatInstructions` if it cares, or pre-resolve and pass the
 * resolved body in via `body:`.
 */
export function composeInstructions(
  handle: AgentHandle,
  body: string | undefined,
): string {
  const parts: string[] = []
  parts.push(body?.trim() ?? handle.description.trim())

  const personaInline = extractPersonaInline(handle)
  if (personaInline) parts.push(personaInline)

  if (handle.boundaries && handle.boundaries.length > 0) {
    const lines = handle.boundaries.map((b) => `- ${b}`).join("\n")
    parts.push(`${HEADER_RULE}\n${lines}`)
  }

  if (handle.traits && Object.keys(handle.traits).length > 0) {
    parts.push(traitsLine(handle.traits))
  }

  return parts.filter((s) => s.length > 0).join("\n\n")
}

function extractPersonaInline(handle: AgentHandle): string | undefined {
  const p = handle.persona
  if (!p || typeof p === "string") return undefined
  if (typeof p !== "object" || p === null || !("inline" in p)) return undefined
  const inline = (p as { inline?: Record<string, unknown> }).inline
  if (!inline) return undefined
  const lines: string[] = []
  if (typeof inline.name === "string") lines.push(`Name: ${inline.name}`)
  if (typeof inline.tone === "string") lines.push(`Tone: ${inline.tone}`)
  if (Array.isArray(inline.values)) {
    lines.push(`Values: ${inline.values.join(", ")}`)
  }
  if (typeof inline.bio === "string") lines.push(inline.bio)
  return lines.length > 0 ? `Persona\n${lines.join("\n")}` : undefined
}

function traitsLine(traits: Record<string, number>): string {
  const formatted = Object.entries(traits)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")
  return `Trait scores (0-10): ${formatted}.`
}
