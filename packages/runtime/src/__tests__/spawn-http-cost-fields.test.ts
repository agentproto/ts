/**
 * Parity guard for the HTTP twin of the MCP `agent_start` spend-cap fields:
 * `buildSpawnSessionHttpArgs` must forward `maxCostUsd` (the hard turn-end
 * kill) and `costBudget` (the windowed governance cap that never kills) onto
 * the spawn input, or `sessions start --max-cost-usd / --cost-budget` would
 * be silently dropped at `POST /sessions/agent` — the exact silent-drop bug
 * class the #158 `orchestrator`/`mcpServers` fix guards against.
 */

import { describe, it, expect } from "vitest"
import { buildSpawnSessionHttpArgs } from "../http-server.js"

describe("buildSpawnSessionHttpArgs — maxCostUsd / costBudget forwarding", () => {
  it("forwards a numeric maxCostUsd", () => {
    const args = buildSpawnSessionHttpArgs({ adapter: "x", maxCostUsd: 5 }, "x")
    expect(args.maxCostUsd).toBe(5)
  })

  it("tolerates a numeric-string maxCostUsd and drops a malformed one", () => {
    expect(buildSpawnSessionHttpArgs({ maxCostUsd: "7" }, "x").maxCostUsd).toBe(7)
    expect(buildSpawnSessionHttpArgs({ maxCostUsd: "abc" }, "x").maxCostUsd).toBeUndefined()
    expect(buildSpawnSessionHttpArgs({ maxCostUsd: -3 }, "x").maxCostUsd).toBeUndefined()
    expect(buildSpawnSessionHttpArgs({ maxCostUsd: 0 }, "x").maxCostUsd).toBeUndefined()
  })

  it("forwards a well-formed costBudget object", () => {
    const args = buildSpawnSessionHttpArgs(
      { costBudget: { maxCostUsd: 20, window: "5h", scope: "profile" } },
      "x",
    )
    expect(args.costBudget).toEqual({ maxCostUsd: 20, window: "5h", scope: "profile" })
  })

  it("tolerates a JSON-stringified costBudget and drops a malformed one", () => {
    const parsed = buildSpawnSessionHttpArgs(
      { costBudget: '{"maxCostUsd":20,"window":"5h","scope":"session"}' },
      "x",
    )
    expect(parsed.costBudget).toEqual({ maxCostUsd: 20, window: "5h", scope: "session" })

    // scope missing entirely → the field is dropped rather than guessed
    const missingScope = buildSpawnSessionHttpArgs(
      { costBudget: { maxCostUsd: 20, window: "5h" } },
      "x",
    )
    expect(missingScope.costBudget).toBeUndefined()

    // bad scope → dropped, never a partial budget that silently misbehaves
    const badScope = buildSpawnSessionHttpArgs(
      { costBudget: { maxCostUsd: 20, window: "5h", scope: "galaxy" } },
      "x",
    )
    expect(badScope.costBudget).toBeUndefined()
  })

  it("omits both fields when the body carries neither", () => {
    const args = buildSpawnSessionHttpArgs({}, "x")
    expect(args.maxCostUsd).toBeUndefined()
    expect(args.costBudget).toBeUndefined()
  })
})