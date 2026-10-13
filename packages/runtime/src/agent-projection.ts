/**
 * Project an AIP-42 AGENT.md onto an ordinary spawn, for ANY harness.
 *
 * AIP-42 promises the manifest is runner-agnostic: body, boundaries,
 * persona, traits, tools and skills mean the same thing whichever harness
 * runs the agent. Only an adapter that declares an AGENT.md-path option
 * (`metadata.agentManifestOption`, mastra-agent) consumes the manifest
 * itself; every other adapter (opencode, claude-code, hermes, codex, …) is
 * handed the manifest field by field here:
 *
 *  - body + persona + boundaries + traits → one instructions text
 *    (`composeInstructions`, the same rendering mastra-agent uses). There is
 *    no system-prompt channel on a spawn yet, so it rides as the first
 *    prompt's prefix — said out loud as a warning, never silently.
 *  - `tools` (string ids) → the daemon gateway's `allowTools` scope, for
 *    every adapter (manifest-native included). The harness's OWN native
 *    tools are not filtered by that; warned.
 *  - `skills` (string ids) → the spawn's `skills`. A harness that can take
 *    none (no session-skill delivery, no `skills` option) is warned about.
 *  - `model` → the spawn model (a caller-pinned model wins).
 *
 * Pure (no I/O): the caller loads the AGENT.md and supplies the adapter's
 * capability flags from its resolver entry. Shared by `app_run` and
 * workflow agent refs (`resolveAgentRefsForWorkflow`) so the two paths
 * cannot diverge again.
 */

import { composeInstructions, type AgentHandle } from "@agentproto/agent"

/** What the resolved adapter can take — straight from its resolver entry
 *  (`ResolvedAgentAdapter`). */
export interface AgentProjectionCaps {
  /** Option id taking an AGENT.md path (manifest
   *  `metadata.agentManifestOption`). Set ⇒ the adapter honours the whole
   *  manifest itself. */
  agentManifestOption?: string
  /** The adapter takes part in per-session imported-skill delivery. */
  deliversSessionSkills?: boolean
  /** The adapter's declared option ids (a `skills` option counts as skill
   *  delivery too — hermes' comma-joined `--skills`). */
  declaredOptions?: readonly { id: string }[]
}

export interface AgentProjectionInput {
  /** Absolute AGENT.md path. */
  path: string
  handle: AgentHandle
  /** Markdown body (after frontmatter). */
  body: string
  /** The agent's model AFTER role resolution (`resolveAgentModelRef`). */
  model?: string
}

export interface AgentSpawnProjection {
  model?: string
  /** Adapter options to set — the AGENT.md path for a manifest-native
   *  adapter, nothing otherwise. */
  options?: Record<string, string>
  /** Instructions to deliver in-band (first-prompt prefix). Undefined for a
   *  manifest-native adapter, which renders them itself. */
  instructions?: string
  skills?: string[]
  /** Gateway allowlist (`?allowTools=`). */
  tools?: string[]
  /** Everything the harness cannot honour as declared — each becomes a
   *  `session:harness-warning`, never a silent drop. */
  warnings: string[]
}

/** String ids only: a structured `{ ref | file | inline }` entry has no
 *  gateway tool name / skill id to pass on. Returned separately so the
 *  caller can warn about what it had to leave out. */
function splitRefs(refs: readonly unknown[] | undefined): { ids: string[]; structured: number } {
  const ids: string[] = []
  let structured = 0
  for (const r of refs ?? []) {
    if (typeof r === "string" && r.trim().length > 0) ids.push(r.trim())
    else structured++
  }
  return { ids, structured }
}

/** First-prompt prefix: the instructions, then the caller's ask. */
export function prefixPrompt(instructions: string | undefined, prompt: string | undefined): string | undefined {
  const head = instructions?.trim()
  if (!head) return prompt
  return prompt ? `${head}\n\n${prompt}` : head
}

export function projectAgentToSpawn(
  agent: AgentProjectionInput,
  caps: AgentProjectionCaps,
  modelOverride?: string,
): AgentSpawnProjection {
  const model = modelOverride ?? agent.model
  const base = model !== undefined ? { model } : {}
  const id = agent.handle.id

  // Tools always scope the daemon gateway — whatever else the harness does
  // with the manifest, the declared list is the agent's capability ask.
  const tools = splitRefs(agent.handle.tools)
  const toolsField = tools.ids.length > 0 ? { tools: tools.ids } : {}

  if (caps.agentManifestOption) {
    return { ...base, options: { [caps.agentManifestOption]: agent.path }, ...toolsField, warnings: [] }
  }

  const warnings: string[] = []
  const instructions = composeInstructions(agent.handle, agent.body)
  if (instructions.length > 0) {
    warnings.push(
      `agent "${id}": this harness has no system-prompt channel — the AGENT.md body` +
        `${agent.handle.boundaries?.length ? ", boundaries" : ""}${agent.handle.persona ? ", persona" : ""}` +
        " are delivered as the first prompt's prefix, so a later turn can push them out of view.",
    )
  }

  if (tools.ids.length > 0) {
    warnings.push(
      `agent "${id}": declared tools scope the daemon gateway only — this harness's own ` +
        "native tools stay available (no native tool allowlist).",
    )
  }
  if (tools.structured > 0) {
    warnings.push(`agent "${id}": ${tools.structured} structured tool ref(s) have no gateway tool name — not applied.`)
  }

  const skills = splitRefs(agent.handle.skills)
  const takesSkills = caps.deliversSessionSkills === true || (caps.declaredOptions?.some(o => o.id === "skills") ?? false)
  if (skills.ids.length > 0 && !takesSkills) {
    warnings.push(`agent "${id}": this harness cannot load skills — ${skills.ids.join(", ")} not delivered.`)
  }
  if (skills.structured > 0) {
    warnings.push(`agent "${id}": ${skills.structured} structured skill ref(s) have no skill id — not applied.`)
  }

  return {
    ...base,
    ...(instructions.length > 0 ? { instructions } : {}),
    ...(skills.ids.length > 0 && takesSkills ? { skills: skills.ids } : {}),
    ...toolsField,
    warnings,
  }
}
