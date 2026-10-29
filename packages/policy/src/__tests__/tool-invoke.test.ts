import { describe, expect, it } from "vitest"
import { evaluateToolInvoke, qualifyToolName, TOOL_INVOKE_ACTION } from "../tool-invoke.js"
import type { Grant } from "../types.js"

const WHO = "operator://pm-katchy"

function toolGrant(scope: string | undefined, effect?: "deny"): Grant {
  return {
    principal: WHO,
    ...(effect ? { effect } : {}),
    actions: [{ action: TOOL_INVOKE_ACTION, ...(scope !== undefined ? { scope } : {}) }],
  }
}

function call(grants: Grant[], tool: string, implementsAction?: string) {
  return evaluateToolInvoke(grants, { principals: [WHO], tool, ...(implementsAction ? { implements: implementsAction } : {}) })
}

describe("qualifyToolName", () => {
  it("turns a legacy bare built-in name into agentproto/<name> and keeps a full name", () => {
    expect(qualifyToolName("cron_create")).toBe("agentproto/cron_create")
    expect(qualifyToolName("pygmalion/cron_create")).toBe("pygmalion/cron_create")
  })
})

describe("evaluateToolInvoke: tool:invoke scopes (AIP-38 §Tool names)", () => {
  it("matches an exact <server>/<name> and no other tool", () => {
    const g = [toolGrant("pygmalion/cron_create")]
    expect(call(g, "pygmalion/cron_create").decision).toBe("allow")
    expect(call(g, "pygmalion/cron_delete").decision).toBe("deny")
    expect(call(g, "other/cron_create").decision).toBe("deny")
  })

  it("matches by <server>/<name> and not by a bare name", () => {
    expect(call([toolGrant("cron_create")], "pygmalion/cron_create").decision).toBe("deny")
    expect(call([toolGrant("cron_create")], "agentproto/cron_create").decision).toBe("deny")
    expect(call([toolGrant("cron_create")], "cron_create").decision).toBe("deny")
    expect(call([toolGrant("cron_*")], "agentproto/cron_create").decision).toBe("deny")
  })

  it("matches nothing for a deny written with a bare name", () => {
    expect(call([toolGrant(undefined), toolGrant("cron_create", "deny")], "agentproto/cron_create").decision).toBe("allow")
  })

  it("does not let <server>/* reach another server", () => {
    const g = [toolGrant("agentproto/*")]
    expect(call(g, "agentproto/cron_create").decision).toBe("allow")
    expect(call(g, "agentproto-extra/cron_create").decision).toBe("deny")
    expect(call(g, "pygmalion/cron_create").decision).toBe("deny")
    const d = [toolGrant(undefined), toolGrant("agentproto/*", "deny")]
    expect(call(d, "pygmalion/cron_create").decision).toBe("allow")
    expect(call(d, "agentproto/cron_create").decision).toBe("deny")
  })

  it("supports a <server>/<prefix>* family and a lone * (every tool)", () => {
    const g = [toolGrant("pygmalion/cron_*")]
    expect(call(g, "pygmalion/cron_create").decision).toBe("allow")
    expect(call(g, "pygmalion/session_list").decision).toBe("deny")
    expect(call([toolGrant("*")], "x/y").decision).toBe("allow")
  })

  it("covers every tool when the grant has no scope", () => {
    expect(call([toolGrant(undefined)], "x/y").decision).toBe("allow")
    expect(call([toolGrant(undefined), toolGrant(undefined, "deny")], "x/y").decision).toBe("deny")
  })

  it("qualifies a legacy bare built-in name before forming the requested scope", () => {
    expect(call([toolGrant("agentproto/cron_create")], "cron_create").decision).toBe("allow")
    expect(call([toolGrant(undefined), toolGrant("agentproto/cron_create", "deny")], "cron_create").decision).toBe("deny")
  })

  it("reads the library entry form of the action", () => {
    const g: Grant = { principal: WHO, actions: [{ action: "@agentik/actions/standard/tool-invoke", scope: "a/b" }] }
    expect(call([g], "a/b").decision).toBe("allow")
  })

  it("fails closed on a selector scope: an allow does not match, a deny does", () => {
    expect(call([toolGrant("selector:safe-tools")], "a/b").decision).toBe("deny")
    expect(call([toolGrant(undefined), toolGrant("selector:safe-tools", "deny")], "a/b").decision).toBe("deny")
  })

  it("does not read label: or workspace: as typed forms for tool:invoke", () => {
    expect(call([toolGrant("label:ops")], "a/b").decision).toBe("deny")
    expect(call([toolGrant(undefined), toolGrant("label:ops", "deny")], "a/b").decision).toBe("allow")
  })
})

describe("evaluateToolInvoke: implements (AIP-39 §tool:invoke Evaluation)", () => {
  const commit: Grant = { principal: WHO, actions: [{ action: "storage:commit" }] }
  const denyCommit: Grant = { ...commit, effect: "deny" }

  it("refuses a tool when a deny targets its implemented action", () => {
    const grants = [toolGrant("katchy/*"), denyCommit]
    expect(call(grants, "katchy/commit", "storage:commit")).toMatchObject({ decision: "deny", reason: "explicit-deny" })
  })

  it("refuses when a deny targets tool:invoke even though the implemented action is granted", () => {
    const grants = [commit, toolGrant("katchy/commit", "deny")]
    expect(call(grants, "katchy/commit", "storage:commit").decision).toBe("deny")
  })

  it("admits when an allow on either name matches and no deny does", () => {
    expect(call([commit], "katchy/commit", "storage:commit").decision).toBe("allow")
    expect(call([toolGrant("katchy/commit")], "katchy/commit", "storage:commit").decision).toBe("allow")
    expect(call([], "katchy/commit", "storage:commit").decision).toBe("deny")
  })

  it("leaves a tool without implements to tool:invoke alone", () => {
    expect(call([denyCommit, toolGrant("katchy/*")], "katchy/commit").decision).toBe("allow")
  })

  it("applies a deny from any composed policy", () => {
    const decision = evaluateToolInvoke(
      [{ default: "deny", grants: [commit] }, { default: "deny", grants: [toolGrant(undefined, "deny")] }],
      { principals: [WHO], tool: "katchy/commit", implements: "storage:commit" },
    )
    expect(decision.decision).toBe("deny")
  })
})
