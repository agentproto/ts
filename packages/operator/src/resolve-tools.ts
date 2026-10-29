/**
 * The tool half of `resolveOperator` (AIP-9 §Resolution, merge step 4 and 6).
 *
 * The effective tools are the union of the base agent chain, the role intent,
 * the slot-bound tools and the operator's own, filtered by AIP-38
 * `tool:invoke` against the operator's policy:
 *
 *   - a tool the agent, a slot or the operator DECLARES with no grant refuses
 *     resolution (a registration error: it would be offered and then refused
 *     at every call);
 *   - a tool only the role INTENDS, with no grant, is dropped with an
 *     `intent_unsatisfied` warning (the role declares intent, policy decides
 *     effect).
 */

import {
  evaluateToolInvoke,
  qualifyToolName,
  TOOL_INVOKE_ACTION,
  type Grant,
  type GrantInput,
} from "@agentproto/policy"
import type { AgentToolRef, McpToolRef, ToolRef } from "./types.js"
import type { ResolutionIssue, ResolutionWarning } from "./resolve-types.js"

export type ToolOrigin = "agent" | "slot" | "operator"

export interface DeclaredTool {
  readonly origin: ToolOrigin
  readonly item: ToolRef
}

export interface ToolFilterResult {
  readonly tools: readonly AgentToolRef[]
  readonly refusals: readonly ResolutionIssue[]
  readonly warnings: readonly ResolutionWarning[]
}

const NAME = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/

/** A tool's full name from a ref spelling, or null when the spelling does not name a tool. */
function toolName(raw: string): string | null {
  let s = raw
  if (s.startsWith("ws://tools/")) s = s.slice("ws://tools/".length)
  else if (s.startsWith("tool:")) s = s.slice("tool:".length)
  return NAME.test(s) ? qualifyToolName(s) : null
}

function isMcp(item: ToolRef): item is McpToolRef {
  return typeof item === "object" && item !== null && (item as { kind?: unknown }).kind === "mcp"
}

interface NameEntry {
  kind: "name"
  name: string
  origin: ToolOrigin
}
interface ServerEntry {
  kind: "server"
  server: string
  /** Undefined = every tool of the server. */
  allow: Set<string> | undefined
  deny: Set<string>
  origin: ToolOrigin
}
interface OpaqueEntry {
  kind: "opaque"
  item: AgentToolRef
}
type Entry = NameEntry | ServerEntry | OpaqueEntry

function describe(origin: ToolOrigin): string {
  return origin === "agent" ? "the agent" : origin === "slot" ? "a role slot binding" : "the operator"
}

export function filterTools(
  declared: readonly DeclaredTool[],
  intent: readonly string[],
  inputs: readonly GrantInput[],
  principals: readonly string[],
): ToolFilterResult {
  const warnings: ResolutionWarning[] = []
  const refusals: ResolutionIssue[] = []
  const entries: Entry[] = []
  const names = new Map<string, NameEntry>()
  const servers = new Map<string, ServerEntry>()

  for (const { origin, item } of declared) {
    if (isMcp(item)) {
      const existing = servers.get(item.server)
      if (existing) {
        existing.allow =
          existing.allow === undefined || item.allow === undefined
            ? undefined
            : new Set([...existing.allow, ...item.allow])
        for (const d of item.deny ?? []) existing.deny.add(d)
        continue
      }
      const entry: ServerEntry = {
        kind: "server",
        server: item.server,
        allow: item.allow === undefined ? undefined : new Set(item.allow),
        deny: new Set(item.deny ?? []),
        origin,
      }
      servers.set(item.server, entry)
      entries.push(entry)
      continue
    }
    let raw: string | undefined
    if (typeof item === "string") raw = item
    else if (typeof item === "object" && item !== null) {
      const o = item as { id?: unknown; ref?: unknown; scope?: unknown }
      if (typeof o.id === "string") {
        raw = o.id
        if (o.scope !== undefined) {
          warnings.push({
            code: "tool_scope_ignored",
            subject: o.id,
            message: `the deprecated scope on tool '${o.id}' is a host narrowing and is not evaluated here`,
          })
        }
      } else if (typeof o.ref === "string") raw = o.ref
    }
    const name = raw === undefined ? null : toolName(raw)
    if (name === null) {
      entries.push({ kind: "opaque", item: item as AgentToolRef })
      warnings.push({
        code: "tool_not_evaluated",
        ...(raw !== undefined ? { subject: raw } : {}),
        message: `a tool declared by ${describe(origin)} names no '<server>/<name>' and is not evaluated here; the call-time check still applies`,
      })
      continue
    }
    if (names.has(name)) continue
    const entry: NameEntry = { kind: "name", name, origin }
    names.set(name, entry)
    entries.push(entry)
  }

  const granted = (tool: string): boolean =>
    evaluateToolInvoke(inputs, { tool, principals }).decision === "allow"

  const out: AgentToolRef[] = []
  const refuse = (origin: ToolOrigin, tool: string): void => {
    refusals.push({
      code: "tool_not_granted",
      subject: tool,
      message: `tool '${tool}' is declared by ${describe(origin)} but the operator's policy grants no '${TOOL_INVOKE_ACTION}' for it`,
    })
  }

  for (const entry of entries) {
    if (entry.kind === "opaque") {
      out.push(entry.item)
    } else if (entry.kind === "name") {
      if (granted(entry.name)) out.push(entry.name)
      else refuse(entry.origin, entry.name)
    } else if (entry.allow === undefined) {
      if (granted(`${entry.server}/*`)) {
        out.push({
          kind: "mcp",
          server: entry.server,
          ...(entry.deny.size > 0 ? { deny: [...entry.deny] } : {}),
        })
      } else refuse(entry.origin, `${entry.server}/*`)
    } else {
      const kept: string[] = []
      for (const n of entry.allow) {
        if (entry.deny.has(n)) continue
        if (granted(`${entry.server}/${n}`)) kept.push(n)
        else refuse(entry.origin, `${entry.server}/${n}`)
      }
      if (kept.length > 0) {
        out.push({
          kind: "mcp",
          server: entry.server,
          allow: kept,
          ...(entry.deny.size > 0 ? { deny: [...entry.deny] } : {}),
        })
      }
    }
  }

  const offered = (tool: string): boolean => {
    if (names.has(tool)) return true
    const slash = tool.indexOf("/")
    const server = servers.get(tool.slice(0, slash))
    if (!server || server.deny.has(tool.slice(slash + 1))) return false
    return server.allow === undefined || server.allow.has(tool.slice(slash + 1))
  }

  for (const raw of intent) {
    const name = toolName(raw)
    if (name === null) {
      warnings.push({
        code: "tool_not_evaluated",
        subject: raw,
        message: `role intent '${raw}' names no '<server>/<name>' tool and is not offered`,
      })
      continue
    }
    if (offered(name) || out.includes(name)) continue
    if (granted(name)) out.push(name)
    else {
      warnings.push({
        code: "intent_unsatisfied",
        subject: name,
        message: `the role intends tool '${name}' but the operator's policy grants no '${TOOL_INVOKE_ACTION}' for it; it is dropped`,
      })
    }
  }

  return { tools: out, refusals, warnings }
}

/**
 * The AIP-38 deny grants a resolved agent's structured tool items stand for:
 * one `tool:invoke` deny per `deny` entry of a `{kind: mcp}` item, so the
 * `deny` an agent writes takes effect through the same engine as every other
 * deny (deny wins). Nothing here is wired to a dispatch site; the host feeds
 * these into its grant inputs.
 */
export function toolDenyGrants(tools: readonly ToolRef[], principal = "*"): Grant[] {
  const grants: Grant[] = []
  for (const item of tools) {
    if (!isMcp(item)) continue
    for (const name of item.deny ?? []) {
      grants.push({
        principal,
        effect: "deny",
        actions: [{ action: TOOL_INVOKE_ACTION, scope: `${item.server}/${name}` }],
      })
    }
  }
  return grants
}
