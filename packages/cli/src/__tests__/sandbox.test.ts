import { describe, it, expect, afterEach, vi } from "vitest"

const attachSandboxMock = vi.fn()

vi.mock("@agentproto/runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/runtime")>()
  return {
    ...actual,
    attachSandbox: attachSandboxMock,
  }
})

const { runSandbox } = await import("../commands/sandbox.js")

/** Capture stdout/stderr writes into arrays. */
function captureOutput(): {
  stdout: string[]
  stderr: string[]
  restore: () => void
} {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
  return {
    stdout,
    stderr,
    restore: () => {
      outSpy.mockRestore()
      errSpy.mockRestore()
    },
  }
}

afterEach(() => {
  attachSandboxMock.mockReset()
})

describe("agentproto sandbox attach", () => {
  it("prints usage and exits 0 with no subcommand", async () => {
    const capture = captureOutput()
    const code = await runSandbox([])
    capture.restore()

    expect(code).toBe(0)
    expect(capture.stdout.join("")).toContain("agentproto sandbox attach")
    expect(attachSandboxMock).not.toHaveBeenCalled()
  })

  it("exits 2 with an unknown subcommand", async () => {
    const capture = captureOutput()
    const code = await runSandbox(["frobnicate"])
    capture.restore()

    expect(code).toBe(2)
    expect(capture.stderr.join("")).toContain('unknown subcommand "frobnicate"')
  })

  it("exits 2 when <provider> or <sandboxId> is missing", async () => {
    const capture = captureOutput()
    const code = await runSandbox(["attach", "box"])
    capture.restore()

    expect(code).toBe(2)
    expect(capture.stderr.join("")).toContain("missing <provider>")
    expect(attachSandboxMock).not.toHaveBeenCalled()
  })

  it("exits 2 when --config-json is not valid JSON", async () => {
    const capture = captureOutput()
    const code = await runSandbox(["attach", "box", "bx_abc", "--config-json", "{not json"])
    capture.restore()

    expect(code).toBe(2)
    expect(capture.stderr.join("")).toContain("not valid JSON")
    expect(attachSandboxMock).not.toHaveBeenCalled()
  })

  it("passes provider/sandboxId/config through to attachSandbox and prints the descriptor + .mcp.json snippet on success", async () => {
    attachSandboxMock.mockResolvedValue({
      ok: true,
      descriptor: {
        provider: "box",
        sandboxId: "bx_abc",
        mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
        token: "tok_secret",
        allowOrigin: "https://frazil-18790.on.ascii.dev",
      },
    })

    const capture = captureOutput()
    const code = await runSandbox([
      "attach",
      "box",
      "bx_abc",
      "--config-json",
      '{"port":18790}',
    ])
    capture.restore()

    expect(attachSandboxMock).toHaveBeenCalledWith({
      provider: "box",
      sandboxId: "bx_abc",
      config: { port: 18790 },
    })
    expect(code).toBe(0)
    const out = capture.stdout.join("")
    expect(out).toContain("sandbox attached")
    expect(out).toContain("https://frazil-18790.on.ascii.dev/mcp")
    expect(out).toContain('"Authorization": "Bearer tok_secret"')
  })

  it("--json prints only the descriptor + mcpConfig as JSON", async () => {
    attachSandboxMock.mockResolvedValue({
      ok: true,
      descriptor: {
        provider: "box",
        sandboxId: "bx_abc",
        mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
        token: "tok_secret",
        allowOrigin: "https://frazil-18790.on.ascii.dev",
      },
    })

    const capture = captureOutput()
    const code = await runSandbox(["attach", "box", "bx_abc", "--json"])
    capture.restore()

    expect(code).toBe(0)
    const payload = JSON.parse(capture.stdout.join(""))
    expect(payload.descriptor.sandboxId).toBe("bx_abc")
    expect(payload.mcpConfig.mcpServers["sandbox-box-bx_abc"].headers.Authorization).toBe(
      "Bearer tok_secret",
    )
  })

  it("--keep-alive forwards keepAlive:true to attachSandbox and prints the pinned status", async () => {
    attachSandboxMock.mockResolvedValue({
      ok: true,
      descriptor: {
        provider: "box",
        sandboxId: "bx_abc",
        mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
        token: "tok_secret",
        allowOrigin: "https://frazil-18790.on.ascii.dev",
        keepAlive: true,
      },
    })

    const capture = captureOutput()
    const code = await runSandbox(["attach", "box", "bx_abc", "--keep-alive"])
    capture.restore()

    expect(attachSandboxMock).toHaveBeenCalledWith({
      provider: "box",
      sandboxId: "bx_abc",
      keepAlive: true,
    })
    expect(code).toBe(0)
    expect(capture.stdout.join("")).toContain("keepAlive   yes (pinned no-auto-stop)")
  })

  it("omits keepAlive from attachSandbox's opts when --keep-alive is not passed", async () => {
    attachSandboxMock.mockResolvedValue({
      ok: true,
      descriptor: {
        provider: "box",
        sandboxId: "bx_abc",
        mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
        token: "tok_secret",
        allowOrigin: "https://frazil-18790.on.ascii.dev",
        keepAlive: false,
      },
    })

    const capture = captureOutput()
    const code = await runSandbox(["attach", "box", "bx_abc"])
    capture.restore()

    expect(attachSandboxMock).toHaveBeenCalledWith({ provider: "box", sandboxId: "bx_abc" })
    expect(code).toBe(0)
    expect(capture.stdout.join("")).toContain("keepAlive   no")
  })

  it("exits 1 and prints the failure message when attach fails", async () => {
    attachSandboxMock.mockResolvedValue({
      ok: false,
      code: "sandbox_attach_ungated",
      message: "sandbox_attach: refusing to emit an ungated persistent daemon URL.",
    })

    const capture = captureOutput()
    const code = await runSandbox(["attach", "box", "bx_abc"])
    capture.restore()

    expect(code).toBe(1)
    expect(capture.stderr.join("")).toContain("refusing to emit an ungated persistent daemon URL")
  })
})
