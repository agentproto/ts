import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"
import { computerSandboxProvider } from "../provider.js"
import { ComputerControllerClient } from "../client.js"
import { FakeController, rejectsArgv } from "./fake-controller.js"

const SERVICE_TOKEN = "svc-secret-argv-aaaaaaaaaaaaaaa"

const REVIEWER_ENV: Record<string, string> = {
  ANTHROPIC_AUTH_TOKEN: "sk-ant-reviewer-0123456789abcdef",
  GITHUB_TOKEN: "ghs_reviewerInstallationToken0123456789",
  AGENTPROTO_JOIN: "https://home.example.test/join?token=jt_0123456789abcdef",
  AGENTPROTO_JOIN_PROVIDER: "computer",
  AGENTPROTO_JOIN_LABELS: "pr=42,repo=agentproto/ts,run=https://github.com/agentproto/ts/actions/runs/1",
}

function spec(controllerUrl: string, extra: Record<string, unknown> = {}): SandboxSpec {
  return {
    provider: "computer",
    config: {
      controllerUrl,
      token: SERVICE_TOKEN,
      tenantId: "tenant-a",
      template: "agentproto-workstation",
      // A box origin whose host carries the word "computer", like a fleet
      // gateway named after the product.
      gatewayUrl: "https://{id}.computer.example.test",
      ...extra,
    },
  }
}

describe("fake controller argv rule", () => {
  it("matches the controller: exact, substring for long values, encoded forms", () => {
    const value = "sk-ant-reviewer-0123456789abcdef"
    expect(rejectsArgv([value], ["echo", value])).toEqual([1])
    expect(rejectsArgv([value], ["/bin/bash", "-lc", `echo ${value} | cat`])).toEqual([2])
    expect(rejectsArgv([value], ["x", `KEY=${value}`])).toEqual([1])
    expect(rejectsArgv([value], ["x", Buffer.from(value).toString("base64")])).toEqual([1])
    expect(rejectsArgv([value], ["x", "nothing here"])).toEqual([])
    // Short values only match as a whole element or key=value part.
    expect(rejectsArgv(["abc"], ["x", "has abc inside"])).toEqual([])
    expect(rejectsArgv(["abc"], ["x", "abc"])).toEqual([1])
    expect(rejectsArgv(["abc"], ["x", "K=abc"])).toEqual([1])
  })

  it("refuses an exec whose argv carries a create-time env value", async () => {
    const controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
    try {
      const client = new ComputerControllerClient({ baseUrl: controller.url, token: SERVICE_TOKEN, tenantId: "tenant-a" })
      const created = await client.createComputer({
        template: "node",
        tenantId: "tenant-a",
        env: { SOME_API_KEY: "value-registered-at-create" },
      })
      await expect(
        client.exec(created.id, ["/bin/bash", "-lc", "echo value-registered-at-create"], { timeoutSec: 5 }),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("registered secret value") })
      await expect(client.exec(created.id, ["/bin/bash", "-lc", "echo ok"], { timeoutSec: 5 })).resolves.toMatchObject({
        exitCode: 0,
      })
    } finally {
      await controller.stop()
    }
  })
})

describe("computer boot keeps env values out of exec argv", () => {
  let controller: FakeController

  beforeEach(async () => {
    controller = new FakeController({ token: SERVICE_TOKEN })
    await controller.start()
  })
  afterEach(async () => {
    await controller.stop()
  })

  it("boots with the reviewer env set and no exec argv carries a create-time value", async () => {
    const booted = await computerSandboxProvider.boot(spec(controller.url, { memoryMiB: 4096 }), { env: REVIEWER_ENV })

    const env = (controller.createBodies[0] as { env: Record<string, string> }).env
    expect(env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: REVIEWER_ENV.ANTHROPIC_AUTH_TOKEN,
      GITHUB_TOKEN: REVIEWER_ENV.GITHUB_TOKEN,
      AGENTPROTO_JOIN: REVIEWER_ENV.AGENTPROTO_JOIN,
    })
    // Descriptive join metadata is not a secret: it is not registered at create.
    expect(env).not.toHaveProperty("AGENTPROTO_JOIN_PROVIDER")
    expect(env).not.toHaveProperty("AGENTPROTO_JOIN_LABELS")

    // The daemon still receives that metadata, exported in its start command.
    const serve = controller.execs.map((e) => e.argv[2] ?? "").find((s) => s.includes("agentproto serve"))
    expect(serve).toContain("export AGENTPROTO_JOIN_PROVIDER='computer';")
    expect(serve).toContain(`export AGENTPROTO_JOIN_LABELS='${REVIEWER_ENV.AGENTPROTO_JOIN_LABELS}';`)
    expect(serve).toContain("--allow-origin 'https://")
    for (const secret of [REVIEWER_ENV.ANTHROPIC_AUTH_TOKEN, REVIEWER_ENV.GITHUB_TOKEN, REVIEWER_ENV.AGENTPROTO_JOIN]) {
      expect(controller.execs.some((e) => e.argv.some((a) => a.includes(secret as string)))).toBe(false)
    }

    // A later exec (workspace clone, agent spawn) is accepted too.
    await expect(
      booted.exec!({ command: "git --version", cwd: "/home/user", env: { GIT_TERMINAL_PROMPT: "0" } }),
    ).resolves.toMatchObject({ exitCode: 0 })
  })

  it("exports the join metadata when connect() has to restart the daemon", async () => {
    const holder = { sessionHolder: "holder-a", maxSessions: 2 }
    const booted = await computerSandboxProvider.boot(spec(controller.url, holder), { env: REVIEWER_ENV })
    controller.serveSeen = false
    const serveBefore = controller.serveCount

    await computerSandboxProvider.connect!(booted.sandboxId, spec(controller.url, holder), {
      env: REVIEWER_ENV,
    })

    expect(controller.serveCount).toBe(serveBefore + 1)
    const serve = controller.execs
      .map((e) => e.argv[2] ?? "")
      .filter((s) => s.includes("agentproto serve"))
      .at(-1)
    expect(serve).toContain("export AGENTPROTO_JOIN_PROVIDER='computer';")
  })
})
