#!/usr/bin/env node
/**
 * UserPromptSubmit hook — when the user submits a prompt, scan for
 * @-mentions of any participant declared in `.runtime/multi-agent.yaml`.
 * If a known participant is mentioned, inject a routing hint via
 * `additionalContext` so Claude knows the swarm may pick this up.
 *
 * The hook does NOT itself route to the swarm. The swarm is a separate
 * process polling the journal. This hook just makes the Claude session
 * aware of the mention so it can mirror it into the journal if the user
 * is in file-mode.
 *
 * The mention parser below is INLINED AT BUILD TIME from
 * `@agentproto/agent-runtime/util/mention-parser`. Edit the parser
 * there, not here — the next build regenerates this hook with the
 * latest source.
 */

import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"

const MANIFEST_PATH = resolve(process.cwd(), ".runtime/multi-agent.yaml")

async function main() {
  // Read event JSON from stdin.
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  let event = {}
  try {
    event = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return // malformed event — bail silently
  }
  const prompt = typeof event?.prompt === "string" ? event.prompt : ""
  if (!prompt) return

  try {
    await stat(MANIFEST_PATH)
  } catch {
    return // no active swarm manifest
  }

  let participants = []
  try {
    const raw = await readFile(MANIFEST_PATH, "utf8")
    participants = extractParticipants(raw)
  } catch (err) {
    process.stderr.write(`user-prompt-submit hook: manifest parse failed — ${err?.message ?? err}\n`)
    return
  }

  const mentioned = participants.filter((p) => textContainsMention(prompt, p.name))
  if (mentioned.length === 0) return

  const list = mentioned.map((p) => `- \`${p.name}\` (id: ${p.id})`).join("\n")
  const additionalContext = [
    "## Multi-Agent Runtime — mention detected in prompt",
    "",
    `The user's prompt mentions ${mentioned.length} participant${mentioned.length === 1 ? "" : "s"} declared in \`.runtime/multi-agent.yaml\`:`,
    "",
    list,
    "",
    "If a `pnpm agentproto run-swarm` process is polling the journal, it will pick this up on its next cycle. If the user wants the mention to flow to those participants, mirror the prompt into `.runtime/conversation.md` as a `user` turn (see `/ap-swarm` for the seed format). Otherwise treat the mention as in-session context only.",
  ].join("\n")

  process.stdout.write(JSON.stringify({ additionalContext }))
}

// %% MENTION_PARSER %%

/**
 * Minimal frontmatter parser for the participants list. The hook script can't
 * resolve gray-matter at hook-execution time (.claude/ has no node_modules),
 * and the manifest format is constrained enough that a hand-rolled extractor
 * is fine. If the manifest grows complex, switch to `pnpm exec node ...`
 * so module resolution finds the workspace install.
 *
 * Returns [{ id, name }] from a participants list shaped like:
 *
 *   participants:
 *     - id: reviewer
 *       displayName: Reviewer
 *     - id: migration-writer
 *       displayName: MigrationWriter
 */
function extractParticipants(raw) {
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(raw)
  if (!fmMatch) return []
  const fm = fmMatch[1]

  const listMatch = /^participants:\s*\n([\s\S]*?)(?=^[a-zA-Z][a-zA-Z0-9_-]*:|\Z)/m.exec(fm)
  if (!listMatch) return []
  const block = listMatch[1]

  const out = []
  const entries = block.split(/\n(?=\s*-\s)/)
  for (const entry of entries) {
    const idMatch = /\bid:\s*([^\n#]+)/.exec(entry)
    const nameMatch = /\bdisplayName:\s*([^\n#]+)/.exec(entry)
    if (!idMatch) continue
    const id = idMatch[1].trim()
    const name = (nameMatch?.[1] ?? id).trim()
    if (id) out.push({ id, name })
  }
  return out
}

main().catch((err) => {
  process.stderr.write(`user-prompt-submit hook: ${err?.message ?? String(err)}\n`)
  process.exit(0)
})
