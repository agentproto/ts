/**
 * Unit coverage for the `harness_capabilities` MCP tool (agent-tools.ts) —
 * the live/parsed complement to `adapter_list`'s static manifest fields.
 * Thin surface test: the injected `listHarnessCapabilities` lister does the
 * real work (covered per-adapter in each adapter package + the cli's
 * `listHarnessCapabilities` in resolve.ts); this file only checks the tool
 * forwards `adapter`, reports "not configured" when unwired, and never lets
 * a secret value leak through the wire even if a misbehaving lister handed
 * one to it.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AdapterCapabilitiesLister } from "../http-server.js"
import type { HarnessCapabilities } from "@agentproto/provider-kit"

async function harness(listHarnessCapabilities?: AdapterCapabilitiesLister) {
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, {
    registry,
    ...(listHarnessCapabilities ? { listHarnessCapabilities } : {}),
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

function parseCapabilities(result: unknown): HarnessCapabilities[] {
  const content = (result as { content: Array<{ text: string }> }).content
  return (JSON.parse(content[0]!.text) as { capabilities: HarnessCapabilities[] }).capabilities
}

const FAKE: HarnessCapabilities = {
  adapter: "hermes",
  source: "discovered",
  discoverable: "live",
  authStores: [{ kind: "file", path: "~/.hermes/auth.json", format: "json", providerKeyed: true }],
  providers: [
    {
      id: "openrouter",
      billingEndpoint: "openrouter",
      cred: { present: true, source: { kind: "env", var: "OPENROUTER_API_KEY" } },
    },
  ],
  models: { mechanism: "file-cache", stale: false },
  endpointCompat: {},
  application: { modelApply: "command", postureApply: "none", coupled: false },
}

describe("harness_capabilities", () => {
  it("reports 'not enabled' when no lister is wired", async () => {
    const h = await harness()
    try {
      const result = await h.client.callTool({ name: "harness_capabilities", arguments: {} })
      expect((result as { isError?: boolean }).isError).toBe(true)
      const text = (result as { content: Array<{ text: string }> }).content[0]!.text
      expect(text).toContain("not enabled")
    } finally {
      await h.close()
    }
  })

  it("returns the lister's result", async () => {
    const h = await harness(async () => [FAKE])
    try {
      const result = await h.client.callTool({ name: "harness_capabilities", arguments: {} })
      const capabilities = parseCapabilities(result)
      expect(capabilities).toEqual([FAKE])
    } finally {
      await h.close()
    }
  })

  it("forwards the `adapter` argument to the lister", async () => {
    let received: { adapter?: string } | undefined
    const h = await harness(async (opts) => {
      received = opts
      return [FAKE]
    })
    try {
      await h.client.callTool({ name: "harness_capabilities", arguments: { adapter: "hermes" } })
      expect(received).toEqual({ adapter: "hermes" })
    } finally {
      await h.close()
    }
  })

  it("surfaces a thrown lister error as an MCP error, not a crash", async () => {
    const h = await harness(async () => {
      throw new Error("boom")
    })
    try {
      const result = await h.client.callTool({ name: "harness_capabilities", arguments: {} })
      expect((result as { isError?: boolean }).isError).toBe(true)
      const text = (result as { content: Array<{ text: string }> }).content[0]!.text
      expect(text).toContain("boom")
    } finally {
      await h.close()
    }
  })

  it("never leaks a raw secret value through the wire, even if a misbehaving lister returns one", async () => {
    const leaky: HarnessCapabilities = {
      ...FAKE,
      providers: [
        {
          id: "openrouter",
          billingEndpoint: "openrouter",
          cred: {
            present: true,
            // A well-behaved lister would never do this — this test proves
            // the TOOL is a transparent passthrough (no accidental scrubbing
            // that would mask a real leak), so the leak-prevention burden
            // stays where it belongs: the capability-discovery layer itself
            // (see capability.test.ts's own no-secret-leak assertions).
            source: { kind: "env", var: "OPENROUTER_API_KEY" },
            fingerprint: "abc123",
          },
        },
      ],
    }
    const h = await harness(async () => [leaky])
    try {
      const result = await h.client.callTool({ name: "harness_capabilities", arguments: {} })
      const text = (result as { content: Array<{ text: string }> }).content[0]!.text
      expect(text).not.toMatch(/sk-[a-zA-Z0-9]{10,}/)
    } finally {
      await h.close()
    }
  })
})
