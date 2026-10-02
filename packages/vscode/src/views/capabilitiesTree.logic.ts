/**
 * Capabilities view: pure tree builder. Turns the three daemon reads
 * (`capabilities_inventory`, `bundle_list`, `session_capabilities`) into a
 * plain node tree; capabilitiesTree.ts only maps it onto vscode.TreeItem.
 */

import type {
  CapabilitiesInventoryView,
  CapabilityBundle,
  SessionCapabilitiesView,
} from "../client/types.js"

export interface CapabilityNode {
  id: string
  label: string
  description?: string
  tooltip?: string
  /** ThemeIcon id, without the `$(...)` wrapper. */
  icon: string
  children?: CapabilityNode[]
  expanded?: boolean
}

export interface CapabilitiesSnapshot {
  inventory?: CapabilitiesInventoryView
  bundles?: CapabilityBundle[]
  /** Set when the matching read failed; shown as a row instead of hiding the section. */
  inventoryError?: string
  bundlesError?: string
  session?: { id: string; label: string; capabilities?: SessionCapabilitiesView; error?: string }
}

const MCP_STATUS_ICON: Record<string, string> = {
  connected: "pass",
  idle: "circle-outline",
  error: "error",
  unknown: "question",
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function errorNode(id: string, message: string): CapabilityNode {
  return { id, label: "Could not load", description: message, icon: "warning" }
}

function mcpNodes(snapshot: CapabilitiesSnapshot): CapabilityNode[] {
  if (snapshot.inventoryError) return [errorNode("mcp:error", snapshot.inventoryError)]
  const mcp = snapshot.inventory?.mcp
  if (!mcp) return []
  if (mcp.error) return [errorNode("mcp:error", mcp.error)]
  if (mcp.imported.length === 0) {
    const discovered = mcp.discovered.filter(d => !d.imported).length
    return [
      {
        id: "mcp:none",
        label: "No imported MCP servers",
        description: discovered > 0 ? `${plural(discovered, "discovered server")} not imported yet` : undefined,
        icon: "info",
      },
    ]
  }
  return mcp.imported.map(m => {
    const tools = m.toolCount !== undefined ? `${plural(m.toolCount, "tool")}` : undefined
    const nativeAdapters = Object.entries(m.reach)
      .filter(([, reach]) => reach === "native")
      .map(([adapter]) => adapter)
    const lines = [
      `**${m.alias ?? m.name}** (${m.type}, from ${m.source})`,
      `status: ${m.status}${m.error ? ` - ${m.error}` : ""}`,
      nativeAdapters.length > 0
        ? `native by default in: ${nativeAdapters.join(", ")}`
        : "no default native mount; reachable through a bundle or the daemon /mcp",
    ]
    if (m.usedBySessions.length > 0) lines.push(`used by ${plural(m.usedBySessions.length, "session")}`)
    for (const dup of m.alsoNativeIn ?? []) {
      lines.push(`also mounted natively in ${dup.source} (${dup.scope})${dup.sameName ? ", same name" : ""}`)
    }
    return {
      id: `mcp:${m.id}`,
      label: m.alias ?? m.name,
      description: [m.status, tools].filter(Boolean).join(" · "),
      tooltip: lines.join("\n\n"),
      icon: MCP_STATUS_ICON[m.status] ?? "question",
    }
  })
}

function bundleNodes(snapshot: CapabilitiesSnapshot): CapabilityNode[] {
  if (snapshot.bundlesError) return [errorNode("bundles:error", snapshot.bundlesError)]
  const bundles = snapshot.bundles
  if (!bundles) return []
  if (bundles.length === 0) return [{ id: "bundles:none", label: "No bundles", icon: "info" }]
  return bundles.map(b => {
    const mcpCount = b.mcpImports === "*" ? "all MCPs" : plural(b.mcpImports.length, "MCP")
    const parts = [mcpCount, plural(b.skills.length, "skill")]
    if (b.includeDaemon) parts.push("daemon /mcp")
    const lines = [`**${b.label}** (\`${b.id}\`)`]
    if (b.description) lines.push(b.description)
    lines.push(`MCP imports: ${b.mcpImports === "*" ? "*" : b.mcpImports.join(", ") || "none"}`)
    if (b.skills.length > 0) lines.push(`skills: ${b.skills.join(", ")}`)
    if (b.dangling.length > 0) lines.push(`dangling imports (skipped at spawn): ${b.dangling.join(", ")}`)
    return {
      id: `bundle:${b.id}`,
      label: b.label,
      description: parts.join(" · "),
      tooltip: lines.join("\n\n"),
      icon: b.dangling.length > 0 ? "warning" : "package",
    }
  })
}

function skillNodes(snapshot: CapabilitiesSnapshot): CapabilityNode[] {
  if (snapshot.inventoryError) return [errorNode("skills:error", snapshot.inventoryError)]
  const skills = snapshot.inventory?.skills
  if (!skills) return []
  if (skills.error) return [errorNode("skills:error", skills.error)]
  const harnesses = skills.byHarness.filter(h => h.target !== undefined || h.native.length > 0 || h.spawnOption)
  if (harnesses.length === 0) return [{ id: "skills:none", label: "No harness takes skills", icon: "info" }]
  return harnesses.map(h => {
    const children: CapabilityNode[] = [
      ...h.installed.map(name => ({ id: `skills:${h.adapter}:i:${name}`, label: name, description: "installed", icon: "book" })),
      ...h.native.map(name => ({ id: `skills:${h.adapter}:n:${name}`, label: name, description: "native", icon: "book" })),
    ]
    const how = h.target ? `${h.target.format} in ${h.target.dir}` : "no install target"
    return {
      id: `skills:${h.adapter}`,
      label: h.adapter,
      description: `${h.installed.length} installed`,
      tooltip: `${how}${h.spawnOption ? "\n\nAlso accepts a skills list at spawn" : ""}`,
      icon: "symbol-namespace",
      children,
    }
  })
}

function sessionNodes(session: NonNullable<CapabilitiesSnapshot["session"]>): CapabilityNode[] {
  if (session.error) return [errorNode("session:error", session.error)]
  const caps = session.capabilities
  if (!caps) return [{ id: "session:loading", label: "Loading...", icon: "loading~spin" }]
  const mcpChildren: CapabilityNode[] =
    caps.mcpServers.length > 0
      ? caps.mcpServers.map(s => ({
          id: `session:mcp:${s.name}`,
          label: s.name,
          description: s.transport,
          tooltip: s.ref,
          icon: "plug",
        }))
      : [{ id: "session:mcp:none", label: "none mounted", icon: "circle-slash" }]
  const skillChildren: CapabilityNode[] =
    caps.skills.length > 0
      ? caps.skills.map(name => ({
          id: `session:skill:${name}`,
          label: name,
          description: caps.skillsApplied ? "applied" : "recorded, not applied",
          icon: "book",
        }))
      : [{ id: "session:skill:none", label: "none requested", icon: "circle-slash" }]
  return [
    {
      id: "session:info",
      label: caps.adapter,
      description: [caps.arm, caps.model].filter(Boolean).join(" · "),
      icon: "hubot",
    },
    {
      id: "session:mcp",
      label: "MCP servers",
      description: String(caps.mcpServers.length),
      icon: "plug",
      children: mcpChildren,
      expanded: true,
    },
    {
      id: "session:skills",
      label: "Skills",
      description: caps.skills.length > 0 && !caps.skillsApplied ? `${caps.skills.length} (not applied by ${caps.adapter})` : String(caps.skills.length),
      tooltip: caps.skillsApplied
        ? undefined
        : `${caps.adapter} does not take a skills list at spawn. It only sees skills installed on disk beforehand.`,
      icon: "book",
      children: skillChildren,
      expanded: true,
    },
  ]
}

export function buildCapabilitiesTree(snapshot: CapabilitiesSnapshot): CapabilityNode[] {
  const mcp = mcpNodes(snapshot)
  const bundles = bundleNodes(snapshot)
  const skills = skillNodes(snapshot)
  const roots: CapabilityNode[] = []

  if (snapshot.session) {
    roots.push({
      id: "section:session",
      label: "Selected session",
      description: snapshot.session.label,
      icon: "comment-discussion",
      children: sessionNodes(snapshot.session),
      expanded: true,
    })
  } else {
    roots.push({
      id: "section:session",
      label: "Selected session",
      description: "select one in Sessions",
      icon: "comment-discussion",
    })
  }

  const importedCount = snapshot.inventory?.mcp.imported.length
  roots.push(
    {
      id: "section:mcp",
      label: "Imported MCP servers",
      description: importedCount !== undefined ? String(importedCount) : undefined,
      icon: "plug",
      children: mcp,
    },
    {
      id: "section:bundles",
      label: "Bundles",
      description: snapshot.bundles ? String(snapshot.bundles.length) : undefined,
      icon: "package",
      children: bundles,
    },
    {
      id: "section:skills",
      label: "Skills by harness",
      icon: "book",
      children: skills,
    },
  )
  return roots
}

/** Id of the session a Sessions-tree selection points at, or undefined. */
export function selectedSessionIdOf(selection: readonly unknown[]): string | undefined {
  const first = selection[0] as { session?: { id?: unknown } } | undefined
  const id = first?.session?.id
  return typeof id === "string" ? id : undefined
}
