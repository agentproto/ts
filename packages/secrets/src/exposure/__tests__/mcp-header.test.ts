import { describe, it, expect } from "vitest"
import {
  isExposureKind,
  resolveMcpHeaderExposure,
  type McpHeaderExposure,
  type McpHeaderResolver,
  type SecretExposure,
} from "../index.js"

function fakeResolver(headers: Record<string, string>): McpHeaderResolver {
  return {
    async resolveHeaders() {
      return headers
    },
  }
}

describe("@agentproto/secrets/exposure mcp-header", () => {
  it("forwards credentialPath -> path and server, returns headers verbatim", async () => {
    const calls: Array<{ path: string; server?: string; signal?: AbortSignal }> = []
    const resolver: McpHeaderResolver = {
      async resolveHeaders(o) {
        calls.push(o)
        return { Authorization: "Bearer ghp_x" }
      },
    }
    const exposure: McpHeaderExposure = {
      kind: "mcp-header",
      credentialPath: "github",
      server: "https://api.github.com",
    }

    const headers = await resolveMcpHeaderExposure(exposure, resolver)

    expect(headers).toEqual({ Authorization: "Bearer ghp_x" })
    expect(calls).toEqual([
      { path: "github", server: "https://api.github.com", signal: undefined },
    ])
  })

  it("passes an account segment in credentialPath through to the resolver's path unchanged", async () => {
    const calls: string[] = []
    const resolver: McpHeaderResolver = {
      async resolveHeaders(o) {
        calls.push(o.path)
        return { Authorization: "Bearer ghp_y" }
      },
    }
    const exposure: McpHeaderExposure = {
      kind: "mcp-header",
      credentialPath: "github/https://api.github.com",
    }

    await resolveMcpHeaderExposure(exposure, resolver)

    expect(calls).toEqual(["github/https://api.github.com"])
  })

  it("narrows via isExposureKind", () => {
    const exposure: SecretExposure = {
      kind: "mcp-header",
      credentialPath: "github",
    }
    expect(isExposureKind(exposure, "mcp-header")).toBe(true)
    if (isExposureKind(exposure, "mcp-header")) {
      expect(exposure.credentialPath).toBe("github")
    }
  })

  it("rejects a resolved header value containing LF (header-injection guard)", async () => {
    const resolver = fakeResolver({
      Authorization: "Bearer evil\nX-Injected: true",
    })
    const exposure: McpHeaderExposure = { kind: "mcp-header", credentialPath: "github" }

    await expect(resolveMcpHeaderExposure(exposure, resolver)).rejects.toThrow()
  })

  it("rejects a resolved header value containing CR", async () => {
    const resolver = fakeResolver({ Authorization: "Bearer evil\r\nX-Injected: true" })
    const exposure: McpHeaderExposure = { kind: "mcp-header", credentialPath: "github" }

    await expect(resolveMcpHeaderExposure(exposure, resolver)).rejects.toThrow()
  })

  it("rejects a resolved header value containing NUL", async () => {
    const resolver = fakeResolver({ Authorization: "Bearer evil\0" })
    const exposure: McpHeaderExposure = { kind: "mcp-header", credentialPath: "github" }

    await expect(resolveMcpHeaderExposure(exposure, resolver)).rejects.toThrow()
  })
})
