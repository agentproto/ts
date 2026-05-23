#!/usr/bin/env node
/**
 * Abstraction gate. We run the SAME MentionDispatcher instance against
 * turns produced by two separate FileSubstrate instances (different
 * paths, different file contents but equivalent mentions) and confirm
 * both produce the same selection. The dispatcher should not know which
 * substrate produced the turns.
 *
 * If selection diverges for equivalent input, the abstraction has a
 * leak — the dispatcher is depending on some substrate-internal detail
 * (id format, timestamp shape) rather than the Turn contract.
 *
 * Third-party substrate authors run the same gate against their own
 * adapter to prove their turns are dispatcher-compatible.
 */

import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { FileSubstrate } from "../dist/adapters/substrate-file.mjs"
import { MentionDispatcher } from "../dist/adapters/dispatcher-mention.mjs"

const participants = [
  { id: "reviewer", displayName: "Reviewer", executor: "stub" },
  { id: "migration-writer", displayName: "MigrationWriter", executor: "stub" },
]

const dispatcher = new MentionDispatcher()

// ── Substrate A: hash-based ids (the FileSubstrate default) ──
const dirA = await mkdtemp(join(tmpdir(), "cross-substrate-a-"))
const journalA = join(dirA, "conversation.md")
await writeFile(
  journalA,
  "=== TURN id=t_seed participant=user ts=2026-05-23T10:00:00Z ===\n" +
    "@Reviewer please look at this\n",
  "utf8"
)
const subA = new FileSubstrate({ path: journalA })
const turnsA = await subA.read()
const selectedA = await dispatcher.selectNext({
  recentTurns: turnsA,
  participants,
})

// ── Substrate B: same Turn shape, different on-disk layout ──
//
// Same dispatcher must accept turns whose ids and timestamps differ
// in surface form, as long as they satisfy the Turn contract.
const dirB = await mkdtemp(join(tmpdir(), "cross-substrate-b-"))
const journalB = join(dirB, "thread.md")
await writeFile(
  journalB,
  "=== TURN id=opaque-id-12345 participant=user ts=2026-05-23T11:00:00.123Z ===\n" +
    "Hey @Reviewer please look at this\n",
  "utf8"
)
const subB = new FileSubstrate({ path: journalB })
const turnsB = await subB.read()

// Reset the dispatcher's cursor between runs — same dispatcher class,
// independent invocations.
const dispatcherB = new MentionDispatcher()
const selectedB = await dispatcherB.selectNext({
  recentTurns: turnsB,
  participants,
})

const fails = []
if (selectedA.length !== 1 || selectedA[0] !== "reviewer")
  fails.push(`substrate A selected wrong: [${selectedA.join(",")}]`)
if (selectedB.length !== 1 || selectedB[0] !== "reviewer")
  fails.push(`substrate B selected wrong: [${selectedB.join(",")}]`)
if (JSON.stringify(selectedA) !== JSON.stringify(selectedB))
  fails.push(
    `selection diverges across substrates: A=${JSON.stringify(selectedA)} B=${JSON.stringify(selectedB)}`
  )

if (fails.length > 0) {
  process.stderr.write(`ABSTRACTION GATE FAILED:\n`)
  for (const f of fails) process.stderr.write(`  - ${f}\n`)
  process.exit(1)
}

process.stdout.write(
  `ABSTRACTION GATE PASSED — same dispatcher, two substrates, identical selection ([${selectedA.join(", ")}]).\n`
)
process.exit(0)
