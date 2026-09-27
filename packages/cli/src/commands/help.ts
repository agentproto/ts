/**
 * `agentproto help <tool>` — CLI counterpart to the `tool_help` MCP tool
 * (see `packages/runtime/src/tool-help-mcp.ts`). Same source: both read
 * `docs/mcp-tools/<tool>.md` from `@agentproto/runtime` via `getToolHelp`,
 * so a doc written once shows up identically whether an agent fetches it
 * over MCP or an operator reads it from a terminal.
 *
 * Pure local file read — no daemon connection required, unlike most other
 * verbs in this file.
 */

import { extractHelpSection, getToolHelp, listToolHelpTopics } from "@agentproto/runtime"

const USAGE = `agentproto help <tool> — long-form docs for an MCP tool

Usage:
  agentproto help <tool> [--topic <section>]

Options:
  --topic <section>   print just the "## <section>" heading instead of the whole doc
  -h, --help          show this help

The same text a live daemon session gets from \`tool_help {name, topic?}\`.
`

export async function runHelp(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const name = argv[0]
  if (!name) {
    process.stdout.write(USAGE)
    return 0
  }
  const topicIdx = argv.indexOf("--topic")
  const topic = topicIdx !== -1 ? argv[topicIdx + 1] : undefined

  const doc = getToolHelp(name)
  if (!doc) {
    const topics = listToolHelpTopics()
    process.stderr.write(
      `agentproto help: no doc for "${name}".\n` +
        (topics.length > 0 ? `Tools with docs: ${topics.join(", ")}\n` : "No tool docs are installed.\n"),
    )
    return 1
  }

  if (!topic) {
    process.stdout.write(doc + "\n")
    return 0
  }

  const section = extractHelpSection(doc, topic)
  if (!section) {
    process.stderr.write(`agentproto help: "${name}" has no "${topic}" section. Printing the full doc.\n\n`)
    process.stdout.write(doc + "\n")
    return 0
  }
  process.stdout.write(section + "\n")
  return 0
}
