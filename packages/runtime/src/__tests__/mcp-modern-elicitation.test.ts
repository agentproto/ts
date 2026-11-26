import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PendingPermission } from "../sessions.js"
import {
  buildPermissionElicitation,
  canonicalArgsHash,
  clientSupportsElicitation,
  createMrtrStateStore,
  isSecretField,
  validateFlatFormSchema,
  type MrtrEntityKind,
} from "../mcp-modern/index.js"

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentproto-mrtr-unit-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("MRTR state store (signed tokens, HMAC persistence, durability)", () => {
  it("mints, verifies, and single-use consumes a token; persists HMAC key with mode 0600", () => {
    const dir = makeTempDir()
    const store = createMrtrStateStore({ dir })
    const keyMode = statSync(join(dir, "hmac-key.json")).mode & 0o777
    expect(keyMode).toBe(0o600)

    const argsHash = canonicalArgsHash({ name: "permissions_list", arguments: { sessionId: "sess_1" } })
    const token = store.mint({
      kind: "permission",
      entityId: "perm-1",
      requestKey: "perm_perm-1",
      callerSessionId: "sess_parent",
      tool: "permissions_list",
      argsHash,
    })

    const ok = store.verifyAndConsume(token, {
      tool: "permissions_list",
      argsHash,
      callerSessionId: "sess_parent",
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.state.entityId).toBe("perm-1")
      expect(ok.state.kind).toBe("permission")
    }

    // Replaying the same nonce is refused.
    const replay = store.verifyAndConsume(token, {
      tool: "permissions_list",
      argsHash,
      callerSessionId: "sess_parent",
    })
    expect(replay).toMatchObject({ ok: false, reason: "replayed" })
  })

  it("refuses a correctly signed token whose kind is not a known surface", () => {
    const store = createMrtrStateStore({ dir: makeTempDir() })
    const argsHash = canonicalArgsHash({ name: "approval_get", arguments: { id: "apr_1" } })
    const forged = store.mint({ kind: "forged" as MrtrEntityKind, entityId: "apr_1", tool: "approval_get", argsHash })
    expect(store.verifyAndConsume(forged, { tool: "approval_get", argsHash })).toMatchObject({ ok: false, reason: "unsupported_kind" })
  })

  it("supports HMAC key rotation while keeping tokens signed by the previous key valid", () => {
    const dir = makeTempDir()
    const store = createMrtrStateStore({ dir })
    const argsHash = canonicalArgsHash({ name: "permissions_list", arguments: {} })
    const beforeRotation = store.mint({
      kind: "approval",
      entityId: "apr_1",
      tool: "approval_get",
      argsHash,
    })

    store.rotateKey()
    const afterRotation = store.mint({
      kind: "approval",
      entityId: "apr_2",
      tool: "approval_get",
      argsHash,
    })

    expect(store.verifyAndConsume(beforeRotation, { tool: "approval_get", argsHash }).ok).toBe(true)
    expect(store.verifyAndConsume(afterRotation, { tool: "approval_get", argsHash }).ok).toBe(true)
  })

  it("rejects single-byte tampering, expiry, and tool/args/caller mismatches", () => {
    let nowMs = 1_700_000_000_000
    const dir = makeTempDir()
    const store = createMrtrStateStore({ dir, now: () => nowMs, defaultTtlMs: 30_000 })
    const argsHash = canonicalArgsHash({ name: "permissions_list", arguments: { sessionId: "s1" } })

    const token = store.mint({
      kind: "permission",
      entityId: "perm-1",
      callerSessionId: "sess_a",
      tool: "permissions_list",
      argsHash,
    })

    // Tamper one character in the signature.
    const last = token.slice(-1)
    const tampered = token.slice(0, -1) + (last === "A" ? "B" : "A")
    expect(store.verifyAndConsume(tampered, { tool: "permissions_list", argsHash, callerSessionId: "sess_a" })).toMatchObject({
      ok: false,
      reason: "invalid_signature",
    })

    // Mismatched tool, args, or caller.
    expect(store.verifyAndConsume(token, { tool: "other_tool", argsHash, callerSessionId: "sess_a" })).toMatchObject({
      ok: false,
      reason: "mismatch",
    })
    expect(
      store.verifyAndConsume(token, {
        tool: "permissions_list",
        argsHash: canonicalArgsHash({ name: "permissions_list", arguments: { sessionId: "s2" } }),
        callerSessionId: "sess_a",
      }),
    ).toMatchObject({ ok: false, reason: "mismatch" })
    expect(store.verifyAndConsume(token, { tool: "permissions_list", argsHash, callerSessionId: "sess_b" })).toMatchObject({
      ok: false,
      reason: "mismatch",
    })

    // Expiry.
    nowMs += 31_000
    expect(store.verifyAndConsume(token, { tool: "permissions_list", argsHash, callerSessionId: "sess_a" })).toMatchObject({
      ok: false,
      reason: "expired",
    })
  })

  it("fails volatile permission/question tokens with input_unavailable across restart while keeping durable approval/run-input tokens valid", () => {
    const dir = makeTempDir()
    const argsHash = canonicalArgsHash({ name: "probe", arguments: {} })

    const beforeRestart = createMrtrStateStore({ dir, bootId: "boot-1" })
    const permToken = beforeRestart.mint({ kind: "permission", entityId: "p1", tool: "probe", argsHash })
    const questionToken = beforeRestart.mint({ kind: "question", entityId: "q1", tool: "probe", argsHash })
    const approvalToken = beforeRestart.mint({ kind: "approval", entityId: "a1", tool: "probe", argsHash })
    const runToken = beforeRestart.mint({ kind: "run-input", entityId: "r1", tool: "probe", argsHash })

    // Simulate daemon restart on the same persisted directory.
    const afterRestart = createMrtrStateStore({ dir, bootId: "boot-2" })
    expect(afterRestart.verifyAndConsume(permToken, { tool: "probe", argsHash })).toMatchObject({
      ok: false,
      reason: "input_unavailable",
    })
    expect(afterRestart.verifyAndConsume(questionToken, { tool: "probe", argsHash })).toMatchObject({
      ok: false,
      reason: "input_unavailable",
    })
    expect(afterRestart.verifyAndConsume(approvalToken, { tool: "probe", argsHash }).ok).toBe(true)
    expect(afterRestart.verifyAndConsume(runToken, { tool: "probe", argsHash }).ok).toBe(true)

    // Consumed durable nonce stays rejected across a third restart.
    const thirdBoot = createMrtrStateStore({ dir, bootId: "boot-3" })
    expect(thirdBoot.verifyAndConsume(approvalToken, { tool: "probe", argsHash })).toMatchObject({
      ok: false,
      reason: "replayed",
    })
  })
})

describe("elicitation schema builder, flat schema guard, and secret guard", () => {
  it("parses clientCapabilities.elicitation per 2026-07-28 rules", () => {
    expect(clientSupportsElicitation(undefined, "form")).toBe(false)
    expect(clientSupportsElicitation({}, "form")).toBe(false)
    expect(clientSupportsElicitation({ elicitation: {} }, "form")).toBe(true)
    expect(clientSupportsElicitation({ elicitation: {} }, "url")).toBe(false)
    expect(clientSupportsElicitation({ elicitation: { form: {}, url: {} } }, "form")).toBe(true)
    expect(clientSupportsElicitation({ elicitation: { form: {}, url: {} } }, "url")).toBe(true)
    expect(clientSupportsElicitation({ elicitation: { url: {} } }, "form")).toBe(false)
    expect(clientSupportsElicitation({ elicitation: { url: {} } }, "url")).toBe(true)
  })

  it("rejects non-flat schemas and secret fields in form mode", () => {
    expect(
      validateFlatFormSchema({
        type: "object",
        properties: { nested: { type: "object", properties: { a: { type: "string" } } } },
      }).ok,
    ).toBe(false)
    expect(
      validateFlatFormSchema({
        type: "object",
        properties: { list: { type: "array", items: { type: "string" } } },
      }).ok,
    ).toBe(false)
    expect(
      validateFlatFormSchema({
        type: "object",
        properties: { api_key: { type: "string" } },
      }).ok,
    ).toBe(false)
    expect(
      validateFlatFormSchema({
        type: "object",
        properties: { value: { type: "string", description: "Enter your password" } },
      }).ok,
    ).toBe(false)
    expect(isSecretField("access_token")).toBe(true)
    expect(isSecretField("username", "Your GitHub handle")).toBe(false)
  })

  it("builds a form schema from multi-field question.fields (single, multi, text, boolean, number)", () => {
    const pending: PendingPermission = {
      id: "q-1",
      sessionId: "sess_child",
      toolCallId: "q-1",
      text: "Deployment configuration",
      options: [],
      requestedAt: new Date().toISOString(),
      request: "question",
      question: {
        prompt: "Choose deployment settings",
        choices: [],
        allowFreeText: false,
        fields: [
          {
            id: "env",
            input: "single",
            prompt: "Target environment",
            required: true,
            choices: [
              { value: "staging", label: "Staging" },
              { value: "prod", label: "Production" },
            ],
          },
          {
            id: "regions",
            input: "multi",
            prompt: "Regions",
            choices: [
              { value: "eu", label: "Europe" },
              { value: "us", label: "US" },
            ],
          },
          { id: "note", input: "text", prompt: "Release note" },
          { id: "dryRun", input: "boolean", prompt: "Dry run?" },
          { id: "replicas", input: "number", prompt: "Replica count" },
        ],
      },
    }

    const built = buildPermissionElicitation(pending)
    expect(built).not.toBeNull()
    expect(built?.kind).toBe("question")
    expect(built?.request.params.mode).toBe("form")
    expect(built?.request.params.requestedSchema.required).toEqual(["env"])
    expect(built?.request.params.requestedSchema.properties.env?.oneOf).toEqual([
      { const: "staging", title: "Staging" },
      { const: "prod", title: "Production" },
    ])
    expect(built?.request.params.requestedSchema.properties.regions?.type).toBe("array")
    expect(built?.request.params.requestedSchema.properties.note?.type).toBe("string")
    expect(built?.request.params.requestedSchema.properties.dryRun?.type).toBe("boolean")
    expect(built?.request.params.requestedSchema.properties.replicas?.type).toBe("number")
  })

  it("refuses to build a form elicitation when a question field asks for a secret", () => {
    const pending: PendingPermission = {
      id: "q-secret",
      sessionId: "sess_child",
      toolCallId: "q-secret",
      text: "Credentials",
      options: [],
      requestedAt: new Date().toISOString(),
      request: "question",
      question: {
        prompt: "Provide credentials",
        choices: [],
        allowFreeText: false,
        fields: [{ id: "api_key", input: "text", prompt: "Your API key", required: true }],
      },
    }
    expect(buildPermissionElicitation(pending)).toBeNull()
  })

  it("includes scope enum only when allow_always is offered", () => {
    const withAlways: PendingPermission = {
      id: "p-always",
      sessionId: "sess_1",
      toolCallId: "p-always",
      toolName: "Write",
      text: "Allow Write?",
      options: [
        { optionId: "o1", name: "Allow once", kind: "allow_once" },
        { optionId: "o2", name: "Allow always", kind: "allow_always" },
        { optionId: "o3", name: "Reject", kind: "reject_once" },
      ],
      requestedAt: new Date().toISOString(),
    }
    const onceOnly: PendingPermission = {
      ...withAlways,
      id: "p-once",
      options: [
        { optionId: "o1", name: "Allow once", kind: "allow_once" },
        { optionId: "o3", name: "Reject", kind: "reject_once" },
      ],
    }

    expect(buildPermissionElicitation(withAlways)?.request.params.requestedSchema.properties).toHaveProperty("scope")
    expect(buildPermissionElicitation(onceOnly)?.request.params.requestedSchema.properties).not.toHaveProperty("scope")
  })
})
