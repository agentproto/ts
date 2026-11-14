/**
 * Default instructions composer.
 *
 * AIP-42 says the markdown body of an AGENT.md is the agent's primary
 * system prompt. Boundaries, persona inline content, and trait scores
 * are appended after it so the body, the human-authored part, stays at
 * the top where the model sees it first.
 */

import type { AgentHandle } from "./types.js"

export const DEFAULT_BOUNDARIES_HEADER = "Hard rules (these MUST be followed):"

export type InstructionSection = "body" | "persona" | "boundaries" | "traits"

export const DEFAULT_SECTION_ORDER: readonly InstructionSection[] = [
  "body",
  "persona",
  "boundaries",
  "traits",
]

export interface ComposeInstructionsOptions {
  /** Line that introduces the boundaries list. Defaults to {@link DEFAULT_BOUNDARIES_HEADER}. */
  readonly boundariesHeader?: string
  /**
   * Sections to render, in order. A section left out is not rendered, so a
   * host can drop traits or move boundaries ahead of the persona. Defaults to
   * {@link DEFAULT_SECTION_ORDER}.
   */
  readonly sectionOrder?: readonly InstructionSection[]
}

/**
 * Compose the AGENT.md body + structural fields into a system prompt.
 *
 * Default order:
 *   1. body (markdown after frontmatter), or `description` if absent
 *   2. inline persona block (when `persona` is `{ inline: ... }`)
 *   3. boundaries (rendered as a bulleted "hard rules" block)
 *   4. traits (rendered as a one-line guidance hint when present)
 *
 * Refs (`persona: "@some/persona"`) are NOT inlined. The host is
 * expected to resolve them externally and pass the resolved text in
 * via `body`.
 */
export function composeInstructions(
  handle: AgentHandle,
  body: string | undefined,
  opts: ComposeInstructionsOptions = {},
): string {
  const header = opts.boundariesHeader ?? DEFAULT_BOUNDARIES_HEADER
  const order = opts.sectionOrder ?? DEFAULT_SECTION_ORDER

  const render: Record<InstructionSection, () => string | undefined> = {
    body: () => body?.trim() || handle.description.trim(),
    persona: () => extractPersonaInline(handle),
    boundaries: () => {
      if (!handle.boundaries || handle.boundaries.length === 0) return undefined
      const lines = handle.boundaries.map((b) => `- ${b}`).join("\n")
      return `${header}\n${lines}`
    },
    traits: () => {
      if (!handle.traits || Object.keys(handle.traits).length === 0) return undefined
      return traitsLine(handle.traits)
    },
  }

  return order
    .map((section) => render[section]?.())
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n\n")
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
