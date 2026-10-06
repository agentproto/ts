import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv2020 from "ajv/dist/2020.js"
import { buildContextCheckpoint, persistCheckpoint } from "../context-checkpoint.js"
import {
  buildCheckpointJsonSchema,
  contextCheckpointSchema,
  CHECKPOINT_SCHEMA_VERSION,
} from "../checkpoint-schema.js"
import type { SessionDescriptor } from "../sessions.js"

vi.mock("../transcript-export.js", () => ({
  exportDaemonEventsSession: vi.fn(async () => ({
    meta: {},
    messages: [
      { role: "user", text: "Fix the build" },
      { role: "assistant", text: "Done, tests pass." },
    ],
  })),
  renderMarkdown: vi.fn(() => "digest"),
}))

const schemaPath = fileURLToPath(new URL("../../schemas/checkpoint.v1.json", import.meta.url))

const desc = {
  id: "sess_schema",
  kind: "agent-cli",
  status: "running",
  title: "t",
  cwd: "/nonexistent-dir-for-git-status",
  contextContinuity: {
    mode: "ask",
    warnAtPct: 55,
    compactAtPct: 65,
    continueFreshAtPct: 75,
    hardStopAtPct: 90,
    goal: true,
    plan: true,
    decisions: true,
    changedFiles: true,
    gitStatus: true,
    tests: true,
    errors: true,
    risks: true,
    nextStep: true,
    config: true,
    label: "ask",
  },
} as unknown as SessionDescriptor

describe("checkpoint.v1.json", () => {
  it("is exactly what the zod contract generates (no drift)", () => {
    const committed = JSON.parse(readFileSync(schemaPath, "utf8"))
    expect(committed).toEqual(buildCheckpointJsonSchema())
  })

  it("validates a persisted checkpoint and rejects a broken one", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "ckpt-schema-"))
    const checkpoint = await buildContextCheckpoint(desc, {
      contextPct: 80,
      baseDir,
      notes: "n",
      askSource: false,
    })
    await persistCheckpoint(checkpoint)
    const written = JSON.parse(readFileSync(checkpoint.checkpointPath, "utf8"))

    const validate = new Ajv2020({ strict: false }).compile(JSON.parse(readFileSync(schemaPath, "utf8")))
    expect(validate(written), JSON.stringify(validate.errors)).toBe(true)
    expect(contextCheckpointSchema.safeParse(written).success).toBe(true)
    expect(written.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION)

    const { schemaVersion: _drop, ...noVersion } = written
    expect(validate(noVersion)).toBe(false)
    expect(validate({ ...written, schemaVersion: 2 })).toBe(false)
    expect(validate({ ...written, nextAction: "later" })).toBe(false)
  })
})
