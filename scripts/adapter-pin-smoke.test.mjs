import assert from "node:assert/strict"
import { test } from "node:test"
import {
  EXPECTED,
  PROMPT,
  RECIPES,
  diffPins,
  evaluateReply,
  pickFreeModel,
  resolveRecipe,
} from "./adapter-pin-smoke.mjs"

const block = (id, input, output, status = "active") =>
  `${id}\n${JSON.stringify({ id: id.split("/")[1], status, capabilities: { output: { text: true } }, cost: { input, output, cache: { read: 0, write: 0 } } }, null, 2)}\n`

test("the prompt never contains the expected token", () => {
  assert.ok(!PROMPT.includes(EXPECTED))
  assert.ok(PROMPT.includes([...EXPECTED].reverse().join("")))
})

test("a reply is proven only when it contains the token", () => {
  assert.equal(evaluateReply("PONG").ok, true)
  assert.equal(evaluateReply("\nPONG\n").ok, true)
  assert.equal(evaluateReply("").ok, false)
  assert.equal(evaluateReply("   \n").ok, false)
  assert.equal(evaluateReply("GNOP").ok, false)
})

test("recipes without a credential skip loudly instead of passing", () => {
  const skipped = resolveRecipe("claude-code", {})
  assert.equal(skipped.action, "skip")
  assert.match(skipped.reason, /no credential/)
  assert.match(skipped.reason, /ANTHROPIC_API_KEY/)
  assert.equal(resolveRecipe("claude-code", { ANTHROPIC_API_KEY: "x" }).action, "run")
  assert.equal(resolveRecipe("gemini", { GOOGLE_API_KEY: "x" }).action, "run")
  assert.equal(resolveRecipe("codex", { ANTHROPIC_API_KEY: "x" }).action, "skip")
})

test("the free route needs no credential, unknown adapters have no recipe", () => {
  assert.deepEqual(resolveRecipe("opencode", {}), { action: "run", freeRoute: true })
  assert.equal(resolveRecipe("not-an-adapter", { ANTHROPIC_API_KEY: "x" }).action, "skip")
  assert.ok(RECIPES.opencode.freeRoute)
})

test("picks a zero-priced model from verbose model output, never a paid one", () => {
  const out = [
    block("prov/paid-a", 1, 2),
    block("prov/zeta-free", 0, 0),
    block("prov/alpha-free", 0, 0),
    block("prov/aaa-half", 0, 3),
    block("prov/old-free", 0, 0, "deprecated"),
  ].join("")
  assert.equal(pickFreeModel(out), "prov/alpha-free")
})

test("returns null when no model is free or the output is garbage", () => {
  assert.equal(pickFreeModel(block("prov/paid", 1, 1)), null)
  assert.equal(pickFreeModel(""), null)
  assert.equal(pickFreeModel("prov/x\n{ not json\n}\n"), null)
})

test("diffPins lists only adapters whose pin changed", () => {
  const base = [
    { adapter: "a", package: "pa", pinned: "1.0.0" },
    { adapter: "b", package: "pb", pinned: "2.0.0" },
    { adapter: "c", package: "pc", pinned: "3.0.0" },
  ]
  const head = [
    { adapter: "a", package: "pa", pinned: "1.1.0" },
    { adapter: "b", package: "pb", pinned: "2.0.0" },
    { adapter: "c", package: "pc", pinned: "3.0.1" },
    { adapter: "new", package: "pn", pinned: "1.0.0" },
  ]
  assert.deepEqual(diffPins(base, head), [
    { adapter: "a", changes: [{ package: "pa", from: "1.0.0", to: "1.1.0" }] },
    { adapter: "c", changes: [{ package: "pc", from: "3.0.0", to: "3.0.1" }] },
  ])
  assert.deepEqual(diffPins(head, head), [])
})
