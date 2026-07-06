/**
 * Unit tests for spawn-time secret exposure resolution.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer, type Server } from "node:http"
import type { AcpMcpServer } from "@agentproto/acp"
import type { McpHeaderResolver } from "@agentproto/secrets/exposure"
import {
  resolveEnvExposure,
  resolveMcpServersWithSecrets,
  resolveSpawnExposures,
} from "../spawn-exposures.js"

interface TestUpstream {
  url: string
  lastHeaders: Record<string, string | string[] | undefined>
  stop(): Promise<void>
}

function createTestUpstream(): Promise<TestUpstream> {
  let lastHeaders: Record<string, string | string[] | undefined> = {}
  const server = createServer((req, res) => {
    lastHeaders = { ...req.headers }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
  })

  return new Promise<TestUpstream>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port =
        address && typeof address === "object" && "port" in address
          ? address.port
          : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        get lastHeaders() {
          return lastHeaders
        },
        stop: () =>
          new Promise<void>(resolveStop => server.close(() => resolveStop())),
      })
    })
  })
}

function fakeBroker(headers: Record<string, string>): McpHeaderResolver {
  return {
    async resolveHeaders() {
      return headers
    },
  }
}

function failingBroker(message: string): McpHeaderResolver {
  return {
    async resolveHeaders() {
      throw new Error(message)
    },
  }
}

describe("resolveEnvExposure", () => {
  it("resolves via the provided resolver", async () => {
    const result = await resolveEnvExposure(
      { kind: "env", name: "AGENTPUSH_API_KEY", field: "agentpush" },
      field => (field === "agentpush" ? "secret-value" : undefined),
    )
    expect(result).toEqual({ name: "AGENTPUSH_API_KEY", value: "secret-value" })
  })

  it("throws when the resolver returns undefined", async () => {
    await expect(
      resolveEnvExposure(
        { kind: "env", name: "MISSING", field: "missing" },
        () => undefined,
      ),
    ).rejects.toThrow('env exposure "MISSING": could not resolve field "missing"')
  })

  it("rejects values containing CR", async () => {
    await expect(
      resolveEnvExposure(
        { kind: "env", name: "BAD", field: "bad" },
        () => "evil\r",
      ),
    ).rejects.toThrow()
  })

  it("rejects values containing LF", async () => {
    await expect(
      resolveEnvExposure(
        { kind: "env", name: "BAD", field: "bad" },
        () => "evil\n",
      ),
    ).rejects.toThrow()
  })

  it("rejects values containing NUL", async () => {
    await expect(
      resolveEnvExposure(
        { kind: "env", name: "BAD", field: "bad" },
        () => "evil\0",
      ),
    ).rejects.toThrow()
  })

  it("rejects empty values", async () => {
    await expect(
      resolveEnvExposure(
        { kind: "env", name: "BAD", field: "bad" },
        () => "",
      ),
    ).rejects.toThrow()
  })
})

describe("resolveMcpServersWithSecrets", () => {
  it("passes through entries without credentialPath unchanged", async () => {
    const entries: AcpMcpServer[] = [
      { name: "fs", transport: "stdio" },
      { name: "gateway", transport: "http", ref: "http://127.0.0.1:18790/mcp" },
    ]
    const result = await resolveMcpServersWithSecrets({
      entries,
      broker: failingBroker("should not be called"),
    })
    expect(result.entries).toEqual(entries)
    await result.close()
  })

  it("rewrites a credentialPath entry to a local proxy that forwards the auth header", async () => {
    const upstream = await createTestUpstream()
    try {
      const result = await resolveMcpServersWithSecrets({
        entries: [
          {
            name: "agentpush",
            transport: "http",
            ref: upstream.url,
            credentialPath: "agentpush/api",
          },
        ],
        broker: fakeBroker({ Authorization: "Bearer ap_token_123" }),
      })

      expect(result.entries).toHaveLength(1)
      const rewritten = result.entries[0]
      expect(rewritten?.name).toBe("agentpush")
      expect(rewritten?.transport).toBe("http")
      expect(rewritten?.ref).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(rewritten?.ref).not.toBe(upstream.url)

      const proxyResponse = await fetch(rewritten!.ref!)
      expect(proxyResponse.status).toBe(200)
      expect(upstream.lastHeaders.authorization).toBe("Bearer ap_token_123")

      await result.close()
    } finally {
      await upstream.stop()
    }
  })

  it("fails fast when the broker rejects, without leaking a proxy", async () => {
    const upstream = await createTestUpstream()
    try {
      await expect(
        resolveMcpServersWithSecrets({
          entries: [
            {
              name: "agentpush",
              transport: "http",
              ref: upstream.url,
              credentialPath: "agentpush/unknown",
            },
          ],
          broker: failingBroker("unknown credential"),
        }),
      ).rejects.toThrow("unknown credential")
    } finally {
      await upstream.stop()
    }
  })
})

describe("resolveSpawnExposures", () => {
  it("combines env exposures and mcp-header proxies", async () => {
    const upstream = await createTestUpstream()
    try {
      const result = await resolveSpawnExposures({
        exposures: [{ kind: "env", name: "FOO", field: "foo" }],
        mcpServers: [
          {
            name: "agentpush",
            transport: "http",
            ref: upstream.url,
            credentialPath: "agentpush/api",
          },
        ],
        broker: fakeBroker({ Authorization: "Bearer token" }),
        resolveEnvValue: field => (field === "foo" ? "bar" : undefined),
      })

      expect(result.env).toEqual({ FOO: "bar" })
      expect(result.mcpServers[0]?.ref).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      await result.closeProxies()
    } finally {
      await upstream.stop()
    }
  })
})
