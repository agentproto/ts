/**
 * PR-B — auto-inject the spawned adapter into sandbox boxes. A box's boot
 * `npm i -g @agentproto/cli` replaces the global install and loses the
 * template-baked `@agentproto/adapter-*` packages; the runtime must declare
 * them in `config.installPackages` (installed in the SAME npm invocation by
 * the e2b/box providers) or an interactive `--sandbox e2b` spawn with a
 * non-baked adapter fails with "adapter could not be resolved".
 *
 * Two layers are exercised:
 *   - pure: `sandboxAdapterBootPackages` (dedupe / caller-pin-wins rules);
 *   - wire: `spawnAgentSession` with a fake sandbox provider that RECORDS the
 *     spec handed to `boot()` — the same real-path shape as
 *     `agent-start-sandbox.test.ts` (in-process gateway as the "box").
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
import { npmPackageName, sandboxAdapterBootPackages } from "../sandbox-adapters.js"

describe("sandboxAdapterBootPackages (pure)", () => {
  it("injects the adapter package plus the claude-code extra with @latest", () => {
    expect(sandboxAdapterBootPackages("claude-code", [])).toEqual([
      "@agentproto/adapter-claude-code@latest",
      "@anthropic-ai/claude-code@latest",
    ])
    expect(sandboxAdapterBootPackages("hermes", [])).toEqual([
      "@agentproto/adapter-hermes@latest",
    ])
  })

  it("a caller pin (any version) suppresses the matching @latest injection", () => {
    expect(
      sandboxAdapterBootPackages("hermes", ["@agentproto/adapter-hermes@0.4.12"]),
    ).toEqual([])
    expect(
      sandboxAdapterBootPackages(
        "claude-code",
        ["@agentproto/adapter-claude-code@1.2.3", "@anthropic-ai/claude-code@5.0.0"],
      ),
    ).toEqual([])
  })

  it("dedupes against already-declared @latest entries", () => {
    expect(
      sandboxAdapterBootPackages("hermes", ["@agentproto/adapter-hermes@latest"]),
    ).toEqual([])
  })

  it("ignores non-adapter declared entries", () => {
    expect(sandboxAdapterBootPackages("hermes", ["left-pad@1.3.0"])).toEqual([
      "@agentproto/adapter-hermes@latest",
    ])
  })

  it("splits package name from version without touching scoped names", () => {
    expect(npmPackageName("@org/pkg@1.2.3")).toBe("@org/pkg")
    expect(npmPackageName("@org/pkg")).toBe("@org/pkg")
    expect(npmPackageName("left-pad@1.3.0")).toBe("left-pad")
    expect(npmPackageName("left-pad")).toBe("left-pad")
  })
})

describe("spawnAgentSession sandbox — adapter installPackages auto-injection", () => {
  let bootSpecs: SandboxSpec[]
  let registry: SessionsRegistry
  let workspace: string
  let boxWorkspace: string
  let gateway: GatewayHandle
  let deps: SpawnAgentSessionDeps

  beforeEach(async () => {
    bootSpecs = []
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-autoinject-host-"))
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-autoinject-box-"))

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
          sandboxId: "sbx_autoinject_1",
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

  it("injects @agentproto/adapter-<slug>@latest into the boot spec's installPackages", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: workspace,
      sandbox: "fake",
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs).toHaveLength(1)
    expect(bootSpecs[0]?.config).toEqual({ installPackages: ["@agentproto/adapter-hermes@latest"] })
  })

  it("injects @anthropic-ai/claude-code@latest for the claude-code adapter", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: workspace,
      sandbox: "fake",
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.config).toEqual({
      installPackages: [
        "@agentproto/adapter-claude-code@latest",
        "@anthropic-ai/claude-code@latest",
      ],
    })
  })

  it("a caller-declared pin wins — no @latest duplicate is added", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: workspace,
      sandbox: { provider: "fake", config: { installPackages: ["@agentproto/adapter-hermes@0.4.12"] } },
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.config).toEqual({
      installPackages: ["@agentproto/adapter-hermes@0.4.12"],
    })
  })

  it("an already-declared @latest adapter entry is not duplicated", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: workspace,
      sandbox: {
        provider: "fake",
        config: { installPackages: ["@agentproto/adapter-hermes@latest", "left-pad@1.3.0"] },
      },
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.config).toEqual({
      installPackages: ["@agentproto/adapter-hermes@latest", "left-pad@1.3.0"],
    })
  })
})
