#!/usr/bin/env node
/**
 * SessionStart hook — when a Claude Code session opens in this repo,
 * if a MultiAgentRuntime journal exists at `.runtime/conversation.md`,
 * inject the last few turns as `additionalContext` so Claude picks up
 * mid-swarm without losing thread.
 *
 * No-ops if the journal file is absent.
 */

import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"

const JOURNAL_PATH = resolve(process.cwd(), ".runtime/conversation.md")
const TAIL_BYTES = 4000

async function main() {
  // Drain stdin (event payload) but ignore — we don't need its fields.
  // SessionStart doesn't carry conversation-specific data.
  for await (const _chunk of process.stdin) {
    // discard
  }

  try {
    await stat(JOURNAL_PATH)
  } catch {
    return // no journal, nothing to inject
  }

  const raw = await readFile(JOURNAL_PATH, "utf8")
  const tail = raw.length > TAIL_BYTES ? raw.slice(-TAIL_BYTES) : raw
  if (!tail.trim()) return

  const additionalContext = [
    "## Multi-Agent Runtime journal — recent turns",
    "",
    "A `pnpm agentproto run-swarm` swarm may be running against `.runtime/conversation.md` in this repo. Below is the tail of the journal so this Claude session has thread continuity.",
    "",
    "```",
    tail.trimEnd(),
    "```",
    "",
    "If the user asks about swarm activity, refer to this journal. If they want to seed a new turn, they can either edit the file directly or use `/ap-swarm` to learn the seeding command.",
  ].join("\n")

  process.stdout.write(JSON.stringify({ additionalContext }))
}

main().catch((err) => {
  // Never crash the session on a hook failure — log and continue.
  process.stderr.write(`session-start hook: ${err?.message ?? String(err)}\n`)
  process.exit(0)
})
