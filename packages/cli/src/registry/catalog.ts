/**
 * Bundled catalog of known installable items.
 *
 * Used by `agentproto install` (no-arg interactive mode) to populate the
 * type → slug picker without any network calls or adapter resolution.
 *
 * The catalog is intentionally static: it's the "known good" list shipped
 * with this CLI version. Adapters discovered in node_modules at runtime
 * (via `listInstalledAdapters`) may exceed this list — the catalog is a
 * first-run UX affordance, not a complete registry.
 */

import type { AdapterCatalogEntry } from "@agentproto/adapter-kit"

export type CatalogEntryType = "agent-cli" | "pack" | "mcp"

/**
 * Agent-CLI catalog entry. Extends the kit's `AdapterCatalogEntry` with the
 * family-specific `type` discriminator so entries can be filtered by kind
 * without resolving the package.
 */
export interface CatalogEntry extends AdapterCatalogEntry {
  type: CatalogEntryType
}

// Re-export the kit type so consumers can use the canonical name.
export type { AdapterCatalogEntry }

export const CATALOG: readonly CatalogEntry[] = [
  // ── Agent CLIs ────────────────────────────────────────────────────────
  {
    type: "agent-cli",
    slug: "claude-code",
    name: "Claude Code",
    description:
      "Anthropic's Claude Code via @agentclientprotocol/claude-agent-acp ACP wrapper.",
    packageName: "@agentproto/adapter-claude-code",
    hint: "anthropic · ACP · resumable",
  },
  {
    type: "agent-cli",
    slug: "opencode",
    name: "OpenCode",
    description:
      "sst/opencode with first-party ACP mode. Multi-provider: Anthropic, OpenAI, OpenRouter, Groq.",
    packageName: "@agentproto/adapter-opencode",
    hint: "multi-provider · ACP · resumable",
  },
  {
    type: "agent-cli",
    slug: "mastracode",
    name: "Mastra Code",
    description:
      "Mastra Code terminal coding agent via its documented headless CLI. Current CLI does not expose ACP.",
    packageName: "@agentproto/adapter-mastracode",
    hint: "mastra · headless · multi-provider",
  },
  {
    type: "agent-cli",
    slug: "mastracode-inprocess",
    name: "Mastra Code (in-process)",
    description:
      "Mastra Code driven in-process via its SDK (createMastraCode + runMC) — no " +
      "subprocess spawn, no npx cold-start. Same underlying agent as `mastracode`.",
    packageName: "@agentproto/adapter-mastracode-inprocess",
    hint: "mastra · in-process · resumable",
  },
  {
    type: "agent-cli",
    slug: "codex",
    name: "Codex",
    description:
      "OpenAI Codex coding agent via Zed's @zed-industries/codex-acp ACP wrapper.",
    packageName: "@agentproto/adapter-codex",
    hint: "openai · ACP · resumable",
  },
  {
    type: "agent-cli",
    slug: "hermes",
    name: "Hermes",
    description:
      "Nous Research Hermes agent with skills, sandboxes, and memory plugin surface.",
    packageName: "@agentproto/adapter-hermes",
    hint: "nous · ACP · sub-agents",
  },
  {
    type: "agent-cli",
    slug: "mastra-agent",
    name: "Mastra Agent",
    description:
      "First-party agentproto agent — an AIP-42 AGENT.md run as a live Mastra agent behind an ACP server. No external CLI: our own loop, our own models.",
    packageName: "@agentproto/adapter-mastra-agent",
    hint: "first-party · ACP · mastra",
  },
  {
    type: "agent-cli",
    slug: "openclaw",
    name: "OpenClaw",
    description:
      "OpenClaw coding-agent platform with native ACP bridge and plugin surface.",
    packageName: "@agentproto/adapter-openclaw",
    hint: "gateway · ACP · plugins",
  },
] as const

/** Filter the catalog by entry type. */
export function catalogByType(type: CatalogEntryType): CatalogEntry[] {
  return CATALOG.filter((e) => e.type === type) as CatalogEntry[]
}
