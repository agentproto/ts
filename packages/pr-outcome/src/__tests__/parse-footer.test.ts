import { test } from "vitest"
import assert from "node:assert/strict"
import { buildFooter } from "@agentproto/runtime/pr-provenance"
import { parseFooter } from "../parse-footer.js"

const shapes: Array<{ name: string; input: Parameters<typeof buildFooter>[0] }> = [
  {
    name: "full local shape",
    input: {
      prov: {
        sessionId: "sess_abc123",
        label: "fix-foo",
        adapter: "claude-code",
        model: "kimi-k2.7-code",
        authProfile: "pro",
        sandboxId: "sbx_1",
        parentSessionId: "sess_parent",
        tokensIn: 12345,
        tokensOut: 67890,
        costUsd: 0.1234,
        source: "local",
        host: "jeremy-mac-studio",
        cwd: "/home/user/ts/local-pr-provenance-audit",
        workspaceSlug: "ws",
      },
      authMode: "subscription",
      sha: "abcdef1234567890",
      kind: "PR",
    },
  },
  {
    name: "ci run shape",
    input: {
      prov: {
        sessionId: "sess_ci",
        adapter: "opencode",
        tokensIn: 12300,
        tokensOut: 800,
        costUsd: 0.0456,
      },
      authMode: "api-key",
      runId: "123456789",
      runUrl: "https://github.com/agentproto/ts/actions/runs/123456789",
      sha: "sha123",
      kind: "PR",
    },
  },
  {
    name: "legacy fallback shape",
    input: { prov: {}, authMode: "api-key", sha: "abc", kind: "review" },
  },
  {
    name: "minimal session only",
    input: { prov: { sessionId: "sess_min" } },
  },
]

test("parseFooter round-trips buildFooter output", () => {
  for (const shape of shapes) {
    const footer = buildFooter(shape.input)
    const body = `Body text.\n\n---\n${footer}`
    const p = parseFooter(body)
    assert.ok(p, `parse failed for shape ${shape.name}`)
    const exp = shape.input.prov ?? {}
    assert.equal(p.kind, shape.input.kind ?? "review", shape.name)
    assert.equal(p.sessionId, exp.sessionId, shape.name)
    assert.equal(p.label, exp.label, shape.name)
    assert.equal(p.adapter, exp.adapter, shape.name)
    assert.equal(p.authMode, shape.input.authMode, shape.name)
    assert.equal(p.authProfile, exp.authProfile, shape.name)
    assert.equal(p.model, exp.model, shape.name)
    assert.equal(p.sandboxId, exp.sandboxId, shape.name)
    assert.equal(p.parentSessionId, exp.parentSessionId, shape.name)
    assert.equal(p.sha, shape.input.sha, shape.name)
    assert.equal(p.runId ?? "", shape.input.runId ?? "", shape.name)
    assert.equal(p.runUrl ?? "", shape.input.runUrl ?? "", shape.name)
    // fmtTokens keeps one decimal of thousands: 12345 -> "12.3k" -> 12300
    const rendered = (n: number): number => (n >= 1000 ? Math.round(n / 100) * 100 : n)
    if (typeof exp.tokensIn === "number") assert.equal(p.tokensIn, rendered(exp.tokensIn), shape.name)
    if (typeof exp.tokensOut === "number") assert.equal(p.tokensOut, rendered(exp.tokensOut), shape.name)
    if (typeof exp.costUsd === "number") assert.ok(Math.abs((p.costUsd ?? 0) - exp.costUsd) < 1e-9, shape.name)
    if (exp.source && exp.source !== "adapter") assert.equal(p.costSource, exp.source, shape.name)
    assert.equal(p.host ?? "", exp.host ?? "", shape.name)
  }
})

test("round-trip edge: exact small token counts", () => {
  const footer = buildFooter({ prov: { sessionId: "s", tokensIn: 800, tokensOut: 123 } })
  const p = parseFooter(footer)
  assert.ok(p)
  assert.equal(p.tokensIn, 800)
  assert.equal(p.tokensOut, 123)
})

test("k-tokens round to thousands (documented rounding)", () => {
  // 12345 renders as "12.3k" -> parsed as 12300, not 12345
  const footer = buildFooter({ prov: { sessionId: "s", tokensIn: 12345 } })
  assert.ok(footer.includes("12.3k in"))
  const p = parseFooter(footer)
  assert.equal(p?.tokensIn, 12300)
})

test("prose mention without rendered footer is a legacy PR", () => {
  const body = "We should mention @agentproto-bot in docs someday."
  assert.equal(parseFooter(body), undefined)
})

test("empty body is a legacy PR", () => {
  assert.equal(parseFooter(""), undefined)
})
