/**
 * Long-form MCP tool documentation, read from `docs/mcp-tools/<name>.md`.
 *
 * The schema `description` on a tool/field is a contract: what it does, and
 * the one rule that prevents a wrong call — kept short so `tools/list` stays
 * cheap. Everything else (edge cases, interactions with other fields,
 * examples, history) lives here instead, fetched on demand by the `tool_help`
 * MCP tool (`tool-help-mcp.ts`) and the `agentproto help <tool>` CLI verb
 * (`packages/cli/src/commands/help.ts`) — both call the two functions below,
 * so the markdown file is the single source both surfaces read.
 *
 * `docs/mcp-tools/` sits at the PACKAGE root (a sibling of `src`/`dist`, not
 * the repo-level `docs/`) so it ships inside the published npm tarball —
 * see the `files` array in `package.json`. Resolved relative to this
 * module's own directory rather than by package name: whether this code is
 * running from `src` (vitest, no build) or `dist` (built/published), the
 * module's directory is always a direct child of the package root, so one
 * `..` reaches it either way — no `require.resolve` needed.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const helpDir = join(packageRoot, "docs", "mcp-tools")

const cache = new Map<string, string | undefined>()

/** Full markdown help text for `name`, or `undefined` when no doc exists. */
export function getToolHelp(name: string): string | undefined {
  if (cache.has(name)) return cache.get(name)
  const path = join(helpDir, `${name}.md`)
  const content = existsSync(path) ? readFileSync(path, "utf8") : undefined
  cache.set(name, content)
  return content
}

/** Every tool name with a help doc available — for a "did you mean" list. */
export function listToolHelpTopics(): string[] {
  if (!existsSync(helpDir)) return []
  return readdirSync(helpDir)
    .filter(f => f.endsWith(".md"))
    .map(f => f.slice(0, -".md".length))
    .sort()
}

/** Extract a `## <topic>` section (case-insensitive) up to the next `##`
 *  heading — shared by the `tool_help` MCP tool and the `agentproto help`
 *  CLI verb so both slice a doc identically. `undefined` when no section
 *  with that heading exists. */
export function extractHelpSection(doc: string, topic: string): string | undefined {
  const lines = doc.split("\n")
  const start = lines.findIndex(l => l.trim().toLowerCase() === `## ${topic}`.toLowerCase())
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => l.startsWith("## "))
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n").trim()
}
