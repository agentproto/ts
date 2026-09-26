/**
 * Each step's `plan` from fake detect output: which actions are proposed and
 * what is pre-selected, plus what `apply` calls.
 */

import { describe, it, expect } from "vitest"
import { preflightStep } from "./steps/preflight.js"
import { workspaceStep } from "./steps/workspace.js"
import { daemonStep } from "./steps/daemon.js"
import { agentsStep } from "./steps/agents.js"
import { authStep } from "./steps/auth.js"
import { clientsStep } from "./steps/clients.js"
import { skillsStep } from "./steps/skills.js"
import { firstRunStep, pickHarness } from "./steps/first-run.js"
import type { OnboardingStep, SetupAction, StepCheck } from "./types.js"
import { HOME, createFakeContext, createFakeFs, healthyFiles } from "./__fixtures__/fake-context.js"
import { createFakeSetup } from "./__fixtures__/fake-setup.js"

const ctx = createFakeContext()
const none = new Map<string, StepCheck[]>()

async function planOf(step: OnboardingStep, checks: StepCheck[], previous = none): Promise<SetupAction[]> {
  if (!step.plan) throw new Error(`${step.id} has no plan`)
  return step.plan(checks, ctx, previous)
}

function action(actions: SetupAction[], id: string): SetupAction {
  const a = actions.find((x) => x.id === id)
  if (!a) throw new Error(`no action ${id} in ${actions.map((x) => x.id).join(", ")}`)
  return a
}

describe("preflight", () => {
  it("old Node stops the wizard with the fix", () => {
    const reason = preflightStep.stopIf?.([
      { id: "preflight.node", title: "Node.js", status: "broken", detail: "v18 is older", fix: "install Node.js 20.9 or newer" },
    ])
    expect(reason).toContain("install Node.js 20.9 or newer")
  })

  it("an outdated CLI offers the update, default no", async () => {
    const actions = await planOf(preflightStep, [
      { id: "preflight.cli-version", title: "CLI version", status: "warn", fix: "npm i -g @agentproto/cli" },
    ])
    expect(action(actions, "preflight.update-cli").default).toBe(false)
  })

  it("nothing to do on a healthy preflight", async () => {
    expect(await planOf(preflightStep, await preflightStep.detect(ctx))).toEqual([])
    expect(preflightStep.stopIf?.(await preflightStep.detect(ctx))).toBeNull()
  })
})

describe("workspace", () => {
  it("no workspace ⇒ register cwd with a slug from the dir name, default yes", async () => {
    const actions = await planOf(workspaceStep, [{ id: "workspace.registered", title: "", status: "missing" }])
    const a = action(actions, "workspace.register")
    expect(a.default).toBe(true)
    const fake = createFakeSetup(ctx)
    await a.apply(fake.io)
    expect(fake.calls).toEqual([`workspace add ${HOME}/proj/src --slug src`])
  })

  it("cwd outside a workspace is only a warning, nothing proposed", async () => {
    expect(await planOf(workspaceStep, [{ id: "workspace.registered", title: "", status: "ok" }])).toEqual([])
  })
})

describe("daemon", () => {
  it("macOS, not installed ⇒ install then start, default yes", async () => {
    const actions = await planOf(daemonStep, [
      { id: "daemon.health", title: "", status: "missing", fix: "agentproto daemon install" },
      { id: "daemon.service", title: "", status: "warn", fix: "agentproto daemon install" },
    ])
    const a = action(actions, "daemon.install")
    expect(a.default).toBe(true)
    const fake = createFakeSetup(ctx)
    expect((await a.apply(fake.io)).ok).toBe(true)
    expect(fake.calls).toEqual(["daemon install", "daemon start"])
  })

  it("installed but down ⇒ start", async () => {
    const actions = await planOf(daemonStep, [
      { id: "daemon.health", title: "", status: "missing", fix: "agentproto daemon start" },
      { id: "daemon.service", title: "", status: "ok" },
    ])
    expect(actions.map((a) => a.id)).toEqual(["daemon.start"])
  })

  it("stale PATH / version ⇒ restart offered, default no (it stops sessions)", async () => {
    const actions = await planOf(daemonStep, [
      { id: "daemon.health", title: "", status: "warn" },
      { id: "daemon.service", title: "", status: "ok" },
      { id: "daemon.path", title: "", status: "warn" },
    ])
    expect(action(actions, "daemon.restart").default).toBe(false)
  })

  it("linux ⇒ the detached serve fallback", async () => {
    const linux = createFakeContext({ platform: "linux" })
    const actions = await daemonStep.plan?.([{ id: "daemon.health", title: "", status: "missing" }], linux, none)
    const a = action(actions ?? [], "daemon.serve")
    const fake = createFakeSetup(linux)
    expect((await a.apply(fake.io)).ok).toBe(true)
    expect(fake.calls).toEqual(["ensureDaemon"])
  })
})

describe("agents", () => {
  const notInstalled = (working: boolean): StepCheck[] => [
    ...(working ? [{ id: "agents.hermes", title: "Hermes", status: "ok" as const }] : []),
    {
      id: working ? "agents.not-installed" : "agents.none",
      title: "",
      status: working ? ("skipped" as const) : ("missing" as const),
      data: { notInstalled: ["claude-code", "codex", "jcode"], unresolvable: ["jcode"] },
    },
  ]

  it("no harness works ⇒ claude-code pre-selected", async () => {
    const a = action(await planOf(agentsStep, notInstalled(false)), "agents.install")
    expect(a.default).toBe(true)
    expect(a.choices?.filter((c) => c.default).map((c) => c.value)).toEqual(["claude-code"])
    // An unresolvable adapter can't be installed — not offered.
    expect(a.choices?.map((c) => c.value)).toEqual(["claude-code", "codex"])
  })

  it("at least one works ⇒ nothing pre-selected", async () => {
    const a = action(await planOf(agentsStep, notInstalled(true)), "agents.install")
    expect(a.default).toBe(false)
    expect(a.choices?.some((c) => c.default)).toBe(false)
  })

  it("apply installs each selected slug and reports failures", async () => {
    const a = action(await planOf(agentsStep, notInstalled(false)), "agents.install")
    const fake = createFakeSetup(ctx, { codes: { "install codex": 1 } })
    const r = await a.apply(fake.io, ["claude-code", "codex"])
    expect(fake.calls).toEqual(["install claude-code", "install codex"])
    expect(r).toMatchObject({ ok: false, detail: "failed: codex" })
  })
})

describe("auth", () => {
  const pending: StepCheck[] = [
    { id: "auth.profiles", title: "", status: "ok" },
    {
      id: "auth.discover.codex.openai",
      title: "",
      status: "warn",
      data: { origin: "codex", endpoint: "openai", method: "oauth-bearer" },
    },
  ]

  it("discovered credentials: all pre-selected, imported in one pass", async () => {
    const actions = await planOf(authStep, pending)
    const a = action(actions, "auth.import")
    expect(a.choices?.every((c) => c.default)).toBe(true)
    const fake = createFakeSetup(ctx)
    await a.apply(fake.io, ["codex openai"])
    expect(fake.calls).toEqual(["auth profile import codex openai"])
  })

  it("API key is optional (default no), a secret, and goes through `auth provider set`", async () => {
    const a = action(await planOf(authStep, pending), "auth.api-key")
    expect(a).toMatchObject({ default: false, needsSecret: true })
    const fake = createFakeSetup(ctx, { interactive: true, answers: ["openrouter", "sk-or-1"] })
    await a.apply(fake.io)
    expect(fake.calls).toEqual(["auth provider set openrouter sk-or-1"])
  })

  it("reports a models line per installed harness", async () => {
    const fake = createFakeSetup(ctx)
    expect(await authStep.report?.(fake.io)).toEqual(["claude-code: 3/4 models runnable with your keys"])
  })
})

describe("clients", () => {
  it("unregistered clients pre-selected; apply registers exactly those", async () => {
    const a = action(
      await planOf(clientsStep, [
        { id: "clients.cursor", title: "Cursor", status: "ok" },
        { id: "clients.windsurf", title: "Windsurf", status: "warn", fix: "agentproto install-mcp --agent windsurf" },
      ]),
      "clients.register",
    )
    expect(a.choices).toEqual([{ value: "windsurf", label: "Windsurf", default: true }])
    const fake = createFakeSetup(ctx)
    await a.apply(fake.io, ["windsurf"])
    expect(fake.calls).toEqual(["install-mcp --agent windsurf --yes"])
  })

  it("a port mismatch offers --update", async () => {
    const actions = await planOf(clientsStep, [
      { id: "clients.cursor", title: "Cursor", status: "broken", fix: "agentproto install-mcp --update" },
    ])
    expect(actions.map((a) => a.id)).toEqual(["clients.update"])
  })
})

describe("skills", () => {
  it("missing/stale ⇒ install the pack with --force; Claude Code gets /plugin notes", async () => {
    const a = action(
      await planOf(skillsStep, [
        {
          id: "skills.claude-code",
          title: "claude-code",
          status: "warn",
          fix: "agentproto install skill/agentproto-pack --force",
          data: { format: "claude-plugin", path: `${HOME}/.claude/plugins/agentproto` },
        },
      ]),
      "skills.install",
    )
    const fake = createFakeSetup(ctx)
    const r = await a.apply(fake.io)
    expect(fake.calls).toEqual(["install skill/agentproto-pack --force"])
    expect(r.notes?.[0]).toContain(`/plugin marketplace add ${HOME}/.claude/plugins/agentproto`)
  })

  it("up to date ⇒ nothing", async () => {
    expect(await planOf(skillsStep, [{ id: "skills.hermes", title: "hermes", status: "ok" }])).toEqual([])
  })
})

describe("first-run", () => {
  it("picks the most capable usable harness", () => {
    expect(
      pickHarness([
        { id: "agents.hermes", title: "", status: "ok" },
        { id: "agents.codex", title: "", status: "ok" },
        { id: "agents.claude-code", title: "", status: "warn" },
      ]),
    ).toBe("codex")
    expect(pickHarness([{ id: "agents.none", title: "", status: "missing" }])).toBeNull()
  })

  it("not run yet ⇒ offered (default yes); apply streams the reply", async () => {
    const checks = await firstRunStep.detect(ctx)
    expect(checks[0]?.status).toBe("warn")
    const previous = new Map([["agents", [{ id: "agents.claude-code", title: "", status: "ok" as const }]]])
    const a = action(await planOf(firstRunStep, checks, previous), "first-run.session")
    expect(a.default).toBe(true)
    const fake = createFakeSetup(ctx)
    const r = await a.apply(fake.io)
    expect(r.ok).toBe(true)
    expect(fake.calls).toEqual(["firstRun claude-code"])
    expect(fake.logs).toContain("message hello from the agent")
    expect(r.detail).toContain("/apps/@agentproto/sessions-panel/ui")
  })

  it("a passed run in the ledger ⇒ ok, not offered again", async () => {
    const withLedger = createFakeContext({
      fs: createFakeFs({
        ...healthyFiles(),
        [`${HOME}/.agentproto/setup/_onboarding.json`]: JSON.stringify({
          startedAt: "t",
          steps: { "first-run": { status: "ok", at: "2026-09-26T00:00:00.000Z", actions: [] } },
        }),
      }),
    })
    const checks = await firstRunStep.detect(withLedger)
    expect(checks[0]?.status).toBe("ok")
  })
})
