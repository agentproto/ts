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
