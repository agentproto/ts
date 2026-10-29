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
 *    (`composeInstructions`, the same rendering mastra-agent uses). An
 *    adapter that declares a real system-prompt channel
 *    (`caps.supportsSystemPrompt`, from its manifest's `systemPrompt`)
 *    receives the text there (projected as `systemPrompt`, no warning) —
 *    unless the text overflows the channel's char budget
 *    (`caps.systemPromptMaxChars`), which degrades to prefix + a warning
 *    naming the limit; every other adapter rides it as the first prompt's
 *    prefix — said out loud as a warning, never silently.
 *  - `tools` (string ids) → the daemon gateway's `allowTools` scope, for
 *    every adapter (manifest-native included). The harness's OWN native
 *    tools are not filtered by that; warned. A structured
 *    `{ kind: mcp, server, allow?, deny? }` item (AIP-42 §Tools) becomes that
 *    server's `allowTools`/`denyTools` (`servers`); a bare string is a legacy
 *    daemon built-in, so it joins the `agentproto` server. Deny wins over
 *    allow and over any other item admitting the same tool.
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
  /** The adapter declares a real system-prompt channel (AIP-45 manifest
   *  `systemPrompt` — `ResolvedAgentAdapter.supportsSystemPrompt`). Set ⇒
   *  the instructions ride `AgentSpawnProjection.systemPrompt` and NO
   *  "no system-prompt channel" warning is raised; unset ⇒ prefix + warn. */
  supportsSystemPrompt?: boolean
  /** The channel's character budget (manifest `systemPrompt.maxChars`, from
   *  `ResolvedAgentAdapter.systemPromptMaxChars`). A channel that would
   *  overflow it is treated as no channel for this text: projected as
   *  `instructions` (first-prompt prefix) with a warning naming the limit. */
  systemPromptMaxChars?: number
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
   *  manifest-native adapter (renders them itself) and for an adapter with a
   *  real system-prompt channel, which takes them via `systemPrompt`. */
  instructions?: string
  /** Composed AGENT.md text for an adapter that declared a system-prompt
   *  channel — delivered by `session-spawn.ts` through
   *  `startSession({ appendSystemPrompt })`, not as a prompt prefix. */
  systemPrompt?: string
  skills?: string[]
  /** Gateway allowlist (`?allowTools=`): the daemon built-ins (`agentproto`
   *  server) the agent is offered, denied names already removed. Absent when
   *  the manifest names none, or admits every built-in. */
  tools?: string[]
  /** Per-server tool filters from the manifest's tool items, keyed by server
   *  name (`agentproto` = the daemon's own built-ins). `allowTools` absent =
   *  every tool of the server; `denyTools` always wins over it. */
  servers?: Record<string, ServerToolFilter>
  /** Everything the harness cannot honour as declared — each becomes a
   *  `session:harness-warning`, never a silent drop. */
  warnings: string[]
}

/** One server's tool filter, by the tool's `<name>` part (no `<server>/`). */
export interface ServerToolFilter {
  allowTools?: string[]
  denyTools?: string[]
}

/** The server a bare (legacy) tool name belongs to: the daemon's built-ins. */
const BUILTIN_SERVER = "agentproto"

interface McpToolItem {
  kind: "mcp"
  server: string
  allow?: readonly string[]
  deny?: readonly string[]
}

function isMcpToolItem(r: unknown): r is McpToolItem {
  return (
    typeof r === "object" &&
    r !== null &&
    (r as { kind?: unknown }).kind === "mcp" &&
    typeof (r as { server?: unknown }).server === "string"
  )
}

/**
 * Fold the `tools` items into one filter per server. A tool is offered when
 * some item admits it and no item denies it (AIP-42 §Tools, rule 2):
 *  - a bare string admits that name on `agentproto`;
 *  - `{ kind: mcp, server }` without `allow` admits every tool of the server;
 *  - `allow` admits the listed names (`[]` admits none);
 *  - `deny` names are never offered, whatever else admits them.
 * `allowTools` is the union of what is admitted minus the denied names, and
 * is absent when an item admits the whole server.
 */
function projectToolServers(refs: readonly unknown[] | undefined): {
  servers: Record<string, ServerToolFilter>
  unprojected: number
} {
  const acc = new Map<string, { all: boolean; allow: Set<string>; deny: Set<string> }>()
  const slot = (server: string) => {
    let s = acc.get(server)
    if (!s) acc.set(server, (s = { all: false, allow: new Set(), deny: new Set() }))
    return s
  }
  let unprojected = 0
  for (const r of refs ?? []) {
    if (typeof r === "string") {
      if (r.trim().length > 0) slot(BUILTIN_SERVER).allow.add(r.trim())
    } else if (isMcpToolItem(r)) {
      const s = slot(r.server)
      if (r.allow === undefined) s.all = true
      else for (const n of r.allow) s.allow.add(n)
      for (const n of r.deny ?? []) s.deny.add(n)
    } else {
      unprojected++
    }
  }
  const servers: Record<string, ServerToolFilter> = {}
  for (const [server, s] of acc) {
    const deny = [...s.deny]
    const allow = s.all ? undefined : [...s.allow].filter(n => !s.deny.has(n))
    servers[server] = {
      ...(allow !== undefined ? { allowTools: allow } : {}),
      ...(deny.length > 0 ? { denyTools: deny } : {}),
    }
  }
  return { servers, unprojected }
}

/**
 * The spawn carries one `allowTools` list, applied to the daemon gateway only.
 * A filter on any other server, or a `denyTools` that no allowlist already
 * absorbed, therefore reaches `servers` but not the running session: say so.
 */
function unappliedServerFilters(id: string, servers: Record<string, ServerToolFilter>): string[] {
  const out: string[] = []
  for (const [server, f] of Object.entries(servers)) {
    if (server !== BUILTIN_SERVER) {
      if (f.allowTools !== undefined || f.denyTools !== undefined) {
        out.push(
          `agent "${id}": the tool filter for server "${server}" is declared but the spawn cannot scope ` +
            "a server other than the daemon's own — not applied.",
        )
      }
    } else if (f.denyTools !== undefined && f.allowTools === undefined) {
      out.push(
        `agent "${id}": denyTools for the daemon's tools cannot be applied on their own (the spawn carries ` +
          "only an allowlist) — not applied.",
      )
    }
  }
  return out
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
  const tools = projectToolServers(agent.handle.tools)
  const gatewayAllow = tools.servers[BUILTIN_SERVER]?.allowTools ?? []
  const toolsField = {
    ...(gatewayAllow.length > 0 ? { tools: gatewayAllow } : {}),
    ...(Object.keys(tools.servers).length > 0 ? { servers: tools.servers } : {}),
  }
  const unappliedFilters = unappliedServerFilters(id, tools.servers)

  if (caps.agentManifestOption) {
    return { ...base, options: { [caps.agentManifestOption]: agent.path }, ...toolsField, warnings: unappliedFilters }
  }

  const warnings: string[] = [...unappliedFilters]
  const instructions = composeInstructions(agent.handle, agent.body)
  // A declared channel takes the composed text as `systemPrompt` (delivered
  // through `startSession({ appendSystemPrompt })`, no prefix, no warning)
  // — when the text fits the channel's char budget. Over the budget (or
  // with no channel at all) the text prefixes the first prompt + warns.
  const overChannelLimit =
    caps.systemPromptMaxChars !== undefined && instructions.length > caps.systemPromptMaxChars
  const hasChannel =
    instructions.length > 0 && caps.supportsSystemPrompt === true && !overChannelLimit
  if (instructions.length > 0 && !hasChannel) {
    warnings.push(
      caps.supportsSystemPrompt === true && overChannelLimit
        ? `agent "${id}": the AGENT.md text is ${instructions.length} chars, over this harness's ` +
            `${caps.systemPromptMaxChars}-char system-prompt limit — delivered as the first prompt's prefix instead.`
        : `agent "${id}": this harness has no system-prompt channel — the AGENT.md body` +
            `${agent.handle.boundaries?.length ? ", boundaries" : ""}${agent.handle.persona ? ", persona" : ""}` +
            " are delivered as the first prompt's prefix, so a later turn can push them out of view.",
    )
  }

  const serverNames = Object.keys(tools.servers)
  if (serverNames.length > 0) {
    warnings.push(
      `agent "${id}": declared tools scope the daemon gateway only — this harness's own ` +
        "native tools stay available (no native tool allowlist).",
    )
  }
  if (serverNames.some((s) => s !== BUILTIN_SERVER)) {
    warnings.push(
      `agent "${id}": structured tool ref(s) for non-agentproto servers are not applied (no consumer wired).`,
    )
  }
  if (tools.servers[BUILTIN_SERVER]?.allowTools?.length === 0) {
    warnings.push(
      `agent "${id}": the manifest admits no daemon tool, but the gateway scope cannot express an ` +
        "empty allowlist — not applied.",
    )
  }
  if (tools.unprojected > 0) {
    warnings.push(`agent "${id}": ${tools.unprojected} structured tool ref(s) have no gateway tool name — not applied.`)
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
    ...(instructions.length > 0
      ? hasChannel
        ? { systemPrompt: instructions }
        : { instructions }
      : {}),
    ...(skills.ids.length > 0 && takesSkills ? { skills: skills.ids } : {}),
    ...toolsField,
    warnings,
  }
}
