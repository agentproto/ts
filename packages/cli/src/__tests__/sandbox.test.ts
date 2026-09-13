import { describe, it, expect, afterEach, vi } from "vitest"

const attachSandboxMock = vi.fn()
const readSandboxLedgerMock = vi.fn()
const removeSandboxLedgerEntryMock = vi.fn()
const makeSandboxResolverMock = vi.fn()
const makeSandboxCredsStoreMock = vi.fn()

vi.mock("@agentproto/runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/runtime")>()
  return {
    ...actual,
    attachSandbox: attachSandboxMock,
    readSandboxLedger: readSandboxLedgerMock,
    removeSandboxLedgerEntry: removeSandboxLedgerEntryMock,
    makeSandboxResolver: makeSandboxResolverMock,
    makeSandboxCredsStore: makeSandboxCredsStoreMock,
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
  readSandboxLedgerMock.mockReset()
  removeSandboxLedgerEntryMock.mockReset()
  makeSandboxResolverMock.mockReset()
  makeSandboxCredsStoreMock.mockReset()
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

const LEDGER_ROW = {
  sandboxId: "bx_abc123",
  provider: "box",
  state: "paused",
  label: "review-task",
  originSessionId: "sess_1",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:05:00.000Z",
} as const

describe("agentproto sandbox list", () => {
  it("prints an empty-state line when the ledger is empty", async () => {
    readSandboxLedgerMock.mockReturnValue([])
    const capture = captureOutput()
    const code = await runSandbox(["list"])
    capture.restore()
    expect(code).toBe(0)
    expect(capture.stdout.join("")).toContain("no sandboxes in the ledger")
  })

  it("renders id/provider/label/state rows", async () => {
    readSandboxLedgerMock.mockReturnValue([LEDGER_ROW])
    const capture = captureOutput()
    const code = await runSandbox(["list"])
    capture.restore()
    expect(code).toBe(0)
    const out = capture.stdout.join("")
    expect(out).toContain("bx_abc123")
    expect(out).toContain("box")
    expect(out).toContain("review-task")
    expect(out).toContain("paused")
    expect(out).toContain("sess_1")
  })

  it("--json prints the raw rows", async () => {
    readSandboxLedgerMock.mockReturnValue([LEDGER_ROW])
    const capture = captureOutput()
    const code = await runSandbox(["list", "--json"])
    capture.restore()
    expect(code).toBe(0)
    expect(JSON.parse(capture.stdout.join("")).sandboxes[0].sandboxId).toBe("bx_abc123")
  })
})

describe("agentproto sandbox rm", () => {
  it("removes the ledger entry by exact label without touching the box", async () => {
    readSandboxLedgerMock.mockReturnValue([LEDGER_ROW])
    removeSandboxLedgerEntryMock.mockReturnValue(true)
    const capture = captureOutput()
    const code = await runSandbox(["rm", "review-task"])
    capture.restore()
    expect(code).toBe(0)
    expect(removeSandboxLedgerEntryMock).toHaveBeenCalledWith("bx_abc123")
    expect(makeSandboxResolverMock).not.toHaveBeenCalled()
    expect(capture.stdout.join("")).toContain("box untouched")
  })

  it("resolves a unique id prefix", async () => {
    readSandboxLedgerMock.mockReturnValue([LEDGER_ROW])
    removeSandboxLedgerEntryMock.mockReturnValue(true)
    const capture = captureOutput()
    const code = await runSandbox(["rm", "bx_abc"])
    capture.restore()
    expect(code).toBe(0)
    expect(removeSandboxLedgerEntryMock).toHaveBeenCalledWith("bx_abc123")
  })

  it("fails on an ambiguous prefix", async () => {
    readSandboxLedgerMock.mockReturnValue([
      LEDGER_ROW,
      { ...LEDGER_ROW, sandboxId: "bx_abc999" },
    ])
    const capture = captureOutput()
    const code = await runSandbox(["rm", "bx_abc"])
    capture.restore()
    expect(code).toBe(1)
    expect(capture.stderr.join("")).toContain("ambiguous")
    expect(removeSandboxLedgerEntryMock).not.toHaveBeenCalled()
  })

  it("fails when nothing matches", async () => {
    readSandboxLedgerMock.mockReturnValue([LEDGER_ROW])
    const capture = captureOutput()
    const code = await runSandbox(["rm", "bx_nope"])
    capture.restore()
    expect(code).toBe(1)
    expect(capture.stderr.join("")).toContain("matches no ledger entry")
  })

  it("refuses --box without --yes in a non-interactive shell", async () => {
    readSandboxLedgerMock.mockReturnValue([LEDGER_ROW])
    const capture = captureOutput()
    const code = await runSandbox(["rm", "bx_abc123", "--box"])
    capture.restore()
    expect(code).toBe(1)
    expect(capture.stderr.join("")).toContain("refusing to stop the box")
    expect(removeSandboxLedgerEntryMock).not.toHaveBeenCalled()
  })

  it("--box --yes stops the box via connect()+stop() then removes the entry", async () => {
    readSandboxLedgerMock.mockReturnValue([LEDGER_ROW])
    removeSandboxLedgerEntryMock.mockReturnValue(true)
    const stop = vi.fn(async () => {})
    makeSandboxResolverMock.mockReturnValue(async () => ({
      slug: "box",
      name: "Box",
      version: "installed",
      description: "fake",
      requiresSetup: false,
      capabilities: {},
      provider: {
        boot: vi.fn(async () => {
          throw new Error("must not boot")
        }),
        connect: vi.fn(async () => ({ sandboxId: "bx_abc123", stop })),
      },
    }))
    const capture = captureOutput()
    const code = await runSandbox(["rm", "bx_abc123", "--box", "--yes"])
    capture.restore()
    expect(code).toBe(0)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(removeSandboxLedgerEntryMock).toHaveBeenCalledWith("bx_abc123")
    expect(capture.stdout.join("")).toContain("stopped and removed")
  })

  it("leaves the ledger intact when the provider stop fails", async () => {
    readSandboxLedgerMock.mockReturnValue([LEDGER_ROW])
    makeSandboxResolverMock.mockReturnValue(async () => ({
      slug: "box",
      name: "Box",
      version: "installed",
      description: "fake",
      requiresSetup: false,
      capabilities: {},
      provider: {
        boot: vi.fn(async () => {
          throw new Error("must not boot")
        }),
        connect: vi.fn(async () => {
          throw new Error("box unreachable")
        }),
      },
    }))
    const capture = captureOutput()
    const code = await runSandbox(["rm", "bx_abc123", "--box", "--yes"])
    capture.restore()
    expect(code).toBe(1)
    expect(capture.stderr.join("")).toContain("box unreachable")
    expect(removeSandboxLedgerEntryMock).not.toHaveBeenCalled()
  })
})
