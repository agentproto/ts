/**
 * WP3 — `agent_start.sandbox` + `appServe` end-to-end through the REAL wire
 * path: a fake `SandboxProvider` boots an in-process daemon (the "box",
 * `createGateway` — same as `agent-start-sandbox.test.ts`), and
 * `spawnAgentSession` (the host side, under test) runs the full app-serve
 * bootstrap against it:
 *
 *   `app_install` (real app emitted by `defineApp().emit`) →
 *   allowlist seed (`file_write`) →
 *   detached launch (`command_execute` with `sh`) →
 *   public URL resolved from the provider's pre-resolved `ports` map.
 *
 * The public URL points at a real local HTTP server so the readiness probe
 * answers without network. No mocking of the bootstrap internals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { SandboxProvider, SandboxSpec } from "@agentproto/sandbox"
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function extractText(message: unknown): string {
  if (typeof message === "string") return message
  if (message && typeof message === "object" && "text" in message) {
    const text = (message as { text?: unknown }).text
    if (typeof text === "string") return text
  }
  return JSON.stringify(message)
}

const CLAUDE_SDK_GATEWAY_AUTH: AdapterAuthDescriptor = {
  provider: "anthropic",
  authSubscription: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
  gatewayAuth: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
}

/** Fake CLI adapter for the box — accepts the SPAWN adapter (fake-cli) AND
 *  `mastra-agent`, whose resolution `app_install` checks when the app
 *  bundles agents. */
function makeFakeCliResolver(receivedPrompts: string[]): Parameters<typeof createGateway>[0]["resolveAgentAdapter"] {
  return async slug => {
    if (slug !== "fake-cli" && slug !== "mastra-agent") return null
    return {
      commandPreview: `${slug} (test double)`,
      authDescriptor: CLAUDE_SDK_GATEWAY_AUTH,
      async startSession(): Promise<AgentSessionLike> {
        return {
          sessionId: "remote_sess_1",
          async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
            const text = extractText(message)
            receivedPrompts.push(text)
            yield { kind: "text-delta", text: `echo: ${text}` }
            yield { kind: "turn-end", reason: "completed" }
          },
          async cancel() {},
          async close() {},
        }
      },
    }
  }
}

describe("agent_start.sandbox + appServe — in-box install + serve (e2e)", () => {
  const SERVE_PORT = 3210
  let receivedPrompts: string[]
  let boxGateway: GatewayHandle
  let boxWorkspace: string
  let appDir: string
  let probeServer: ReturnType<typeof createHttpServer>
  let probePort: number
  let registry: SessionsRegistry
  let workspace: string
  let deps: SpawnAgentSessionDeps

  beforeEach(async () => {
    receivedPrompts = []
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-appserve-box-"))
    workspace = await mkdtemp(join(tmpdir(), "agentproto-appserve-host-"))

    // A real local HTTP server standing in for the provider's public port
    // URL — the readiness probe answers OK against it in milliseconds.
    probeServer = createHttpServer((_req, res) => {
      res.writeHead(200)
      res.end("ok")
    })
    probePort = await new Promise<number>(resolve => {
      probeServer.listen(0, "127.0.0.1", () => {
        const addr = probeServer.address()
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0)
      })
    })

    const gatewayPort = await freePort()
    boxGateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port: gatewayPort,
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: makeFakeCliResolver(receivedPrompts),
    })

    // A REAL app bundle, emitted into the box workspace — the in-box app dir
    // the bootstrap installs (`/home/user/apps/<slug>` in production).
    appDir = join(boxWorkspace, "apps", "serve-app")
    const app = defineApp({
      id: "@test/serve-app",
      name: "Serve App",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
    })
    await app.emit(appDir)

    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })

    const provider: SandboxProvider = {
      async boot(spec: SandboxSpec) {
        // Mirror the e2b provider: resolve `spec.extraPorts` into the
        // boot-time ports map (port → public URL).
        const ports: Record<number, string> = {}
        for (const port of spec.extraPorts ?? []) {
          ports[port] = `http://127.0.0.1:${probePort}`
        }
        return {
          mcpUrl: `${boxGateway.url}/mcp`,
          sandboxId: "sbx_appserve_1",
          ...(Object.keys(ports).length > 0 ? { ports } : {}),
          async expose(port: number) {
            return { url: `http://127.0.0.1:${probePort}?port=${port}` }
          },
          async stop() {},
        }
      },
    }

    const resolveSandboxProvider = async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "fake") return null
      return {
        provider,
        slug: "fake",
        name: "Fake",
        version: "test",
        description: "test double booting an in-process daemon",
        requiresSetup: false,
        capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
        async check() {
          return true
        },
      }
    }

    deps = {
      registry,
      // Never called for a sandboxed spawn — the sandbox branch short-circuits.
      resolveAgentAdapter: vi.fn(async () => null),
      resolveSandboxProvider,
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  })

  afterEach(async () => {
    registry.shutdown()
    await boxGateway.stop()
    probeServer.close()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("installs the app in the box, launches the detached serve, and stamps the public URL on the descriptor", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
      appServe: { dir: appDir, port: SERVE_PORT },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The app-serve echo: real appId from the box's real app_install.
    expect(result.descriptor.appServe).toMatchObject({
      appId: "@test/serve-app",
      dir: appDir,
      port: SERVE_PORT,
      url: `http://127.0.0.1:${probePort}`,
      ready: true,
    })

    // The serve port was appended to extraPorts, so the provider resolved it
    // into the boot-time ports map — also stamped as sandboxPorts.
    expect(result.descriptor.sandboxPorts?.[SERVE_PORT]).toBe(`http://127.0.0.1:${probePort}`)

    // The box's workspace allowlist now carries the launcher basenames.
    const { readFile } = await import("node:fs/promises")
    const allowlist = JSON.parse(
      await readFile(join(boxWorkspace, ".agentproto", "allowed-commands.json"), "utf8"),
    )
    expect(allowlist.commands).toEqual(expect.arrayContaining(["sh", "agentproto"]))

    // The app was registered in the BOX daemon's own app registry.
    const client = await import("@modelcontextprotocol/sdk/client/index.js").then(m => new m.Client(
      { name: "test-verify", version: "0.0.0" },
      { capabilities: {} },
    ))
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    )
    await client.connect(new StreamableHTTPClientTransport(new URL(`${boxGateway.url}/mcp`)))
    const apps = await client.callTool({ name: "app_list", arguments: {} })
    const appsText = (apps.content as Array<{ type: string; text?: string }>).find(
      c => c.type === "text",
    )?.text
    expect(appsText).toContain("@test/serve-app")
    await client.close()
  })

  it("rejects appServe on a non-sandbox spawn", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      appServe: { dir: appDir, port: SERVE_PORT },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_app_serve_failed")
    expect(result.message).toContain("requires `sandbox`")
  })
})
