/**
 * Renderers for the merge-table sections of `resolveOperator`. Each takes
 * already-loaded data and returns markdown; none reads anything.
 */

import type { IdentityHandle } from "@agentproto/identity"
import type { PersonaHandle } from "@agentproto/persona"
import type { RoleHandle } from "@agentproto/role"
import type { RoleSlot } from "@agentproto/role"
import { canonicalJson } from "./resolve-digest.js"

function block(heading: string, lines: readonly (string | undefined)[]): string | undefined {
  const body = lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
  return body.length === 0 ? undefined : `## ${heading}\n${body.join("\n")}`
}

export function renderIdentity(identity: IdentityHandle, body?: string): string | undefined {
  const i = identity as { title?: unknown; description?: unknown }
  return block("Identity", [
    typeof i.title === "string" ? i.title : undefined,
    typeof i.description === "string" ? i.description : undefined,
    body?.trim(),
  ])
}

/** The persona's voice, backstory and body. Boundaries are folded into the boundaries block, not rendered here. */
export function renderPersona(persona: Partial<PersonaHandle>, body?: string): string | undefined {
  const p = persona as Partial<PersonaHandle> & { tone?: unknown; values?: unknown; bio?: unknown }
  const voice = p.voice
  const list = (xs: readonly string[] | undefined): string | undefined =>
    xs && xs.length > 0 ? xs.join(", ") : undefined
  const field = (label: string, v: string | undefined): string | undefined =>
    v === undefined ? undefined : `${label}: ${v}`
  return block("Persona", [
    typeof p.name === "string" ? `Name: ${p.name}` : undefined,
    p.title,
    p.description,
    field("Register", voice?.register),
    field("Tonality", list(voice?.tonality)),
    field("Signature phrases", list(voice?.signaturePhrases)),
    voice?.formality !== undefined ? `Formality: ${voice.formality}/10` : undefined,
    field("Emoji", voice?.emojiUsage),
    field("Sign-off", voice?.signOff),
    typeof p.tone === "string" ? `Tone: ${p.tone}` : undefined,
    Array.isArray(p.values) ? `Values: ${p.values.join(", ")}` : undefined,
    p.backstory?.oneLineHook,
    p.backstory?.background,
    typeof p.bio === "string" ? p.bio : undefined,
    body?.trim(),
  ])
}

/** The persona's refusals, deferrals and redirects as boundary strings (merge table: boundaries union). */
export function personaBoundaries(persona: Partial<PersonaHandle>): string[] {
  const b = persona.boundaries
  if (!b) return []
  return [
    ...(b.refuses ?? []).map(t => `Refuse: ${t}`),
    ...(b.defers ?? []).map(t => `Defer to a specialist on: ${t}`),
    ...(b.redirects ?? []).map(r => `Redirect '${r.topic}' to ${r.to}${r.notes ? ` (${r.notes})` : ""}`),
  ]
}

export function renderRole(
  role: RoleHandle,
  body: string,
  skills: readonly { name: string; body: string }[],
): string {
  const parts = [`## Role: ${role.title}`, role.mission.trim()]
  if (role.responsibilities.length > 0) {
    parts.push(`Responsibilities:\n${role.responsibilities.map(r => `- ${r}`).join("\n")}`)
  }
  if (body.trim().length > 0) parts.push(body.trim())
  for (const s of skills) parts.push(`### Skill: ${s.name}\n${s.body.trim()}`)
  return parts.join("\n\n")
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "object" && value !== null) {
    const v = value as { kind?: unknown; server?: unknown; allow?: unknown; deny?: unknown; ref?: unknown; file?: unknown }
    if (v.kind === "mcp" && typeof v.server === "string") {
      const allow = Array.isArray(v.allow) && v.allow.length > 0 ? `; tools: ${v.allow.join(", ")}` : ""
      const deny = Array.isArray(v.deny) && v.deny.length > 0 ? `; denied: ${v.deny.join(", ")}` : ""
      return `${v.server}${allow}${deny}`
    }
    if (typeof v.ref === "string") return v.ref
    if (typeof v.file === "string") return v.file
  }
  return canonicalJson(value)
}

/** Merge step 5: one line per declared slot, in declaration order. An unbound optional slot is left out. */
export function renderBindings(
  slots: Readonly<Record<string, RoleSlot>> | undefined,
  bind: Readonly<Record<string, unknown>> | undefined,
  scalars: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!slots) return undefined
  const lines: string[] = []
  for (const [name, slot] of Object.entries(slots)) {
    const value = bind?.[name] ?? scalars?.[name] ?? ("default" in slot ? slot.default : undefined)
    if (value === undefined) continue
    const label = slot.description ? `${name} (${slot.description})` : name
    lines.push(`- ${label}: ${renderValue(value)}`)
  }
  return block("Bindings", lines)
}
