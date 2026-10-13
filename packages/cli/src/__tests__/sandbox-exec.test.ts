import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSandbox, SANDBOX_EXEC_INFRA_EXIT, type SandboxExecCliDeps } from "../commands/sandbox.js"

function captureOutput() {
  const stdout: string[] = []
  const stderr: string[] = []
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (stdout.push(String(c)), true))
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (stderr.push(String(c)), true))
  return {
    out: () => stdout.join(""),
    err: () => stderr.join(""),
    restore: () => (o.mockRestore(), e.mockRestore()),
  }
}

const found = { found: { url: "http://127.0.0.1:18790", token: "tok" }, stale: [] }

function deps(response: { status: number; body: unknown }) {
  const post = vi.fn(async (_url: string, _body: unknown, _token?: string) => response)
  const d: SandboxExecCliDeps = { discover: async () => found, post }
  return { d, post }
}

const okBody = (exitCode: number, stdout = "", stderr = "") => ({
  status: 200,
  body: { ok: true, result: { exitCode, stdout, stderr, durationMs: 1, sandboxId: "sbx" } },
})

let cap: ReturnType<typeof captureOutput>
beforeEach(() => {
  cap = captureOutput()
})
afterEach(() => cap.restore())

describe("agentproto sandbox exec — argument parsing", () => {
  it("sends the parsed flags to POST /sandboxes/exec with the daemon token", async () => {
    const { d, post } = deps(okBody(0, "hi\n"))
    const code = await runSandbox(
      [
        "exec", "e2b",
        "--sandbox-id", "sbx_1",
        "--cwd", "/home/user",
        "--timeout", "10m",
        "--env", "A=1", "--env", "B=x=y",
        "--env-profile", "OPENAI_API_KEY=openai-main",
        "--env-profile", "GH_TOKEN=gh",
        "--", "echo hi && ls",
      ],
      undefined,
      d,
    )
    expect(code).toBe(0)
    expect(post).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/sandboxes/exec",
      {
        provider: "e2b",
        command: "echo hi && ls",
        sandboxId: "sbx_1",
        cwd: "/home/user",
        env: { A: "1", B: "x=y" },
        envProfiles: { OPENAI_API_KEY: "openai-main", GH_TOKEN: "gh" },
        timeoutMs: 600_000,
      },
      "tok",
    )
    expect(cap.out()).toBe("hi\n")
  })

  it("shell-quotes a multi-argument command, passes a single argument verbatim", async () => {
    const multi = deps(okBody(0))
    await runSandbox(["exec", "e2b", "--", "echo", "it's here", "a b"], undefined, multi.d)
    expect((multi.post.mock.calls[0]![1] as { command: string }).command).toBe(`echo 'it'\\''s here' 'a b'`)
    const single = deps(okBody(0))
    await runSandbox(["exec", "e2b", "--", "a | b"], undefined, single.d)
    expect((single.post.mock.calls[0]![1] as { command: string }).command).toBe("a | b")
  })

  it("keeps flag-looking tokens after -- as part of the command", async () => {
    const { d, post } = deps(okBody(0))
    await runSandbox(["exec", "e2b", "--", "ls", "--env", "-la"], undefined, d)
    expect((post.mock.calls[0]![1] as { command: string; env?: unknown }).command).toBe("ls --env -la")
    expect((post.mock.calls[0]![1] as { env?: unknown }).env).toBeUndefined()
  })

  it("reads --file <local>:<boxPath> and uploads it as base64", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-exec-cli-"))
    try {
      const local = join(dir, "job.sh")
      await writeFile(local, Buffer.from([0, 1, 2, 255]))
      const { d, post } = deps(okBody(0))
      const code = await runSandbox(["exec", "e2b", "--file", `${local}:/home/user/job.sh`, "--", "bash job.sh"], undefined, d)
      expect(code).toBe(0)
      expect((post.mock.calls[0]![1] as { files: unknown }).files).toEqual([
        { path: "/home/user/job.sh", content: Buffer.from([0, 1, 2, 255]).toString("base64"), encoding: "base64" },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    [["exec", "--", "ls"], "missing <provider>"],
    [["exec", "e2b"], "missing the command"],
    [["exec", "e2b", "extra", "--", "ls"], "unexpected argument"],
    [["exec", "e2b", "--env", "NOEQUALS", "--", "ls"], "--env expects NAME=value"],
    [["exec", "e2b", "--env-profile", "K=", "--", "ls"], "--env-profile expects"],
    [["exec", "e2b", "--env-profile", "K=a", "--env-profile", "K=b", "--", "ls"], "given twice"],
    [["exec", "e2b", "--timeout", "30", "--", "ls"], "--timeout"],
    [["exec", "e2b", "--file", "nocolon", "--", "ls"], "--file expects"],
    [["exec", "e2b", "--file", "/definitely/missing/file:/box/x", "--", "ls"], "cannot read"],
    [["exec", "e2b", "--bogus", "--", "ls"], "bogus"],
  ])("usage error %j exits 2 without contacting the daemon", async (argv, message) => {
    const { d, post } = deps(okBody(0))
    const code = await runSandbox(argv, undefined, d)
    expect(code).toBe(2)
    expect(cap.err()).toContain(message)
    expect(post).not.toHaveBeenCalled()
  })
})

describe("agentproto sandbox exec — exit codes + output", () => {
  it("propagates the box command's exit code and streams stdout/stderr", async () => {
    const { d } = deps(okBody(7, "out\n", "err\n"))
    const code = await runSandbox(["exec", "e2b", "--", "false"], undefined, d)
    expect(code).toBe(7)
    expect(cap.out()).toBe("out\n")
    expect(cap.err()).toBe("err\n")
  })

  it("keeps a non-zero exit non-zero when it wraps to 0 (256 → 1) and wraps others into 0-255", async () => {
    expect(await runSandbox(["exec", "e2b", "--", "x"], undefined, deps(okBody(256)).d)).toBe(1)
    expect(await runSandbox(["exec", "e2b", "--", "x"], undefined, deps(okBody(-1)).d)).toBe(255)
  })

  it("--json prints the daemon response and still exits with the box's code", async () => {
    const { d } = deps(okBody(3, "o"))
    const code = await runSandbox(["exec", "e2b", "--json", "--", "x"], undefined, d)
    expect(code).toBe(3)
    const parsed = JSON.parse(cap.out()) as { ok: boolean; result: { exitCode: number } }
    expect(parsed.ok).toBe(true)
    expect(parsed.result.exitCode).toBe(3)
  })

  it("a daemon-reported failure prints [code] message on stderr and exits 125", async () => {
    const { d } = deps({
      status: 422,
      body: { ok: false, code: "sandbox_exec_env_profile", message: 'envProfiles: unknown auth profile "nope".' },
    })
    const code = await runSandbox(["exec", "e2b", "--env-profile", "K=nope", "--", "x"], undefined, d)
    expect(code).toBe(SANDBOX_EXEC_INFRA_EXIT)
    expect(cap.err()).toContain('[sandbox_exec_env_profile] envProfiles: unknown auth profile "nope".')
  })

  it("--json on a failure prints the error body and exits 125", async () => {
    const { d } = deps({ status: 422, body: { ok: false, code: "sandbox_exec_failed", message: "boom" } })
    const code = await runSandbox(["exec", "e2b", "--json", "--", "x"], undefined, d)
    expect(code).toBe(125)
    expect(JSON.parse(cap.out())).toMatchObject({ ok: false, code: "sandbox_exec_failed" })
  })

  it("exits 125 with a clear message when no daemon is running", async () => {
    const post = vi.fn()
    const code = await runSandbox(["exec", "e2b", "--", "x"], undefined, {
      discover: async () => ({ found: null, stale: [] }),
      post,
    })
    expect(code).toBe(125)
    expect(cap.err()).toContain("no live daemon found")
    expect(post).not.toHaveBeenCalled()
  })

  it("exits 125 when the daemon is unreachable, and on an auth rejection", async () => {
    const unreachable = await runSandbox(["exec", "e2b", "--", "x"], undefined, {
      discover: async () => found,
      post: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    expect(unreachable).toBe(125)
    expect(cap.err()).toContain("could not reach the daemon")
    const denied = await runSandbox(["exec", "e2b", "--", "x"], undefined, deps({ status: 401, body: { error: "no" } }).d)
    expect(denied).toBe(125)
    expect(cap.err()).toContain("AGENTPROTO_DAEMON_TOKEN")
  })
})

describe("agentproto sandbox exec — help", () => {
  it("documents exec and warns against secrets in --env", async () => {
    const code = await runSandbox(["--help"])
    expect(code).toBe(0)
    const help = cap.out()
    expect(help).toContain("agentproto sandbox exec <provider>")
    expect(help).toContain("do NOT pass secrets here")
    expect(help).toContain("--env-profile")
  })
})
