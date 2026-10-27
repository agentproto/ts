import { describe, it, expect } from "vitest"
import { toFileBasedMcpServers } from "../mcp-servers.js"
import type { AcpMcpServer } from "../types.js"

/**
 * The mastracode print arm writes these entries into `.mastracode/mcp.json`
 * as its highest-precedence MCP config. An http entry's `headers` carry the
 * mount's credentials — dropping them here silently turns a credentialed
 * mount into an anonymous one (same failure class as the HTTP
 * `/sessions/agent` body parse fixed alongside this).
 */
describe("toFileBasedMcpServers", () => {
  it("http entries carry their headers into the file-based config", () => {
    const servers: AcpMcpServer[] = [
      {
        name: "room",
        transport: "http",
        ref: "http://example.test/mcp/room",
        headers: { Authorization: "Bearer t" },
      },
    ]
    expect(toFileBasedMcpServers(servers)).toEqual({
      room: { url: "http://example.test/mcp/room", headers: { Authorization: "Bearer t" } },
    })
  })

  it("http entries without headers stay headerless; stdio stays command-shaped", () => {
    const servers: AcpMcpServer[] = [
      { name: "bare", transport: "http", ref: "http://example.test/mcp" },
      { name: "tool", transport: "stdio", ref: "some-bin" },
    ]
    expect(toFileBasedMcpServers(servers)).toEqual({
      bare: { url: "http://example.test/mcp" },
      tool: { command: "some-bin" },
    })
  })

  it("stdio entries carry their args/env into the file-based config", () => {
    const servers: AcpMcpServer[] = [
      {
        name: "tool",
        transport: "stdio",
        ref: "some-bin",
        args: ["--flag", "value"],
        env: { TOKEN: "secret" },
      },
    ]
    expect(toFileBasedMcpServers(servers)).toEqual({
      tool: { command: "some-bin", args: ["--flag", "value"], env: { TOKEN: "secret" } },
    })
  })

  it("stdio entries without args/env stay minimal (no undefined keys)", () => {
    const servers: AcpMcpServer[] = [{ name: "tool", transport: "stdio", ref: "some-bin" }]
    expect(toFileBasedMcpServers(servers)).toEqual({
      tool: { command: "some-bin" },
    })
  })
})
