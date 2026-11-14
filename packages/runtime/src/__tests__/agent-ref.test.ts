import { describe, expect, it } from "vitest"
import { join } from "node:path"

import { resolveAgentRef } from "../agent-ref.js"

const CWD = "/workspace"

describe("resolveAgentRef", () => {
  it("rule a: no `agent` copies the other refs through unchanged", () => {
    expect(
      resolveAgentRef(
        { agentId: "helper", agentPath: "/x/AGENT.md", role: "executor" },
        { cwd: CWD, roleNames: ["executor", "supervisor"] },
      ),
    ).toEqual({ ok: true, agentId: "helper", agentPath: "/x/AGENT.md", role: "executor" })
    expect(resolveAgentRef({}, { cwd: CWD, roleNames: [] })).toEqual({ ok: true })
  })

  it("rule b: `agent` together with `agentId` is invalid", () => {
    expect(
      resolveAgentRef({ agent: "helper", agentId: "helper" }, { cwd: CWD, roleNames: [] }),
    ).toEqual({
      ok: false,
      code: "invalid_agent",
      message: 'agent_start: "agent" replaces "agentId" and "agentPath"; pass only one of them.',
    })
  })

  it("rule b: `agent` together with `agentPath` is invalid", () => {
    expect(
      resolveAgentRef(
        { agent: "helper", agentPath: "/x/AGENT.md" },
        { cwd: CWD, roleNames: [] },
      ),
    ).toMatchObject({ ok: false, code: "invalid_agent" })
  })

  it.each(["agents/helper/AGENT.md", "agents\\helper\\AGENT.md", "helper.md"])(
    "rule c: %j is a path, and `role` still passes through",
    agent => {
      expect(
        resolveAgentRef({ agent, role: "executor" }, { cwd: CWD, roleNames: ["executor"] }),
      ).toEqual({ ok: true, agentPath: agent, role: "executor" })
    },
  )

  it("rule d: an AGENT.md under cwd wins, with `role` copied through", () => {
    const manifestExists = (path: string) => path === join(CWD, ".agents", "helper", "AGENT.md")
    expect(
      resolveAgentRef(
        { agent: "helper", role: "supervisor" },
        { cwd: CWD, roleNames: ["executor", "supervisor"], manifestExists },
      ),
    ).toEqual({ ok: true, agentId: "helper", role: "supervisor" })
  })

  it("rule d: an owner-prefixed id resolves under the stripped owner", () => {
    const seen: string[] = []
    const manifestExists = (path: string) => {
      seen.push(path)
      return path === join(CWD, ".agents", "helper", "AGENT.md")
    }
    expect(
      resolveAgentRef(
        { agent: "@acme/helper" },
        { cwd: CWD, roleNames: [], manifestExists },
      ),
    ).toEqual({ ok: true, agentId: "@acme/helper" })
    expect(seen).toContain(join(CWD, ".agents", "helper", "AGENT.md"))
  })

  it("rule d beats rule e: an AGENT.md named like a role wins", () => {
    expect(
      resolveAgentRef(
        { agent: "executor" },
        { cwd: CWD, roleNames: ["executor"], manifestExists: () => true },
      ),
    ).toEqual({ ok: true, agentId: "executor" })
  })

  it("rule e: a known role name becomes `role`", () => {
    expect(
      resolveAgentRef(
        { agent: "executor" },
        { cwd: CWD, roleNames: ["executor", "supervisor"], manifestExists: () => false },
      ),
    ).toEqual({ ok: true, role: "executor" })
  })

  it("rule e: the same role in `agent` and `role` is fine", () => {
    expect(
      resolveAgentRef(
        { agent: "executor", role: "executor" },
        { cwd: CWD, roleNames: ["executor"], manifestExists: () => false },
      ),
    ).toEqual({ ok: true, role: "executor" })
  })

  it("rule e: `agent` and a different `role` is invalid", () => {
    expect(
      resolveAgentRef(
        { agent: "executor", role: "supervisor" },
        { cwd: CWD, roleNames: ["executor", "supervisor"], manifestExists: () => false },
      ),
    ).toEqual({
      ok: false,
      code: "invalid_agent",
      message: 'agent_start: "agent" ("executor") and "role" ("supervisor") name different roles.',
    })
  })

  it("rule f: an unknown name lists the known roles", () => {
    expect(
      resolveAgentRef(
        { agent: "nope" },
        { cwd: CWD, roleNames: ["executor", "supervisor"], manifestExists: () => false },
      ),
    ).toEqual({
      ok: false,
      code: "invalid_agent",
      message:
        'agent_start: no agent "nope": no .agents/<id>/AGENT.md under the working directory and no role of that name (known: executor, supervisor).',
    })
  })

  it("rule f: without a cwd it says `no working directory` instead of the AGENT.md part", () => {
    expect(
      resolveAgentRef({ agent: "nope" }, { cwd: undefined, roleNames: ["executor"] }),
    ).toEqual({
      ok: false,
      code: "invalid_agent",
      message:
        'agent_start: no agent "nope": no working directory and no role of that name (known: executor).',
    })
  })
})
