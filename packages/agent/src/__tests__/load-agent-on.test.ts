import { describe, it, expect } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadAgent } from "../load-agent.js"

/**
 * Write `<workspace>/.agents/probe/AGENT.md` whose frontmatter carries
 * `onYaml` verbatim under `on:` (already indented by the caller).
 */
async function writeProbe(workspace: string, onYaml: string): Promise<string> {
  const dir = join(workspace, ".agents", "probe")
  await mkdir(dir, { recursive: true })
  const source = [
    "---",
    "schema: agent/v1",
    'id: "probe"',
    "description: probe agent",
    "model: test-model",
    "on:",
    onYaml,
    "---",
    "",
    "You are the probe agent.",
    "",
  ].join("\n")
  const path = join(dir, "AGENT.md")
  await writeFile(path, source, "utf8")
  return path
}

async function loadProbeOn(onYaml: string) {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-agent-on-"))
  try {
    const path = await writeProbe(workspace, onYaml)
    return await loadAgent(path, { workspace })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

/** The message of the error `loadAgent` throws for a rejected `on:` value. */
async function loadProbeOnError(onYaml: string): Promise<string> {
  const error = await loadProbeOn(onYaml).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  return (error as Error).message
}

/** The count-only diagnostic of the library's default `oneOf` check. */
const SINGLE_SCHEMA_COUNT = /Should pass single schema/

describe("AGENT.md `on:` hook values (AIP-42 action-ref | action-ref[])", () => {
  it("loads a string action ref", async () => {
    const { handle } = await loadProbeOn("  turn-end: session:archive")
    expect(handle.on).toEqual({ "turn-end": "session:archive" })
  })

  it("loads an object action ref", async () => {
    const { handle } = await loadProbeOn(
      ["  turn-end:", "    action: session:archive"].join("\n"),
    )
    expect(handle.on).toEqual({ "turn-end": { action: "session:archive" } })
  })

  it("loads an array of one action ref", async () => {
    const { handle } = await loadProbeOn(
      ["  turn-end:", "    - session:archive"].join("\n"),
    )
    expect(handle.on).toEqual({ "turn-end": ["session:archive"] })
  })

  it("loads an array of two action refs, string and object mixed", async () => {
    const { handle } = await loadProbeOn(
      [
        "  turn-end:",
        "    - session:archive",
        "    - action: session:note",
        "      inputs:",
        "        text: done",
      ].join("\n"),
    )
    expect(handle.on).toEqual({
      "turn-end": [
        "session:archive",
        { action: "session:note", inputs: { text: "done" } },
      ],
    })
  })

  it("loads several events, each in a different form", async () => {
    const { handle } = await loadProbeOn(
      [
        "  turn-end:",
        "    - session:archive",
        "    - session:note",
        "  session-start: session:note",
      ].join("\n"),
    )
    expect(handle.on).toEqual({
      "turn-end": ["session:archive", "session:note"],
      "session-start": "session:note",
    })
  })

  // The old generated schema rejected EVERY array (its `oneOf` matched an
  // array twice), so "an array is rejected" proves nothing on its own: each
  // case also asserts the failure is about the value, not that count.
  it("rejects an array holding a number", async () => {
    const message = await loadProbeOnError(
      ["  turn-end:", "    - session:archive", "    - 42"].join("\n"),
    )
    expect(message).toMatch(/on\.turn-end/)
    expect(message).not.toMatch(SINGLE_SCHEMA_COUNT)
  })

  it("rejects an array holding an empty string", async () => {
    const message = await loadProbeOnError(
      ["  turn-end:", '    - ""'].join("\n"),
    )
    expect(message).toMatch(/on\.turn-end/)
    expect(message).not.toMatch(SINGLE_SCHEMA_COUNT)
  })

  it("rejects an array whose object element has a non-string action", async () => {
    const message = await loadProbeOnError(
      ["  turn-end:", "    - action: 5"].join("\n"),
    )
    expect(message).toMatch(/on\.turn-end/)
    expect(message).not.toMatch(SINGLE_SCHEMA_COUNT)
  })

  it("rejects a bare number", async () => {
    // The old schema typed an action ref as `z.any()`, so this loaded.
    const message = await loadProbeOnError("  turn-end: 42")
    expect(message).toMatch(/on\.turn-end/)
  })
})
