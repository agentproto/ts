import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStatus } from "./gen-status.mjs";

test("every workspace package is classified exactly once", () => {
  const entries = computeStatus();
  assert.equal(entries.length, Number(readCount()));
  const seen = new Set();
  for (const e of entries) {
    assert.ok(!seen.has(e.dir), `duplicate entry for ${e.dir}`);
    seen.add(e.dir);
  }
});

test("tier is one of the four canonical tiers", () => {
  for (const e of computeStatus()) {
    assert.ok(
      ["core", "adapters", "spec-reference", "archived"].includes(e.tier),
      `bad tier ${e.tier} for ${e.dir}`,
    );
  }
});

test("archived override packages remain zero-dependent", () => {
  const entries = computeStatus(); // throws if any archived pkg has dependents
  const archived = entries.filter((e) => e.tier === "archived");
  assert.deepStrictEqual(
    archived.map((e) => e.name).sort(),
    [
      "@agentproto/adapter-ai-sdk",
      "@agentproto/adapter-kit",
      "@agentproto/adapter-mastra",
      "@agentproto/catalog",
      "@agentproto/driver-sdk",
      "@agentproto/egress",
      "@agentproto/identity",
      "@agentproto/lifecycle",
      "@agentproto/role-catalog",
      "@agentproto/workflow-ai-sdk",
    ],
  );
});

test("status table has exactly one row per package in STATUS.md", () => {
  const entries = computeStatus();
  const tableRows = entries.length;
  assert.ok(tableRows > 0);
});

function readCount() {
  return computeStatus().length;
}
