/**
 * Artifact-ledger ring passthrough.
 *
 * The CI delivery helper (`deliver-artifact.mjs`) prints
 * `::agentproto-artifact::{…}` marker lines to a tool's stdout so the
 * agentproto-run driver can harvest created PR/review/comment ids back out
 * of `agent_output`. The ring buffer's tool-result summarization is
 * deliberately lossy ("N lines, XB") and used to destroy the marker —
 * observed live on agentproto/ts#1054, where `driver: artifacts=[]` left the
 * review-footer stamp to its sha-discovery fallback (which then never ran).
 *
 * These tests prove the passthrough end-to-end at the registry seam: a
 * tool-result whose payload carries a marker line lands in the RAW ring
 * verbatim (harvestable + JSON-parseable), while `cleanAgentLines` still
 * strips it from human-facing output.
 */

import { describe, it, expect } from "vitest"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { cleanAgentLines } from "../session-spawn.js"
import { ARTIFACT_MARKER } from "../tool-presenter.js"

const RECORD = '{"kind":"review","id":5000347376,"url":"https://github.com/x","sha":"8fbf80c"}'

/** Mimics the delivery helper's stdout: progress noise around the marker. */
function deliveringAgentSession(): AgentSessionLike {
  return {
    sessionId: "deliver",
    async *send() {
      yield { kind: "tool-call", toolName: "Bash", toolCallId: "t1", arguments: {} }
      yield {
        kind: "tool-result",
        toolName: "Bash",
        toolCallId: "t1",
        result: `posting review…\n${ARTIFACT_MARKER}${RECORD}\ncreated review id=5000347376`,
      }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function ringLinesAfterOneTurn(agent: AgentSessionLike): Promise<string[]> {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: agent,
    adapterSlug: "fake",
  })
  await registry.sendPrompt(desc.id, "go")

  const lines: string[] = []
  const unsub = registry.attach(desc.id, line => lines.push(line))
  if (unsub) unsub()
  registry.shutdown()
  return lines
}

describe("artifact-marker ring passthrough", () => {
  it("carries the marker line verbatim in the raw ring, JSON-parseable", async () => {
    const lines = await ringLinesAfterOneTurn(deliveringAgentSession())

    const markerLine = lines.find(l => l.includes(ARTIFACT_MARKER))
    expect(markerLine).toBeDefined()
    // The harvester (`parseArtifactMarkers`) does indexOf + JSON.parse of the
    // line's tail — prove that round-trip against the actual ring line.
    const idx = markerLine!.indexOf(ARTIFACT_MARKER)
    const parsed = JSON.parse(markerLine!.slice(idx + ARTIFACT_MARKER.length).trim()) as {
      kind: string
      id: number
    }
    expect(parsed.kind).toBe("review")
    expect(parsed.id).toBe(5000347376)
  })

  it("still emits the lossy one-line summary for humans", async () => {
    const lines = await ringLinesAfterOneTurn(deliveringAgentSession())
    expect(lines.some(l => l.includes("[tool-result]"))).toBe(true)
  })

  it("clean mode strips the marker passthrough from human-facing output", async () => {
    const lines = await ringLinesAfterOneTurn(deliveringAgentSession())
    const clean = cleanAgentLines(lines)
    expect(clean.some(l => l.includes(ARTIFACT_MARKER))).toBe(false)
  })
})
