/**
 * AIP-58 §4 Run workspace (P4) — the transport-agnostic pieces:
 *   - the `$run.workspace` / `{{run.workspace}}` binding
 *   - `kind: "artifact"` steps (hash + copy into `artifactsDir`)
 *   - cache/replay interplay: a cache hit for an `artifact` step relocates
 *     the file into the CURRENT run's own `artifactsDir` rather than
 *     sharing one across runs (AIP-58 §4 "two runs MUST NEVER share a
 *     workspace")
 *   - the declarative `outputsFiles` end-of-run check (missing-artifact)
 *
 * Host-level concerns (runId allocation, disjoint `<runsRoot>/<runId>/`,
 * `run.publish`) are covered in
 * `packages/runtime/src/__tests__/run-workspace.test.ts` instead — see that
 * file's docblock for the V5 vector this one doesn't drive.
 */

import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import {
  runWorkflow,
  MissingArtifactError,
  type ArtifactEntry,
  type RuntimeWorkflow,
  type StepCache,
  type StepCacheEntry,
  type AgentSessionHost,
} from "../index.js"

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex")
}

function memCache(): { cache: StepCache; store: Map<string, StepCacheEntry> } {
  const store = new Map<string, StepCacheEntry>()
  const cache: StepCache = {
    get: async (k) => store.get(k),
    set: async (k, e) => {
      store.set(k, e)
    },
  }
  return { cache, store }
}

function fakeHost(overrides: Partial<AgentSessionHost> = {}): AgentSessionHost {
  return {
    spawn: vi.fn(async () => "sess_fake"),
    sendPromptAndWait: vi.fn(async () => {}),
    resolveByLabel: vi.fn(() => undefined),
    ...overrides,
  }
}

describe("AIP-58 §4 — $run.workspace / {{run.workspace}} binding", () => {
  it("$run.workspace resolves to the wired workspace path in a tool step's input", async () => {
    const workspace = tmp("aip58-binding-")
    try {
      let seen: unknown
      const workflow: RuntimeWorkflow = {
        id: "wf",
        steps: [{ kind: "transform", id: "t", compute: (b) => (seen = b.run?.workspace) }],
      }
      await runWorkflow({ workflow, workspace })
      expect(seen).toBe(workspace)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("no workspace wired ⇒ bindings.run is undefined, never a crash", async () => {
    let seen: unknown = "sentinel"
    const workflow: RuntimeWorkflow = {
      id: "wf",
      steps: [{ kind: "transform", id: "t", compute: (b) => (seen = b.run) }],
    }
    await runWorkflow({ workflow })
    expect(seen).toBeUndefined()
  })
})

describe("AIP-58 §4 — kind: \"artifact\" step", () => {
  it("hashes + sizes + copies the declared file into artifactsDir, reporting an ArtifactEntry", async () => {
    const root = tmp("aip58-artifact-")
    const workspace = join(root, "scratch")
    const artifactsDir = join(root, "artifacts")
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, "brief.md"), "# Hello\n")

    try {
      const onArtifact = vi.fn()
      const workflow: RuntimeWorkflow = {
        id: "wf",
        steps: [{ kind: "artifact", id: "save", key: "brief", path: "brief.md", contentType: "text/markdown" }],
      }
      const { output } = await runWorkflow({ workflow, workspace, artifactsDir, onArtifact })
      const entry = output as ArtifactEntry

      expect(entry).toMatchObject({
        key: "brief",
        path: "artifacts/brief",
        size: "# Hello\n".length,
        stepId: "save",
        contentType: "text/markdown",
      })
      expect(entry.sha256).toBe(sha256("# Hello\n"))
      expect(readFileSync(join(artifactsDir, "brief"), "utf8")).toBe("# Hello\n")
      expect(onArtifact).toHaveBeenCalledWith(entry)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a path escaping the workspace (../) throws instead of copying", async () => {
    const root = tmp("aip58-artifact-escape-")
    const workspace = join(root, "scratch")
    const artifactsDir = join(root, "artifacts")
    mkdirSync(workspace, { recursive: true })

    try {
      const workflow: RuntimeWorkflow = {
        id: "wf",
        steps: [{ kind: "artifact", id: "save", key: "k", path: "../secret" }],
      }
      await expect(runWorkflow({ workflow, workspace, artifactsDir })).rejects.toThrow(/outside the run workspace/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("AIP-58 §4 — cache interplay across runs (kind: \"artifact\")", () => {
  it("a cache hit relocates the file into the NEW run's own artifactsDir — never shares a directory across runs", async () => {
    const { cache } = memCache()

    // "Run A": produces the file and declares it as an artifact.
    const rootA = tmp("aip58-cache-a-")
    const workspaceA = join(rootA, "scratch")
    const artifactsDirA = join(rootA, "artifacts")
    mkdirSync(workspaceA, { recursive: true })
    writeFileSync(join(workspaceA, "out.txt"), "hello from run A")

    const workflow: RuntimeWorkflow = {
      id: "wf",
      steps: [{ kind: "artifact", id: "save", key: "out", path: "out.txt" }],
    }

    const onStepStartA = vi.fn()
    const r1 = await runWorkflow({
      workflow,
      workspace: workspaceA,
      artifactsDir: artifactsDirA,
      cache,
      cacheKey: "shared-cache-key",
      onStepStart: onStepStartA,
    })
    expect(onStepStartA).toHaveBeenCalledWith("save") // fresh, not cached (no second `info` arg)

    // "Run B": a SEPARATE run (own workspace/artifactsDir — disjoint
    // directories, per AIP-58 §4) reusing the same cacheKey. Its own
    // scratch/ was never written to — the ONLY reason the artifact step
    // succeeds here is the cache-hit relocation copying run A's bytes
    // forward, not a fresh read of workspaceB.
    const rootB = tmp("aip58-cache-b-")
    const workspaceB = join(rootB, "scratch")
    const artifactsDirB = join(rootB, "artifacts")
    mkdirSync(workspaceB, { recursive: true })
    expect(existsSync(join(workspaceB, "out.txt"))).toBe(false)

    const onStepStartB = vi.fn()
    const r2 = await runWorkflow({
      workflow,
      workspace: workspaceB,
      artifactsDir: artifactsDirB,
      cache,
      cacheKey: "shared-cache-key",
      onStepStart: onStepStartB,
    })
    expect(onStepStartB).toHaveBeenCalledWith("save", { cached: true })

    const entryA = r1.output as ArtifactEntry
    const entryB = r2.output as ArtifactEntry
    expect(entryB).toEqual(entryA) // same recorded key/path/hash/size

    // Disjoint on disk — run B got its OWN copy, not a pointer into run A's.
    expect(artifactsDirA).not.toBe(artifactsDirB)
    expect(readFileSync(join(artifactsDirB, "out"), "utf8")).toBe("hello from run A")
    expect(readFileSync(join(artifactsDirA, "out"), "utf8")).toBe(readFileSync(join(artifactsDirB, "out"), "utf8"))

    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  })
})

// Regression: AIP-58 P4 (#1467, per-run workspace) broke the #1421 cache —
// a cacheable `tool`/`agent` step whose resolved input/prompt embeds
// `$run.workspace` (a fresh absolute path every run) never hashed the same
// across two runs of the same `cacheKey`, so it never replayed. These two
// tools stand in for a real workflow like "write a file into the run
// workspace, then read it back": `write` returns an ABSOLUTE path under
// `$run.workspace`; `read`'s own input is exactly that path.
const writeNoteTool = defineTool({
  id: "demo.write-note",
  description: "Write text to <workspace>/note.txt.",
  inputSchema: z.object({ workspace: z.string(), text: z.string() }),
  outputSchema: z.object({ path: z.string() }),
})
const readNoteTool = defineTool({
  id: "demo.read-note",
  description: "Read text from a path.",
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.object({ text: z.string() }),
})

function noteWorkflow(text: string, writeBody: ReturnType<typeof vi.fn>, readBody: ReturnType<typeof vi.fn>): RuntimeWorkflow {
  const provider = defineDriver({
    id: "note-builtin",
    name: "Note",
    description: "Writes/reads a workspace-relative note.",
    kind: "builtin",
    implements: [
      { tool: "demo.write-note", version: "0.1.0" },
      { tool: "demo.read-note", version: "0.1.0" },
    ],
    implementations: [implementTool(writeNoteTool, writeBody), implementTool(readNoteTool, readBody)],
  })
  return {
    id: "wf",
    steps: [
      {
        kind: "tool",
        id: "write",
        tool: writeNoteTool,
        candidates: [provider],
        cacheable: true,
        input: (b) => ({ workspace: b.run!.workspace, text }),
      },
      {
        kind: "tool",
        id: "read",
        tool: readNoteTool,
        candidates: [provider],
        cacheable: true,
        input: (b) => ({ path: (b.steps.write as { path: string }).path }),
      },
    ],
  }
}

describe("AIP-58 §4 — cache interplay across runs (plain cacheable tool/agent steps)", () => {
  it("a cache hit relocates a workspace-referenced file forward: the downstream step's output points into the NEW workspace, and the file exists there", async () => {
    const { cache } = memCache()
    const writeBody = vi.fn(async ({ input }: { input: { workspace: string; text: string } }) => {
      const path = join(input.workspace, "note.txt")
      writeFileSync(path, input.text)
      return { path }
    })
    const readBody = vi.fn(async ({ input }: { input: { path: string } }) => ({
      text: readFileSync(input.path, "utf8"),
    }))
    const workflow = noteWorkflow("hello from A", writeBody, readBody)

    // Run A: a fresh execution — writes note.txt into its own workspace.
    const rootA = tmp("aip58-tool-cache-a-")
    const workspaceA = join(rootA, "scratch")
    mkdirSync(workspaceA, { recursive: true })
    const completesA: Record<string, unknown> = {}
    const r1 = await runWorkflow({
      workflow,
      workspace: workspaceA,
      cache,
      cacheKey: "shared-tool-cache-key",
      onStepComplete: (id, out) => {
        completesA[id] = out
      },
    })
    expect(r1.output).toEqual({ text: "hello from A" })
    expect(writeBody).toHaveBeenCalledTimes(1)
    expect(readBody).toHaveBeenCalledTimes(1)
    expect(completesA.write).toEqual({ path: join(workspaceA, "note.txt") })

    // Run B: a SEPARATE run (its own, disjoint workspace — AIP-58 §4) under
    // the SAME cacheKey. Its workspace never got a note.txt written into it —
    // the ONLY way `read` can succeed is a cache hit whose file was relocated
    // forward from run A's workspace.
    const rootB = tmp("aip58-tool-cache-b-")
    const workspaceB = join(rootB, "scratch")
    mkdirSync(workspaceB, { recursive: true })
    expect(existsSync(join(workspaceB, "note.txt"))).toBe(false)

    const starts: Array<[string, unknown]> = []
    const completesB: Record<string, unknown> = {}
    const r2 = await runWorkflow({
      workflow,
      workspace: workspaceB,
      cache,
      cacheKey: "shared-tool-cache-key",
      onStepStart: (id, info) => starts.push([id, info]),
      onStepComplete: (id, out) => {
        completesB[id] = out
      },
    })

    // Fully cached: neither tool body ran again.
    expect(writeBody).toHaveBeenCalledTimes(1)
    expect(readBody).toHaveBeenCalledTimes(1)
    expect(starts).toEqual([
      ["write", { cached: true }],
      ["read", { cached: true }],
    ])

    // `write`'s recorded output is rewritten onto run B's OWN workspace, not
    // still pointing at run A's (now unrelated) directory.
    expect(completesB.write).toEqual({ path: join(workspaceB, "note.txt") })
    expect(r2.output).toEqual({ text: "hello from A" })

    // And the bytes were actually relocated onto disk, not just the string.
    expect(existsSync(join(workspaceB, "note.txt"))).toBe(true)
    expect(readFileSync(join(workspaceB, "note.txt"), "utf8")).toBe("hello from A")

    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  })

  it("a real input change still invalidates the cache, even though the workspace path differs on every run too", async () => {
    // Single-step workflow this time (no downstream `read`): the point is
    // narrower than the first test — a step's OWN resolved-input change
    // (the `text` it writes) must still miss the cache, on top of (not
    // instead of) the workspace-path substring the fix now ignores. If the
    // fix over-normalized (e.g. stripped more than just the workspace path),
    // this would wrongly replay run A's "original" text for run B.
    const { cache } = memCache()
    const writeBody = vi.fn(async ({ input }: { input: { workspace: string; text: string } }) => {
      const path = join(input.workspace, "note.txt")
      writeFileSync(path, input.text)
      return { path }
    })
    const provider = defineDriver({
      id: "note-write-only-builtin",
      name: "Note (write only)",
      description: "Writes a workspace-relative note.",
      kind: "builtin",
      implements: [{ tool: "demo.write-note", version: "0.1.0" }],
      implementations: [implementTool(writeNoteTool, writeBody)],
    })
    const writeWorkflow = (text: string): RuntimeWorkflow => ({
      id: "wf",
      steps: [
        {
          kind: "tool",
          id: "write",
          tool: writeNoteTool,
          candidates: [provider],
          cacheable: true,
          input: (b) => ({ workspace: b.run!.workspace, text }),
        },
      ],
    })

    const rootA = tmp("aip58-tool-cache-invalidate-a-")
    const workspaceA = join(rootA, "scratch")
    mkdirSync(workspaceA, { recursive: true })
    const r1 = await runWorkflow({
      workflow: writeWorkflow("original"),
      workspace: workspaceA,
      cache,
      cacheKey: "invalidate-cache-key",
    })
    expect(r1.output).toEqual({ path: join(workspaceA, "note.txt") })
    expect(writeBody).toHaveBeenCalledTimes(1)

    // A DIFFERENT run (own workspace, same cacheKey) whose step writes
    // different text — a genuine input change, not just a workspace-path
    // difference. It must NOT replay the stale run A output.
    const rootB = tmp("aip58-tool-cache-invalidate-b-")
    const workspaceB = join(rootB, "scratch")
    mkdirSync(workspaceB, { recursive: true })
    const r2 = await runWorkflow({
      workflow: writeWorkflow("changed"),
      workspace: workspaceB,
      cache,
      cacheKey: "invalidate-cache-key",
    })
    expect(r2.output).toEqual({ path: join(workspaceB, "note.txt") })
    expect(writeBody).toHaveBeenCalledTimes(2)
    expect(readFileSync(join(workspaceB, "note.txt"), "utf8")).toBe("changed")

    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  })
})

describe("AIP-58 §4/§10 — declarative outputsFiles (missing-artifact)", () => {
  it("required key present ⇒ copied into artifactsDir + reported, run succeeds", async () => {
    const root = tmp("aip58-outputsfiles-ok-")
    const workspace = join(root, "scratch")
    const artifactsDir = join(root, "artifacts")
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, "brief.md"), "content")

    try {
      const onArtifact = vi.fn()
      const workflow: RuntimeWorkflow = {
        id: "wf",
        steps: [{ kind: "transform", id: "noop", compute: () => "ok" }],
        outputsFiles: { brief: { path: "brief.md", required: true } },
      }
      await runWorkflow({ workflow, workspace, artifactsDir, onArtifact })
      expect(onArtifact).toHaveBeenCalledWith(expect.objectContaining({ key: "brief", path: "artifacts/brief" }))
      expect(readFileSync(join(artifactsDir, "brief"), "utf8")).toBe("content")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("required key missing ⇒ MissingArtifactError { code: missing-artifact }, attributed to the last step", async () => {
    const root = tmp("aip58-outputsfiles-missing-")
    const workspace = join(root, "scratch")
    const artifactsDir = join(root, "artifacts")
    mkdirSync(workspace, { recursive: true })

    try {
      const workflow: RuntimeWorkflow = {
        id: "wf",
        steps: [{ kind: "transform", id: "draft", compute: () => "ok" }],
        outputsFiles: { brief: { path: "brief.md", required: true } },
      }
      const err = await runWorkflow({ workflow, workspace, artifactsDir }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MissingArtifactError)
      expect(err).toMatchObject({
        name: "MissingArtifactError",
        code: "missing-artifact",
        key: "brief",
        stepId: "draft",
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("optional key (required: false) missing ⇒ warns, run still succeeds", async () => {
    const root = tmp("aip58-outputsfiles-optional-")
    const workspace = join(root, "scratch")
    const artifactsDir = join(root, "artifacts")
    mkdirSync(workspace, { recursive: true })

    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const onArtifact = vi.fn()
      const workflow: RuntimeWorkflow = {
        id: "wf",
        steps: [{ kind: "transform", id: "draft", compute: () => "ok" }],
        outputsFiles: { pdf: { path: "export.pdf", required: false } },
      }
      const { output } = await runWorkflow({ workflow, workspace, artifactsDir, onArtifact })
      expect(output).toBe("ok")
      expect(onArtifact).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("pdf"))
      warn.mockRestore()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("required OMITTED entirely (not just false) missing ⇒ still only warns — required is opt-in, not opt-out", async () => {
    const root = tmp("aip58-outputsfiles-omitted-")
    const workspace = join(root, "scratch")
    const artifactsDir = join(root, "artifacts")
    mkdirSync(workspace, { recursive: true })

    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const onArtifact = vi.fn()
      const workflow: RuntimeWorkflow = {
        id: "wf",
        steps: [{ kind: "transform", id: "draft", compute: () => "ok" }],
        // No `required` key at all — the V3 vector's own note: "with
        // required absent or false, the same scenario would be a warning".
        outputsFiles: { pdf: { path: "export.pdf" } },
      }
      const { output } = await runWorkflow({ workflow, workspace, artifactsDir, onArtifact })
      expect(output).toBe("ok")
      expect(onArtifact).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("pdf"))
      warn.mockRestore()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("<runId> token interpolation resolves against RunWorkflowArgs.runId", async () => {
    const root = tmp("aip58-outputsfiles-token-")
    const workspace = join(root, "scratch")
    const artifactsDir = join(root, "artifacts")
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, "run_abc123.md"), "content")

    try {
      const workflow: RuntimeWorkflow = {
        id: "wf",
        steps: [{ kind: "transform", id: "draft", compute: () => "ok" }],
        outputsFiles: { brief: { path: "<runId>.md", required: true } },
      }
      await expect(
        runWorkflow({ workflow, workspace, artifactsDir, runId: "run_abc123" }),
      ).resolves.toMatchObject({ output: "ok" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
