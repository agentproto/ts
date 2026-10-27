import { describe, it, expect } from "vitest"

describe("isError guard logic", () => {
  it("throws before JSON.parse when isError is true", () => {
    // Inline the guard logic from #call for isolated testing
    function callGuard(res: {
      isError?: boolean
      content: Array<{ type: string; text: string }>
    }) {
      const text = res.content[0]?.text
      if (!text) throw new Error("Empty response")
      if (res.isError) throw new Error(`Tool returned error: ${text}`)
      return JSON.parse(text)
    }

    expect(() =>
      callGuard({
        isError: true,
        content: [{ type: "text", text: "session not found" }],
      }),
    ).toThrow("Tool returned error: session not found")

    expect(() =>
      callGuard({
        isError: false,
        content: [{ type: "text", text: '{"id":"sess_1"}' }],
      }),
    ).not.toThrow()

    expect(
      callGuard({
        content: [{ type: "text", text: '{"id":"sess_1"}' }],
      }),
    ).toEqual({ id: "sess_1" })
  })

  it("throws on empty content", () => {
    function callGuard(res: {
      isError?: boolean
      content: Array<{ type: string; text: string }>
    }) {
      const text = res.content[0]?.text
      if (!text) throw new Error("Empty response")
      if (res.isError) throw new Error(`Tool returned error: ${text}`)
      return JSON.parse(text)
    }

    expect(() =>
      callGuard({
        content: [{ type: "text", text: "" }],
      }),
    ).toThrow("Empty response")
  })
})

describe("HarnessClient.connect headers", () => {
  async function firstRequestHeaders(
    headers: Record<string, string> | undefined,
  ): Promise<Record<string, string | string[] | undefined>> {
    const { createServer } = await import("node:http")
    const { HarnessClient } = await import("../client.js")
    let seen: Record<string, string | string[] | undefined> | undefined
    const server = createServer((req, res) => {
      seen ??= req.headers
      res.statusCode = 400
      res.end("not an mcp server")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const { port } = server.address() as { port: number }
      await HarnessClient.connect({ url: `http://127.0.0.1:${port}/mcp`, headers }).catch(
        () => undefined,
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    if (!seen) throw new Error("the transport never reached the server")
    return seen
  }

  it("sends ConnectHarnessOptions.headers on the MCP transport requests", async () => {
    const seen = await firstRequestHeaders({ authorization: "Bearer test-token" })
    expect(seen.authorization).toBe("Bearer test-token")
  })

  it("sends no authorization header when none is given", async () => {
    const seen = await firstRequestHeaders(undefined)
    expect(seen.authorization).toBeUndefined()
  })
})
