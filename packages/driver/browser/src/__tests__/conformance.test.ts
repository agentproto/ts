import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createFakeBrowserProvider,
  createFakeRemoteBrowserProvider,
  runConformance,
  startFakeRemoteBrowserServer,
  type ConformanceLevelReport,
  type FakeRemoteBrowserServer,
} from "../index.js"

function level(levels: ConformanceLevelReport[], name: string): ConformanceLevelReport {
  const found = levels.find((l) => l.level === name)
  if (!found) throw new Error(`no ${name} level in report`)
  return found
}

describe("conformance kit: in-memory fake", () => {
  it("is green on every level and names each check", async () => {
    const { provider } = createFakeBrowserProvider()
    const report = await runConformance(provider)
    expect(report.failed).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.levels.map((l) => l.level)).toEqual(["core", "interaction", "network", "download", "profile"])
    expect(report.levels.every((l) => l.status === "pass")).toBe(true)
    const coreNames = level(report.levels, "core").checks.map((c) => c.name)
    expect(coreNames).toContain("launch-idempotent")
    expect(level(report.levels, "network").checks.map((c) => c.name)).toContain("list-requests")
  })

  it("attaches each level's driver at the fixture url", async () => {
    const { provider } = createFakeBrowserProvider()
    const attached: Array<string | undefined> = []
    const spying: typeof provider = {
      ...provider,
      launch: async (opts, ctx) => {
        const instance = await provider.launch(opts, ctx)
        return {
          ...instance,
          attach: (attachOpts) => {
            attached.push(attachOpts?.initialUrl)
            return instance.attach(attachOpts)
          },
        }
      },
    }
    await runConformance(spying, { levels: ["core", "interaction"], fixture: { url: "http://127.0.0.1:1/" } })
    expect(attached.length).toBeGreaterThan(0)
    expect(attached).toContain("http://127.0.0.1:1/")
  })

  it("runs only the requested levels", async () => {
    const { provider } = createFakeBrowserProvider()
    const report = await runConformance(provider, { levels: ["core"] })
    expect(report.levels.map((l) => l.level)).toEqual(["core"])
  })

  it("skips a level with browser:unsupported when the capability is missing, without failing", async () => {
    const { provider } = createFakeBrowserProvider({ capabilities: { headless: true } })
    const report = await runConformance(provider)
    expect(report.ok).toBe(true)
    const network = level(report.levels, "network")
    expect(network.status).toBe("skipped")
    expect(network.unsupportedCapability).toBe("cdp")
    expect(network.skipReason).toContain("browser:unsupported")
    expect(network.checks.map((c) => `${c.name}:${c.status}`)).toEqual(["typed-unsupported:pass"])
    expect(level(report.levels, "download").status).toBe("skipped")
    expect(level(report.levels, "profile").status).toBe("skipped")
  })
})

describe("conformance kit: deliberately broken fake", () => {
  it("is red and names the failing checks", async () => {
    const { provider } = createFakeBrowserProvider({
      id: "fake-broken",
      faults: ["non-idempotent-launch", "health-ok-after-stop", "wrong-evaluate", "empty-dom"],
    })
    const report = await runConformance(provider)
    expect(report.ok).toBe(false)
    expect(report.failed).toEqual(
      expect.arrayContaining([
        "core/launch-idempotent",
        "core/stop-idempotent",
        "interaction/evaluate",
        "interaction/get-dom",
      ]),
    )
    expect(report.failed).not.toContain("core/health")
    expect(level(report.levels, "core").status).toBe("fail")
    const evaluate = level(report.levels, "interaction").checks.find((c) => c.name === "evaluate")
    expect(evaluate?.message).toContain("expected 2")
  })

  it("fails a provider that reports a missing capability with an untyped error", async () => {
    const { provider } = createFakeBrowserProvider({
      capabilities: { headless: true },
      faults: ["untyped-unsupported"],
    })
    const report = await runConformance(provider, { levels: ["network"] })
    expect(report.failed).toEqual(["network/typed-unsupported"])
  })
})

describe("conformance kit: remote provider against a fake http server", () => {
  let server: FakeRemoteBrowserServer
  beforeAll(async () => {
    server = await startFakeRemoteBrowserServer()
  })
  afterAll(async () => {
    await server.close()
  })

  it("passes core, interaction and network for location: remote and skips profile", async () => {
    const provider = createFakeRemoteBrowserProvider()
    expect(provider.location).toBe("remote")
    const report = await runConformance(provider, { launch: { baseUrl: server.baseUrl } })
    expect(report.failed).toEqual([])
    expect(report.ok).toBe(true)
    const core = level(report.levels, "core")
    expect(core.checks.find((c) => c.name === "remote-no-local-pid")?.status).toBe("pass")
    expect(level(report.levels, "network").status).toBe("pass")
    expect(level(report.levels, "profile").status).toBe("skipped")
    // The runner cleaned up after itself: every session it opened is closed.
    expect([...server.sessions.values()].every((s) => !s.open)).toBe(true)
    expect(server.sessions.size).toBeGreaterThan(0)
  })

  it("fails the launch check cleanly when the remote is unreachable", async () => {
    const provider = createFakeRemoteBrowserProvider("fake-remote-dead")
    const report = await runConformance(provider, {
      levels: ["core"],
      launch: { baseUrl: "http://127.0.0.1:1" },
      checkTimeoutMs: 5_000,
    })
    expect(report.ok).toBe(false)
    expect(report.failed).toEqual(["core/launch"])
  })
})
