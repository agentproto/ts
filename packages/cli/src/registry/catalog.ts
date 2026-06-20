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

export type CatalogEntryType = "agent-cli" | "pack" | "mcp"

export interface CatalogEntry {
  type: CatalogEntryType
  /** Adapter slug — matches `@agentproto/adapter-<slug>`. */
  slug: string
  /** Display name shown in the picker. */
  name: string
  /** One-line description (fits in a select hint). */
  description: string
  /** npm package that provides the adapter. */
  packageName: string
  /** Short hint shown inline in the picker (protocol, provider, key capability). */
  hint?: string
}

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
