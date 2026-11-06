import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"
import { computerSandboxProvider, createDetachedExecIo } from "../provider.js"
import { ComputerControllerClient, ComputerApiError } from "../client.js"
import { detachedExec, type DetachedExecIo } from "../detached-exec.js"
import { FakeController } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-secret-detached-aaaaaaaaaaaa"

function spec(controllerUrl: string, extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: {
      controllerUrl,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
      template: "node",
      cpus: 4,
      memoryMiB: 8192,
      ...extra,
    },
  }
}

const bootOpts = { env: {} as Record<string, string> }

describe("detached exec transport", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
    vi.restoreAllMocks()
  })

  it("runs a command above the threshold through detached short execs", async () => {
    // Model the edge: any single exec that would run longer than 100s is cut.
    controller.options.execTimeoutStatus = 524
    controller.options.execTimeoutOverSec = 100
    controller.options.detachedOutcome = (command) =>
      command.includes("long-run") ? { exitCode: 0, stdout: "long-output\n", stderr: "" } : undefined

    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    controller.execs.length = 0

    const result = await booted.exec!({ command: "long-run", timeoutMs: 150_000 })

    expect(result).toMatchObject({ exitCode: 0, stdout: "long-output\n", stderr: "" })
    expect(typeof result.durationMs).toBe("number")
    const scripts = controller.execs.map((e) => e.argv[2] ?? "")
    expect(scripts.some((s) => s.includes("setsid nohup"))).toBe(true)
    // The old single-request path would have issued one exec with
    // timeoutSec 150 and been refused with a 524. Every request here is short.
    expect(controller.execs.every((e) => e.timeoutSec <= 90)).toBe(true)
  })

  it("reports a non-zero exit as a result, not a throw", async () => {
    controller.options.execTimeoutStatus = 524
    controller.options.execTimeoutOverSec = 100
    controller.options.detachedOutcome = (command) =>
      command.includes("explode")
        ? { exitCode: 7, stdout: "partial\n", stderr: "boom\n" }
        : undefined

    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    controller.execs.length = 0

    const result = await booted.exec!({ command: "explode", timeoutMs: 120_000 })

    expect(result).toMatchObject({ exitCode: 7, stdout: "partial\n", stderr: "boom\n" })
  })

  it("keeps the single request path for a short command", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    controller.execs.length = 0

    const result = await booted.exec!({ command: "echo hi", timeoutMs: 5_000 })

    expect(result.exitCode).toBe(0)
    expect(controller.execs).toHaveLength(1)
    expect(controller.execs[0]!.argv[2]).toContain("echo hi")
    expect(controller.execs[0]!.argv[2]).not.toContain("setsid nohup")
  })

  it("kills the process group and rejects when the command outlives its timeout", async () => {
    controller.options.detachedOutcome = (command) => (command.includes("sleep 999") ? "pending" : undefined)

    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    const client = new ComputerControllerClient({
      baseUrl: controller.url,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
    })
    controller.execs.length = 0

    const io = createDetachedExecIo(client, booted.sandboxId)
    await expect(
      detachedExec(io, "sleep 999", { timeoutMs: 250, pollIntervalMs: 10, maxPollIntervalMs: 10 }),
    ).rejects.toThrow(/command timed out after 250ms/)

    const scripts = controller.execs.map((e) => e.argv[2] ?? "")
    expect(scripts.some((s) => s.includes("kill -TERM -\"$pid\""))).toBe(true)
  })

  it("retries a transient 5xx poll before failing", async () => {
    controller.options.detachedOutcome = (command) =>
      command.includes("slowish") ? { exitCode: 0, stdout: "ok\n", stderr: "" } : undefined

    const booted = await computerSandboxProvider.boot(spec(controller.url), bootOpts)
    const client = new ComputerControllerClient({
      baseUrl: controller.url,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
    })

    const baseIo = createDetachedExecIo(client, booted.sandboxId)
    let failedOnce = false
    const io: DetachedExecIo = {
      ...baseIo,
      exec: async (script, opts) => {
        if (!failedOnce && script.startsWith("test -f ") && script.includes("/exit")) {
          failedOnce = true
          throw new ComputerApiError(503, "temporary edge error")
        }
        return baseIo.exec(script, opts)
      },
    }

    const result = await detachedExec(io, "slowish", { timeoutMs: 5_000, pollIntervalMs: 10 })

    expect(result).toMatchObject({ exitCode: 0, stdout: "ok\n" })
    expect(failedOnce).toBe(true)
  })
})
