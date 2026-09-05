/**
 * Tests for `agentproto app init` / `agentproto app validate`
 * (`commands/app-init.ts`).
 *
 * init must wrap `create-agentproto-app`'s scaffoldApp (including the
 * `trame` template that emits the minimal AIP app trame) and refuse
 * non-empty targets; validate must pass a freshly scaffolded `trame` app
 * and fail — with the right finding — on a broken workflow, an unknown
 * ui.tools entry, or a failing verify command.
 *
 * Every case is hermetic: it scaffolds into a temp dir and cleans up. The
 * verify check spawns real `node` (the same thing CI runs).
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runAppInit, runAppValidate } from "../commands/app-init.js"

const tmpRoots: string[] = []

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
})

/** Allocate a temp dir tracked for cleanup. */
async function mktmp(prefix = "app-init-validate-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

/** Read validate's --json stdout by capturing process.stdout.write. */
async function captureJson(
  run: () => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
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
  try {
    const code = await run()
    return { code, stdout, stderr }
  } finally {
    vi.restoreAllMocks()
  }
}

interface ValidateReport {
  ok: boolean
  findings: { scope: string; level: string; message: string }[]
}

function parseReport(stdout: string): ValidateReport {
  // The verify command's own stdout (compact JSON) precedes the report —
  // the report is the LAST pretty-printed object (opens with a lone "{").
  const lines = stdout.split("\n")
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === "{") {
      start = i
      break
    }
  }
  if (start === -1) throw new Error(`not a validate report: ${stdout}`)
  const parsed: unknown = JSON.parse(lines.slice(start).join("\n"))
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("ok" in parsed) ||
    !("findings" in parsed)
  ) {
    throw new Error(`not a validate report: ${stdout}`)
  }
  const ok: unknown = parsed.ok
  const rawFindings: unknown = parsed.findings
  if (typeof ok !== "boolean" || !Array.isArray(rawFindings)) {
    throw new Error(`not a validate report: ${stdout}`)
  }
  const findings = rawFindings.map((f) => {
    if (
      typeof f !== "object" ||
      f === null ||
      !("scope" in f) ||
      !("level" in f) ||
      !("message" in f)
    ) {
      throw new Error(`not a validate finding: ${JSON.stringify(f)}`)
    }
    return {
      scope: String(f.scope),
      level: String(f.level),
      message: String(f.message),
    }
  })
  return { ok, findings }
}

// ── init ─────────────────────────────────────────────────────────────────

describe("agentproto app init", () => {
  it("scaffolds the trame template into an empty dir", async () => {
    const root = await mktmp()
    const target = join(root, "my-trame-app")

    const { code, stdout } = await captureJson(() =>
      runAppInit(["trame", target]),
    )

    expect(code).toBe(0)
    expect(stdout).toContain("scaffolded 'my-trame-app' (trame)")
    // The trame shape: APP.md, one agent, one workflow (+prompt), gate,
    // verify, data dictionary, UI, tests.
    await expect(
      readFile(join(target, ".agentproto", "APP.md"), "utf8"),
    ).resolves.toContain("schema: app/v1")
    await expect(
      readFile(join(target, "gates", "example.mjs"), "utf8"),
    ).resolves.toBeTruthy()
    await expect(
      readFile(join(target, "scripts", "verify.mjs"), "utf8"),
    ).resolves.toBeTruthy()
    await expect(
      readFile(join(target, "data", "DATA.md"), "utf8"),
    ).resolves.toBeTruthy()
    await expect(
      readFile(join(target, "tests", "gate.test.mjs"), "utf8"),
    ).resolves.toBeTruthy()
    await expect(
      readFile(
        join(
          target,
          ".agentproto",
          "agents",
          "my-trame-app-agent",
          "AGENT.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("my-trame-app-agent")
  })

  it("scaffolds trame with no explicit dir into the cwd", async () => {
    const root = await mktmp()
    const origCwd = process.cwd()
    process.chdir(root)
    try {
      const { code } = await captureJson(() => runAppInit(["trame"]))
      expect(code).toBe(0)
      await expect(
        readFile(join(root, ".agentproto", "APP.md"), "utf8"),
      ).resolves.toBeTruthy()
    } finally {
      process.chdir(origCwd)
    }
  })

  it("refuses an unknown template", async () => {
    const { code, stderr } = await captureJson(async () =>
      runAppInit(["nope", join(await mktmp(), "x")]),
    )
    expect(code).toBe(2)
    expect(stderr).toContain("unknown template 'nope'")
  })

  it("refuses a non-empty target dir", async () => {
    const root = await mktmp()
    await writeFile(join(root, "occupied.txt"), "here first\n", "utf8")
    const { code, stderr } = await captureJson(() =>
      runAppInit(["trame", root]),
    )
    expect(code).toBe(2)
    expect(stderr).toContain("not empty")
  })
})

// ── validate ─────────────────────────────────────────────────────────────

describe("agentproto app validate", () => {
  /** Scaffold a fresh trame app and return its dir. */
  async function scaffoldTrame(name = "valid-app"): Promise<string> {
    const root = await mktmp()
    const target = join(root, name)
    const init = await captureJson(() => runAppInit(["trame", target]))
    expect(init.code).toBe(0)
    return target
  }

  it("passes a freshly scaffolded trame app (verify command runs, exit 0)", async () => {
    const appDir = await scaffoldTrame()
    const { code, stdout } = await captureJson(() =>
      runAppValidate([appDir, "--json"]),
    )
    expect(code).toBe(0)
    const report = parseReport(stdout)
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
  })

  it("fails with the loader message when a workflow has an unknown step kind", async () => {
    const appDir = await scaffoldTrame("broken-workflow")
    const wfPath = join(
      appDir,
      ".agentproto",
      "workflows",
      "broken-workflow-flow",
      "WORKFLOW.md",
    )
    const wf = await readFile(wfPath, "utf8")
    await writeFile(
      wfPath,
      wf.replace("kind: agent", "kind: teleport"),
      "utf8",
    )

    const { code, stdout } = await captureJson(() =>
      runAppValidate([appDir, "--json"]),
    )
    expect(code).toBe(1)
    const report = parseReport(stdout)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "error" && f.scope === "workflow:broken-workflow-flow",
      ),
    ).toBe(true)
  })

  it("fails when ui.tools declares an unknown tool", async () => {
    const appDir = await scaffoldTrame("unknown-tool")
    const appMdPath = join(appDir, ".agentproto", "APP.md")
    const appMd = await readFile(appMdPath, "utf8")
    await writeFile(
      appMdPath,
      appMd.replace(
        "    - app_state_list\n",
        "    - app_state_list\n    - banana_teleport\n",
      ),
      "utf8",
    )

    const { code, stdout } = await captureJson(() =>
      runAppValidate([appDir, "--json"]),
    )
    expect(code).toBe(1)
    const report = parseReport(stdout)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) =>
          f.scope === "ui.tools" && f.message.includes("banana_teleport"),
      ),
    ).toBe(true)
  })

  it("fails — and propagates the exit code shape — when verify.command exits 1", async () => {
    const appDir = await scaffoldTrame("failing-verify")
    await writeFile(
      join(appDir, "scripts", "verify.mjs"),
      "process.exit(1)\n",
      "utf8",
    )

    const { code, stdout } = await captureJson(() =>
      runAppValidate([appDir, "--json"]),
    )
    expect(code).toBe(1)
    const report = parseReport(stdout)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.scope === "verify" && f.message.includes("exit"),
      ),
    ).toBe(true)
  })

  it("fails when a declared data dir has no DATA.md", async () => {
    const appDir = await scaffoldTrame("no-data-md")
    await rm(join(appDir, "data", "DATA.md"))

    const { code, stdout } = await captureJson(() =>
      runAppValidate([appDir, "--json"]),
    )
    expect(code).toBe(1)
    const report = parseReport(stdout)
    expect(
      report.findings.some((f) => f.scope === "data"),
    ).toBe(true)
  })

  it("fails on a directory with no APP.md", async () => {
    const root = await mktmp()
    await mkdir(join(root, "empty"), { recursive: true })
    const { code, stdout } = await captureJson(() =>
      runAppValidate([join(root, "empty"), "--json"]),
    )
    expect(code).toBe(1)
    const report = parseReport(stdout)
    expect(report.ok).toBe(false)
    expect(report.findings[0]?.scope).toBe("app")
  })
})
