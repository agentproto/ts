import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"

const { sandboxCreateMock } = vi.hoisted(() => ({ sandboxCreateMock: vi.fn() }))

vi.mock("e2b", () => ({
  Sandbox: { create: sandboxCreateMock },
  CommandExitError: class CommandExitError extends Error {},
  SandboxNotFoundError: class SandboxNotFoundError extends Error {},
}))

function fakeSandbox(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sandboxId: "sbx_abc",
    getHost: vi.fn((port: number) => `sbx-abc-${port}.e2b.dev`),
    commands: { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
    kill: vi.fn(async () => true),
    ...overrides,
  }
}

const { buildEnvForBox, mergeBuildEnv, e2bSandboxProvider, SIZES, DEFAULT_SIZE } =
  await import("../provider.js")

/** The vars a 4 vCPU / 8192 MB box (the default preset) gets, by themselves. */
const DEFAULT_BOX_ENV = {
  NODE_OPTIONS: "--max-old-space-size=2457",
  npm_config_workspace_concurrency: "2",
  TURBO_CONCURRENCY: "2",
}

const runCalls = (sandbox: { commands: { run: ReturnType<typeof vi.fn> } }) =>
  sandbox.commands.run.mock.calls

const commandOf = (call: unknown[]) => String(call[0])

describe("buildEnvForBox", () => {
  it.each([
    [1, 1024, "--max-old-space-size=768", "1"],
    [2, 2048, "--max-old-space-size=1228", "1"],
    [2, 4096, "--max-old-space-size=2457", "1"],
    [4, 8192, "--max-old-space-size=2457", "2"],
  ])("%i vCPU / %i MB → %s at concurrency %s", (cpuCount, memoryMb, nodeOptions, concurrency) => {
    expect(buildEnvForBox({ cpuCount, memoryMb })).toEqual({
      NODE_OPTIONS: nodeOptions,
      npm_config_workspace_concurrency: concurrency,
      TURBO_CONCURRENCY: concurrency,
    })
  })

  it("sizes the DEFAULT template (the default size preset) to 2 builds at a 2457 MB heap", () => {
    const preset = SIZES[DEFAULT_SIZE]
    expect(buildEnvForBox({ cpuCount: preset.cpuCount, memoryMb: preset.memoryMb })).toEqual(
      DEFAULT_BOX_ENV,
    )
  })
})

describe("mergeBuildEnv", () => {
  const boxEnv = buildEnvForBox({ cpuCount: 4, memoryMb: 8192 })

  it("keeps a caller NODE_OPTIONS that already sets a heap flag untouched", () => {
    const merged = mergeBuildEnv({ NODE_OPTIONS: "--max-old-space-size=6000" }, boxEnv)
    expect(merged.NODE_OPTIONS).toBe("--max-old-space-size=6000")
  })

  it("appends the box heap to a caller NODE_OPTIONS without a heap flag", () => {
    const merged = mergeBuildEnv({ NODE_OPTIONS: "--trace-gc --preserve-symlinks" }, boxEnv)
    expect(merged.NODE_OPTIONS).toBe("--trace-gc --preserve-symlinks --max-old-space-size=2457")
  })

  it("adds every var when the caller env has none, and only fills gaps otherwise", () => {
    expect(mergeBuildEnv({}, boxEnv)).toEqual(boxEnv)
    expect(mergeBuildEnv(undefined, boxEnv)).toEqual(boxEnv)
    const merged = mergeBuildEnv({ npm_config_workspace_concurrency: "7" }, boxEnv)
    expect(merged.npm_config_workspace_concurrency).toBe("7") // caller wins …
    expect(merged.TURBO_CONCURRENCY).toBe("2") // … ours fills the gap
    expect(merged.NODE_OPTIONS).toBe("--max-old-space-size=2457")
  })

  it("never mutates the caller env object", () => {
    const caller = { OPENROUTER_API_KEY: "k" }
    mergeBuildEnv(caller, boxEnv)
    expect(caller).toEqual({ OPENROUTER_API_KEY: "k" })
  })
})

describe("config.buildEnv on boot", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sandboxCreateMock.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const boot = async (
    config: Record<string, unknown>,
    env: Record<string, string> = {},
    sandbox = fakeSandbox(),
  ) => {
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused")) // initial probe: not up
    fetchMock.mockResolvedValue({ ok: true }) // post-start probe: healthy
    const spec: SandboxSpec = { provider: "e2b", config: { healthProbeTimeoutMs: 0, ...config } }
    const booted = await e2bSandboxProvider.boot(spec, { env })
    const run = sandbox.commands.run as ReturnType<typeof vi.fn>
    const serve = run.mock.calls.find(call => commandOf(call).includes("agentproto serve"))
    const profile = run.mock.calls.find(call => commandOf(call).includes("/etc/profile.d/agentproto-build.sh"))
    return { sandbox, run, serve, profile, booted }
  }

  it("ships the build env to the box: a profile.d file AND the daemon start env", async () => {
    const { run, serve, profile } = await boot({}, { OPENROUTER_API_KEY: "k" })

    // the profile.d write happens before the daemon starts, and carries the
    // same values the daemon env gets (idempotent tee + an idempotent
    // ~/.bashrc source line for templates whose login shell skips profile.d)
    expect(profile).toBeDefined()
    const profileCommand = commandOf(profile!)
    expect(profileCommand).toContain("sudo tee /etc/profile.d/agentproto-build.sh")
    expect(profileCommand).toContain("--max-old-space-size=2457")
    expect(profileCommand).toContain("npm_config_workspace_concurrency")
    expect(profileCommand).toContain("TURBO_CONCURRENCY")
    expect(profileCommand).toContain("/etc/profile.d/agentproto-build.sh' >> \"$HOME/.bashrc\"")
    expect(run.mock.calls.indexOf(profile!)).toBeLessThan(run.mock.calls.indexOf(serve!))

    // the daemon start env carries the vars alongside the caller's passthrough
    expect(serve![1]).toMatchObject({
      background: true,
      timeoutMs: 0,
      envs: { OPENROUTER_API_KEY: "k", ...DEFAULT_BOX_ENV },
    })
  })

  it("lets a caller NODE_OPTIONS win through the boot path", async () => {
    const withHeap = await boot({}, { NODE_OPTIONS: "--max-old-space-size=6000" })
    expect((withHeap.serve![1] as { envs: Record<string, string> }).envs.NODE_OPTIONS).toBe(
      "--max-old-space-size=6000",
    )

    const withoutHeap = await boot({}, { NODE_OPTIONS: "--trace-gc" })
    expect((withoutHeap.serve![1] as { envs: Record<string, string> }).envs.NODE_OPTIONS).toBe(
      "--trace-gc --max-old-space-size=2457",
    )
  })

  it("buildEnv: false adds no env and writes no profile.d file", async () => {
    const { run, serve, profile } = await boot({ buildEnv: false }, { OPENROUTER_API_KEY: "k" })

    expect(profile).toBeUndefined()
    expect(serve![1]).toMatchObject({ envs: { OPENROUTER_API_KEY: "k" } })
    expect(
      run.mock.calls.some(call => commandOf(call).includes("/etc/profile.d/agentproto-build.sh")),
    ).toBe(false)
  })

  it("config.buildEnv numbers override the computed ones", async () => {
    const both = await boot({ buildEnv: { concurrency: 4, heapMb: 1024 } })
    expect((both.serve![1] as { envs: Record<string, string> }).envs).toEqual({
      NODE_OPTIONS: "--max-old-space-size=1024",
      npm_config_workspace_concurrency: "4",
      TURBO_CONCURRENCY: "4",
    })

    const heapOnly = await boot({ buildEnv: { heapMb: 3072 } })
    expect((heapOnly.serve![1] as { envs: Record<string, string> }).envs).toEqual({
      NODE_OPTIONS: "--max-old-space-size=3072",
      npm_config_workspace_concurrency: "2",
      TURBO_CONCURRENCY: "2",
    })

    const profileCommand = commandOf(heapOnly.profile!)
    expect(profileCommand).toContain("--max-old-space-size=3072")
    expect(profileCommand).toContain("'  export NODE_OPTIONS=\"--max-old-space-size=3072\"'")
  })

  it("drops invalid buildEnv numbers instead of exporting them (like swapMb)", async () => {
    const { serve } = await boot({ buildEnv: { concurrency: 0, heapMb: Number.NaN } })
    expect((serve![1] as { envs: Record<string, string> }).envs).toEqual(DEFAULT_BOX_ENV)
  })

  it("probes an explicit custom template for its box size instead of assuming the default", async () => {
    const sandbox = fakeSandbox({
      commands: {
        run: vi.fn(async (command: string) =>
          String(command).includes("nproc")
            ? { exitCode: 0, stdout: "2\n4096\n", stderr: "" }
            : { exitCode: 0, stdout: "", stderr: "" },
        ),
      },
    })
    const { run, serve } = await boot({ template: "custom-template" }, {}, sandbox)

    const probe = run.mock.calls.find(call => commandOf(call).includes("nproc"))
    expect(probe).toBeDefined()
    expect(commandOf(probe!)).toContain("free -m")
    // a probed 2 vCPU / 4096 MB box → one build at a 2457 MB heap
    expect((serve![1] as { envs: Record<string, string> }).envs).toEqual({
      NODE_OPTIONS: "--max-old-space-size=2457",
      npm_config_workspace_concurrency: "1",
      TURBO_CONCURRENCY: "1",
    })
  })

  it("a box that cannot write profile.d still boots (the daemon env still carries the vars)", async () => {
    const sandbox = fakeSandbox({
      commands: {
        run: vi.fn(async (command: string) => {
          if (String(command).includes("/etc/profile.d/")) throw new Error("sudo: permission denied")
          return { exitCode: 0, stdout: "", stderr: "" }
        }),
      },
    })
    const { serve } = await boot({}, {}, sandbox)

    expect(serve![1]).toMatchObject({ envs: DEFAULT_BOX_ENV })
    expect(sandbox.kill).not.toHaveBeenCalled()
  })
})
