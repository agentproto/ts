/**
 * Loader tests for `~/.agentproto/routes.json` — the operator-configurable
 * custom route extension point.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearCustomRoutes, resolveCustomRoute } from "@agentproto/model-catalog/route-identity"
import { registerBuiltinRoutes } from "../builtin-routes.js"

let tmpDir: string

const mockHomedir = vi.fn()
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os")
  return {
    ...actual,
    homedir: () => mockHomedir(),
  }
})

describe("loadOperatorRoutes", async () => {
  const { loadOperatorRoutes } = await import("../routes-config.js")

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agentproto-routes-"))
    mockHomedir.mockReturnValue(tmpDir)
  })

  afterEach(() => {
    mockHomedir.mockReset()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns no routes when the file is missing", async () => {
    const result = await loadOperatorRoutes()
    expect(result.routes).toEqual({})
    expect(result.errors).toEqual([])
  })

  it("loads valid routes", async () => {
    const routesDir = join(tmpDir, ".agentproto")
    mkdirSync(routesDir)
    writeFileSync(
      join(routesDir, "routes.json"),
      JSON.stringify({
        "my-proxy": {
          label: "My Proxy",
          flavor: "anthropic",
          baseUrl: "https://proxy.example.com",
          authEnv: "MY_PROXY_API_KEY",
        },
      }),
    )
    const result = await loadOperatorRoutes()
    expect(Object.keys(result.routes)).toEqual(["my-proxy"])
    expect(result.errors).toEqual([])
  })

  it("reports validation errors with route id", async () => {
    const routesDir = join(tmpDir, ".agentproto")
    mkdirSync(routesDir)
    writeFileSync(
      join(routesDir, "routes.json"),
      JSON.stringify({
        "bad-route": { flavor: 123 },
      }),
    )
    const result = await loadOperatorRoutes()
    expect(result.routes).toEqual({})
    expect(result.errors.some(e => e.includes("bad-route") && e.includes("expected string"))).toBe(true)
  })

  it("rejects the whole file when a literal secret is detected", async () => {
    const routesDir = join(tmpDir, ".agentproto")
    mkdirSync(routesDir)
    writeFileSync(
      join(routesDir, "routes.json"),
      JSON.stringify({
        leaked: {
          flavor: "anthropic",
          authEnv: "X_API_KEY",
          baseUrl: "https://x.ai",
          extra: "sk-abc123",
        },
      }),
    )
    const result = await loadOperatorRoutes()
    expect(result.routes).toEqual({})
    expect(result.errors.some(e => e.includes("literal secret key"))).toBe(true)
  })
})

describe("registerBuiltinRoutes — operator override", () => {
  beforeEach(() => {
    clearCustomRoutes()
  })

  it("built-in llm-endpoint route wins over operator config if registered first", async () => {
    await registerBuiltinRoutes()
    const route = resolveCustomRoute("llm-endpoint")
    expect(route).toBeDefined()
    expect(route?.baseUrl).toBe("http://localhost:18090")
  })
})
