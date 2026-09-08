/**
 * PLAN-F — semantic `config.installAdapters` field on sandbox specs. Harness
 * slugs ("hermes", "claude-code", …) instead of raw npm specs; the runtime
 * expands each into `@agentproto/adapter-<slug>@latest` plus the adapter's
 * declared boot extras and merges them into `config.installPackages` after
 * #1232's auto-injection of the spawned adapter. Caller pins always win;
 * a spec without the field is passed through byte-identical.
 *
 * Two layers are exercised:
 *   - pure: `sandboxInstallAdapterPackages` (expansion / dedupe / pin rules);
 *   - wire: `spawnAgentSession` with a fake sandbox provider that RECORDS the
 *     spec handed to `boot()` — the same real-path shape as
 *     `sandbox-adapter-autoinstall.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider, SandboxSpec } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import { sandboxInstallAdapterPackages } from "../sandbox-adapters.js"

describe("sandboxInstallAdapterPackages (pure)", () => {
  it("expands each slug to its adapter package plus declared extras", () => {
    expect(sandboxInstallAdapterPackages(["hermes"], [])).toEqual([
      "@agentproto/adapter-hermes@latest",
    ])
    expect(sandboxInstallAdapterPackages(["claude-code"], [])).toEqual([
      "@agentproto/adapter-claude-code@latest",
      "@anthropic-ai/claude-code@latest",
    ])
  })

  it("expands multiple slugs in declared order", () => {
    expect(
      sandboxInstallAdapterPackages(["claude-code", "hermes"], []),
    ).toEqual([
      "@agentproto/adapter-claude-code@latest",
      "@anthropic-ai/claude-code@latest",
      "@agentproto/adapter-hermes@latest",
    ])
  })

  it("expands an unknown slug anyway — the npm install is the authority", () => {
    expect(sandboxInstallAdapterPackages(["not-a-catalog-slug"], [])).toEqual([
      "@agentproto/adapter-not-a-catalog-slug@latest",
    ])
  })

  it("a caller pin for the same package wins — no @latest duplicate", () => {
    expect(
      sandboxInstallAdapterPackages(["hermes"], ["@agentproto/adapter-hermes@0.4.12"]),
    ).toEqual([])
    expect(
      sandboxInstallAdapterPackages(
        ["claude-code"],
        ["@agentproto/adapter-claude-code@1.2.3", "@anthropic-ai/claude-code@5.0.0"],
      ),
    ).toEqual([])
  })

  it("does not duplicate a package between two selected slugs", () => {
    expect(sandboxInstallAdapterPackages(["hermes", "hermes"], [])).toEqual([
      "@agentproto/adapter-hermes@latest",
    ])
  })

  it("ignores unrelated declared entries", () => {
    expect(sandboxInstallAdapterPackages(["hermes"], ["left-pad@1.3.0"])).toEqual([
      "@agentproto/adapter-hermes@latest",
    ])
  })
})

describe("spawnAgentSession sandbox — installAdapters expansion", () => {
  let bootSpecs: SandboxSpec[]
  let registry: SessionsRegistry
  let workspace: string
  let boxWorkspace: string
  let gateway: GatewayHandle
  let deps: SpawnAgentSessionDeps

  beforeEach(async () => {
    bootSpecs = []
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-instadapters-host-"))
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-instadapters-box-"))

    // A fake CLI adapter that accepts ANY slug, so a `claude-code` spawn also
    // reaches a successful agent_start on the box.
    const resolveCliAdapter: AgentAdapterResolver = async () => ({
      commandPreview: "fake-cli (test double)",
      async startSession(): Promise<AgentSessionLike> {
        return {
          sessionId: "remote_sess_1",
          async *send(): AsyncIterable<AgentStreamEvent> {
            yield { kind: "turn-end", reason: "completed" }
          },
          async cancel() {},
          async close() {},
        }
      },
    })

    gateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port: await new Promise<number>((resolve, reject) => {
        const srv = createServer()
        srv.once("error", reject)
        srv.listen(0, "127.0.0.1", () => {
          const port = (srv.address() as AddressInfo).port
          srv.close(() => resolve(port))
        })
      }),
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: resolveCliAdapter,
    })

    const provider: SandboxProvider = {
      async boot(spec) {
        bootSpecs.push(spec)
        return {
          mcpUrl: `${gateway.url}/mcp`,
          sandboxId: "sbx_instadapters_1",
          stop: async () => undefined,
        }
      },
    }

    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })

    const resolveSandboxProvider = vi.fn(
      async (slug: string): Promise<SandboxProviderHandle | null> => {
        if (slug !== "fake") return null
        return {
          provider,
          slug: "fake",
          name: "Fake",
          version: "test",
          description: "records the spec handed to boot()",
          requiresSetup: false,
          capabilities: {
            networkEgress: false,
            mounts: false,
            lifecyclePause: false,
            readOnly: false,
          },
          async check() {
            return true
          },
        }
      },
    )

    deps = {
      registry,
      resolveAgentAdapter: vi.fn(async () => null),
      resolveSandboxProvider,
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  })

  afterEach(async () => {
    registry.shutdown()
    await gateway.stop()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("expands installAdapters slugs into installPackages, after caller pins", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "grok-cli",
      cwd: workspace,
      sandbox: {
        provider: "fake",
        config: { installAdapters: ["hermes", "claude-code"] },
      },
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.config).toEqual({
      installAdapters: ["hermes", "claude-code"],
      installPackages: [
        "@agentproto/adapter-grok-cli@latest",
        "@agentproto/adapter-hermes@latest",
        "@agentproto/adapter-claude-code@latest",
        "@anthropic-ai/claude-code@latest",
      ],
    })
  })

  it("merges with the #1232 spawned-adapter injection, pins preserved", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: workspace,
      sandbox: {
        provider: "fake",
        config: {
          installPackages: ["left-pad@1.3.0"],
          installAdapters: ["claude-code"],
        },
      },
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.config).toEqual({
      installPackages: [
        "@agentproto/adapter-hermes@latest",
        "left-pad@1.3.0",
        "@agentproto/adapter-claude-code@latest",
        "@anthropic-ai/claude-code@latest",
      ],
      installAdapters: ["claude-code"],
    })
  })

  it("a caller pin suppresses the matching expansion — no duplicate", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "grok-cli",
      cwd: workspace,
      sandbox: {
        provider: "fake",
        config: {
          installPackages: ["@agentproto/adapter-hermes@0.4.12"],
          installAdapters: ["hermes"],
        },
      },
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.config).toEqual({
      installPackages: [
        "@agentproto/adapter-grok-cli@latest",
        "@agentproto/adapter-hermes@0.4.12",
      ],
      installAdapters: ["hermes"],
    })
  })

  it("no installAdapters field — zero diff on the boot spec", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: workspace,
      sandbox: "fake",
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.config).toEqual({
      installPackages: ["@agentproto/adapter-hermes@latest"],
    })
  })
})