/**
 * Tests for `agentproto agent create` / `agentproto agent list`
 * (`commands/agent.ts`). Hermetic — each case writes into a temp dir and
 * cleans up; no daemon.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import matter from "gray-matter"

import { runAgentCreate, runAgentList, listAgentsFromDir } from "../commands/agent.js"

const tmpRoots: string[] = []

async function mktmp(prefix = "cli-agent-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
})

async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ""
  let stderr = ""
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  const code = await run()
  return { code, stdout, stderr }
}

describe("agentproto agent create", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mktmp()
  })

  it("renders a valid agent/v1 AGENT.md at .agents/<slug>/AGENT.md", async () => {
    const { code, stdout } = await capture(() => runAgentCreate(["reviewer", dir]))
    expect(code).toBe(0)
    const path = join(dir, ".agents", "reviewer", "AGENT.md")
    expect(stdout).toContain(path)
    const raw = await readFile(path, "utf8")
    const fm = matter(raw).data as Record<string, unknown>
    expect(fm.schema).toBe("agent/v1")
    expect(fm.id).toBe("reviewer")
    expect(fm.description).toBe("Agent reviewer.")
    expect(typeof fm.model).toBe("string")
    expect(fm.tools).toEqual([])
    expect(fm.skills).toEqual([])
  })

  it("honours --model / --description", async () => {
    const code = await (await capture(() => runAgentCreate(["writer", dir, "--model", "gpt-x", "--description", "Writes."]))).code
    expect(code).toBe(0)
    const fm = matter(await readFile(join(dir, ".agents", "writer", "AGENT.md"), "utf8")).data as Record<string, unknown>
    expect(fm.model).toBe("gpt-x")
    expect(fm.description).toBe("Writes.")
  })

  it("refuses to overwrite without --force", async () => {
    await capture(() => runAgentCreate(["dup", dir]))
    const { code, stderr } = await capture(() => runAgentCreate(["dup", dir]))
    expect(code).toBe(1)
    expect(stderr).toContain("already exists")
  })

  it("overwrites with --force", async () => {
    await capture(() => runAgentCreate(["dup", dir, "--description", "first"]))
    const { code } = await capture(() => runAgentCreate(["dup", dir, "--force", "--description", "second"]))
    expect(code).toBe(0)
    const fm = matter(await readFile(join(dir, ".agents", "dup", "AGENT.md"), "utf8")).data as Record<string, unknown>
    expect(fm.description).toBe("second")
  })

  it("rejects an invalid slug with exit 1", async () => {
    const { code, stderr } = await capture(() => runAgentCreate(["BAD ID", dir]))
    expect(code).toBe(1)
    expect(stderr).toMatch(/defineAgent/i)
  })
})

describe("agentproto agent list", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mktmp()
  })

  it("prints nothing-special when there are no agents", async () => {
    const { code, stdout } = await capture(() => runAgentList([dir]))
    expect(code).toBe(0)
    expect(stdout).toContain("no agents under")
  })

  it("lists created agents with id and path", async () => {
    await capture(() => runAgentCreate(["a1", dir]))
    await capture(() => runAgentCreate(["a2", dir]))
    const { code, stdout } = await capture(() => runAgentList([dir]))
    expect(code).toBe(0)
    expect(stdout).toContain(`a1 -> ${join(dir, ".agents", "a1", "AGENT.md")}`)
    expect(stdout).toContain(`a2 -> ${join(dir, ".agents", "a2", "AGENT.md")}`)
  })

  it("surfaces name/version when the frontmatter carries them", async () => {
    const agentDir = join(dir, ".agents", "named")
    await mkdir(agentDir, { recursive: true })
    await writeFile(
      join(agentDir, "AGENT.md"),
      "---\nschema: agent/v1\nid: named\ndescription: x\nmodel: m\nname: Pretty\nversion: 2.0.0\n---\nbody\n",
      "utf8",
    )
    const rows = await listAgentsFromDir(dir)
    expect(rows).toEqual([
      { id: "named", path: join(agentDir, "AGENT.md"), name: "Pretty", version: "2.0.0" },
    ])
  })

  it("skips entries without an AGENT.md", async () => {
    await mkdir(join(dir, ".agents", "empty"), { recursive: true })
    expect(await listAgentsFromDir(dir)).toEqual([])
  })
})
