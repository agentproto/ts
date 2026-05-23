#!/usr/bin/env node
/**
 * Smoke test for file-substrate mode. Uses the real kernel + real
 * FileSubstrate + real MentionDispatcher + real FileStateStore, but
 * stubs the participant executor so we don't depend on `claude` being
 * spawnable and authenticated for the round-trip.
 *
 * Verifies:
 *   1. dispatcher detects @Reviewer mention against the seeded turn
 *   2. kernel resolves the right executor + state
 *   3. participant's reply gets appended to the journal as a new turn
 *
 * Exit 0 = pass, exit 1 = fail with explanation on stderr.
 */

import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runTurn } from "../dist/index.mjs"
import { FileSubstrate } from "../dist/adapters/substrate-file.mjs"
import { MentionDispatcher } from "../dist/adapters/dispatcher-mention.mjs"
import { FileStateStore } from "../dist/adapters/state-fs.mjs"

const dir = await mkdtemp(join(tmpdir(), "agent-runtime-smoke-"))
const journalPath = join(dir, "conversation.md")
const stateDir = join(dir, "state")

// Seed the journal.
const seed =
  "=== TURN id=t_seed participant=user ts=2026-05-23T10:00:00Z ===\n" +
  "@Reviewer please look at the seed file\n"
await writeFile(journalPath, seed, "utf8")

const substrate = new FileSubstrate({ path: journalPath })
const dispatcher = new MentionDispatcher()
const state = new FileStateStore({ dir: stateDir })

// Stub executor — record what input it gets and return a canned reply.
let executorCallCount = 0
let lastInput = null
const stubExecutor = {
  kind: "stub",
  async executeTurn(input) {
    executorCallCount += 1
    lastInput = input
    return {
      content: `Reviewer: I looked at it and everything is fine. (Triggered by turn ${input.triggerTurn.id})`,
    }
  },
}

const participants = [
  {
    id: "reviewer",
    displayName: "Reviewer",
    executor: "stub",
  },
  {
    id: "migration-writer",
    displayName: "MigrationWriter",
    executor: "stub",
  },
]

const ports = {
  substrate,
  dispatcher,
  state,
  participants,
  executors: new Map([["stub", stubExecutor]]),
}

const result = await runTurn(ports)

// Assertions
const fails = []

if (result.cycle !== "executed")
  fails.push(`expected cycle=executed, got ${result.cycle}`)
if (result.selected.length !== 1)
  fails.push(
    `expected selected=[reviewer], got [${result.selected.join(", ") || "empty"}]`
  )
if (result.selected[0] !== "reviewer")
  fails.push(`expected selected[0]=reviewer, got ${result.selected[0]}`)
if (executorCallCount !== 1)
  fails.push(`expected executorCallCount=1, got ${executorCallCount}`)
if (!lastInput)
  fails.push("expected executor to receive input, got null")
else if (lastInput.triggerTurn.id !== "t_seed")
  fails.push(`expected triggerTurn.id=t_seed, got ${lastInput.triggerTurn.id}`)
if (result.turnsAppended.length !== 1)
  fails.push(`expected 1 turn appended, got ${result.turnsAppended.length}`)

// Verify the appended turn shows up in the journal on re-read.
const reread = await substrate.read()
if (reread.length !== 2)
  fails.push(`expected 2 turns in journal after run, got ${reread.length}`)
if (reread[1] && reread[1].participantId !== "reviewer")
  fails.push(`expected appended turn participant=reviewer, got ${reread[1]?.participantId}`)
if (reread[1] && !reread[1].content.includes("everything is fine"))
  fails.push(`appended turn content doesn't match stub reply`)

// Verify the mention parser ignores self-replies — re-run with the stub's
// own reply mentioning @MigrationWriter; MigrationWriter should be picked,
// not Reviewer (who would otherwise re-select itself if self-skip is broken).
await writeFile(
  journalPath,
  seed +
    "=== TURN id=t_review participant=reviewer ts=2026-05-23T10:01:00Z ===\n" +
    "@MigrationWriter please draft a migration\n",
  "utf8"
)
executorCallCount = 0
const result2 = await runTurn(ports)
if (result2.selected.length !== 1 || result2.selected[0] !== "migration-writer")
  fails.push(
    `expected second cycle to select migration-writer, got [${result2.selected.join(", ") || "empty"}]`
  )

if (fails.length > 0) {
  process.stderr.write(`SMOKE FAILED (${fails.length}):\n`)
  for (const f of fails) process.stderr.write(`  - ${f}\n`)
  process.exit(1)
}

process.stdout.write(`SMOKE PASSED\n  workdir: ${dir}\n`)
process.exit(0)
