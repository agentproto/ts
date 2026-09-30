/**
 * Each onboarding step against a fake StepContext: the happy path and every
 * failure branch.
 */

import { describe, it, expect } from "vitest"
import { preflightStep } from "./steps/preflight.js"
import { workspaceStep } from "./steps/workspace.js"
import { daemonStep } from "./steps/daemon.js"
import { agentsStep, parseNpxPackage } from "./steps/agents.js"
import { connectMachinesStep, DIRECTIONS } from "./steps/connect-machines.js"
import { authStep } from "./steps/auth.js"
import { clientsStep } from "./steps/clients.js"
import { devicesStep } from "./steps/devices.js"
import { rendezvousStep } from "./steps/rendezvous.js"
import { skillsStep } from "./steps/skills.js"
import { localModelsStep } from "./steps/local-models.js"
import { llmGatewayStep } from "./steps/llm-gateway.js"
import { ONBOARDING_STEPS } from "./registry.js"
import { runChecks } from "./run.js"
import type { StepCheck } from "./types.js"
import { HOME, createFakeContext, createFakeFs, defaultExec, healthyFiles } from "./__fixtures__/fake-context.js"
import { createFakeSetup } from "./__fixtures__/fake-setup.js"

function byId(checks: StepCheck[], id: string): StepCheck {
  const c = checks.find((x) => x.id === id)
  if (!c) throw new Error(`no check ${id} in ${checks.map((x) => x.id).join(", ")}`)
  return c
}

function filesWithout(...paths: string[]): Record<string, string> {
  const files = healthyFiles()
  for (const p of paths) delete files[p]
  return files
}

describe("healthy machine", () => {
  it("every step reports only ok (or skipped)", async () => {
    const reports = await runChecks(ONBOARDING_STEPS, createFakeContext())
    const bad = reports.flatMap((r) => r.checks).filter((c) => c.status !== "ok" && c.status !== "skipped")
    expect(bad).toEqual([])
    expect(reports.map((r) => r.id)).toEqual([
      "preflight",
      "workspace",
      "daemon",
      "agents",
      "connect-machines",
      "auth",
      "clients",
      "devices",
      "rendezvous",
      "skills",
      "local-models",
      "llm-gateway",
    ])
  })

  it("detect is read-only: zero fs writes after a full run", async () => {
    const ctx = createFakeContext()
    await runChecks(ONBOARDING_STEPS, ctx)
    expect(ctx.fs.writes).toEqual([])
    // Only read-only probes were spawned (`launchctl print`, the adapter
    // `probe-*` version checks, and the recap-B4 `command -v` shell probes).
    for (const call of ctx.execCalls) expect(call).toMatch(/^(launchctl print |bash -lc (probe-|command -v ))/)
  })
})

describe("preflight", () => {
  it("old Node is broken", async () => {
    const checks = await preflightStep.detect(createFakeContext({ nodeVersion: "v18.19.0" }))
    expect(byId(checks, "preflight.node").status).toBe("broken")
  })

  it("unsupported OS warns", async () => {
    const checks = await preflightStep.detect(createFakeContext({ platform: "win32" }))
    expect(byId(checks, "preflight.os").status).toBe("warn")
  })

  it("newer CLI on npm warns with an update fix", async () => {
    const checks = await preflightStep.detect(createFakeContext({ sources: { latestCliVersion: async () => "1.2.0" } }))
    const c = byId(checks, "preflight.cli-version")
    expect(c.status).toBe("warn")
    expect(c.fix).toBe("npm i -g @agentproto/cli")
  })

  it("npm unreachable warns 'could not check', never broken", async () => {
    const checks = await preflightStep.detect(
      createFakeContext({ sources: { latestCliVersion: async () => { throw new Error("offline") } } }),
    )
    const c = byId(checks, "preflight.cli-version")
    expect(c.status).toBe("warn")
    expect(c.detail).toContain("could not check")
  })

  it("missing ~/.agentproto warns; unwritable is broken", async () => {
    const missing = await preflightStep.detect(createFakeContext({ fs: createFakeFs({}) }))
    expect(byId(missing, "preflight.home").status).toBe("warn")

    const fs = createFakeFs(healthyFiles())
    fs.readOnly.add(`${HOME}/.agentproto`)
    const ro = await preflightStep.detect(createFakeContext({ fs }))
    expect(byId(ro, "preflight.home").status).toBe("broken")
  })
})

describe("workspace", () => {
  it("no workspace is missing, with a `workspace add` fix", async () => {
    const checks = await workspaceStep.detect(
      createFakeContext({ sources: { loadWorkspaces: async () => ({ version: 1, workspaces: [] }) }, cwd: "/x/My App" }),
    )
    const c = byId(checks, "workspace.registered")
    expect(c.status).toBe("missing")
    expect(c.fix).toBe("agentproto workspace add . --slug my-app")
  })

  it("cwd outside every workspace warns", async () => {
    const checks = await workspaceStep.detect(createFakeContext({ cwd: `${HOME}/projector` }))
    expect(byId(checks, "workspace.cwd").status).toBe("warn")
  })

  it("an unreadable workspaces.json is broken", async () => {
    const checks = await workspaceStep.detect(
      createFakeContext({ sources: { loadWorkspaces: async () => { throw new Error("not valid JSON") } } }),
    )
    expect(byId(checks, "workspace.registered").status).toBe("broken")
  })
})

describe("daemon", () => {
  it("unreachable /health is missing; fix depends on service state", async () => {
    const installed = await daemonStep.detect(createFakeContext({ health: null }))
    expect(byId(installed, "daemon.health")).toMatchObject({ status: "missing", fix: "agentproto daemon start" })

    const bare = await daemonStep.detect(
      createFakeContext({ health: null, fs: createFakeFs(filesWithout(`${HOME}/Library/LaunchAgents/sh.agentproto.plist`)) }),
    )
    expect(byId(bare, "daemon.health").fix).toBe("agentproto daemon install")
  })

  it("daemon version != CLI version warns", async () => {
    const checks = await daemonStep.detect(createFakeContext({ health: { version: "0.9.0" } }))
    expect(byId(checks, "daemon.health").status).toBe("warn")
  })

  it("no plist warns with `daemon install` and skips the PATH check", async () => {
    const checks = await daemonStep.detect(
      createFakeContext({ fs: createFakeFs(filesWithout(`${HOME}/Library/LaunchAgents/sh.agentproto.plist`)) }),
    )
    expect(byId(checks, "daemon.service")).toMatchObject({ status: "warn", fix: "agentproto daemon install" })
    expect(checks.find((c) => c.id === "daemon.path")).toBeUndefined()
  })

  it("plist present but not loaded warns", async () => {
    const checks = await daemonStep.detect(
      createFakeContext({ exec: () => ({ code: 113, stdout: "", stderr: "Could not find service" }) }),
    )
    expect(byId(checks, "daemon.service").status).toBe("warn")
  })

  it("stale plist PATH warns with `daemon restart`", async () => {
    const checks = await daemonStep.detect(
      createFakeContext({ sources: { loginShellPath: async () => "/usr/bin:/bin:/new/bin" } }),
    )
    expect(byId(checks, "daemon.path")).toMatchObject({ status: "warn", fix: "agentproto daemon restart" })
  })

  it("failed login-shell probe degrades to not checked", async () => {
    const checks = await daemonStep.detect(createFakeContext({ sources: { loginShellPath: async () => null } }))
    expect(byId(checks, "daemon.path").detail).toContain("not checked")
  })

  it("linux: no service manager yet", async () => {
    const checks = await daemonStep.detect(createFakeContext({ platform: "linux" }))
    expect(byId(checks, "daemon.service")).toMatchObject({ status: "warn", fix: "agentproto serve" })
  })

  it("windows: scheduled task registered ⇒ ok; unregistered ⇒ daemon install fix", async () => {
    const registered = await daemonStep.detect(
      createFakeContext({
        platform: "win32",
        exec: () => ({ code: 0, stdout: "TaskName: agentproto-daemon\nStatus: Running\n", stderr: "" }),
      }),
    )
    expect(byId(registered, "daemon.service")).toMatchObject({ status: "ok", title: "Scheduled task" })
    expect(byId(registered, "daemon.health").status).toBe("ok")

    const unregistered = await daemonStep.detect(
      createFakeContext({
        platform: "win32",
        exec: () => ({ code: 1, stdout: "", stderr: "INFO: No tasks found." }),
        health: null,
      }),
    )
    expect(byId(unregistered, "daemon.service")).toMatchObject({ status: "warn", fix: "agentproto daemon install" })
    expect(byId(unregistered, "daemon.health").fix).toBe("agentproto daemon install")
  })
})

describe("agents", () => {
  it("lists installed harnesses and one skipped line for the rest", async () => {
    const checks = await agentsStep.detect(createFakeContext())
    expect(byId(checks, "agents.claude-code")).toMatchObject({ status: "ok", detail: "v2.0.0" })
    expect(byId(checks, "agents.hermes").status).toBe("ok")
    const rest = byId(checks, "agents.not-installed")
    expect(rest.status).toBe("skipped")
    expect(rest.detail).toContain("codex")
  })

  it("zero harnesses is missing with an install fix", async () => {
    const checks = await agentsStep.detect(
      createFakeContext({
        exec: () => ({ code: 1, stdout: "", stderr: "" }),
        sources: { resolveAdapterHandle: async () => { throw new Error("not found") } },
      }),
    )
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ id: "agents.none", status: "missing", fix: "agentproto install claude-code" })
  })

  // The real claude-code/codex/mastracode shape: spawned via `npx -y <pkg>@pin`,
  // install-presence probe `npm ls -g <pkg>` (fails when nothing is global).
  const npxHandle = (pkg: string) => async () => ({
    bin: "npx",
    bin_args: ["-y", pkg],
    version_check: { cmd: `npm ls -g ${pkg.replace(/@[^@/]*$/, "")} --depth=0`, parse: "(\\d+\\.\\d+\\.\\d+)", range: "*" },
  })
  const only = (...slugs: string[]) => (checks: StepCheck[]) => checks.filter((c) => slugs.some((s) => c.id === `agents.${s}`))
  function npxExec(opts: { npx?: boolean; claude?: string | null; codex?: string | null } = {}) {
    return (cmd: string, args: readonly string[]) => {
      const script = args[1] ?? ""
      if (script === "command -v npx") return opts.npx === false ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "/usr/bin/npx\n", stderr: "" }
      if (script === "claude --version") return opts.claude ? { code: 0, stdout: `${opts.claude} (Claude Code)\n`, stderr: "" } : { code: 127, stdout: "", stderr: "" }
      if (script === "codex --version") return opts.codex ? { code: 0, stdout: `codex-cli ${opts.codex}\n`, stderr: "" } : { code: 127, stdout: "", stderr: "" }
      // Every `npm ls -g` fails: nothing installed globally. Anything that
      // still ran the install-presence probe would read as absent.
      return { code: 1, stdout: "", stderr: "" }
    }
  }

  it("claude-code via npx + `claude` on PATH is ok even with nothing installed globally", async () => {
    const fs = createFakeFs({
      ...healthyFiles(),
      [`${HOME}/.npm/_npx/abc/node_modules/@agentclientprotocol/claude-agent-acp/package.json`]: JSON.stringify({ version: "0.81.2" }),
    })
    const checks = await agentsStep.detect(
      createFakeContext({
        fs,
        exec: npxExec({ claude: "2.1.282" }),
        sources: { resolveAdapterHandle: npxHandle("@agentclientprotocol/claude-agent-acp@0.81.2") },
      }),
    )
    expect(byId(checks, "agents.claude-code")).toMatchObject({
      status: "ok",
      detail: "claude 2.1.282 · ACP bridge via npx (v0.81.2, cached)",
      data: { slug: "claude-code", version: "2.1.282" },
    })
  })

  it("an uncached pinned bridge is still ok: npx fetches it on first spawn", async () => {
    const checks = await agentsStep.detect(
      createFakeContext({
        exec: npxExec({ codex: "0.157.0" }),
        sources: { resolveAdapterHandle: npxHandle("@agentclientprotocol/codex-acp@1.13.1") },
      }),
    )
    expect(byId(checks, "agents.codex")).toMatchObject({
      status: "ok",
      detail: "codex 0.157.0 · ACP bridge via npx (v1.13.1, fetched on first spawn)",
    })
  })

  it("bridge spawnable but the harness CLI missing warns with its install command", async () => {
    const checks = await agentsStep.detect(
      createFakeContext({
        exec: npxExec({ claude: null }),
        sources: { resolveAdapterHandle: npxHandle("@agentclientprotocol/claude-agent-acp@0.81.2") },
      }),
    )
    expect(byId(checks, "agents.claude-code")).toMatchObject({
      status: "warn",
      fix: "npm i -g @anthropic-ai/claude-code",
    })
    expect(byId(checks, "agents.claude-code").detail).toContain("`claude` is not on PATH")
  })

  it("mastracode (no companion CLI) is ok via npx with the package as its label", async () => {
    const checks = await agentsStep.detect(
      createFakeContext({ exec: npxExec(), sources: { resolveAdapterHandle: npxHandle("mastracode") } }),
    )
    expect(byId(checks, "agents.mastracode")).toMatchObject({
      status: "ok",
      detail: "mastracode via npx (fetched on first spawn)",
    })
  })

  it("no npx on PATH ⇒ npx adapters are not installed", async () => {
    const checks = await agentsStep.detect(
      createFakeContext({
        exec: npxExec({ npx: false, claude: "2.1.282" }),
        sources: { resolveAdapterHandle: npxHandle("@agentclientprotocol/claude-agent-acp@0.81.2") },
      }),
    )
    expect(byId(checks, "agents.none").status).toBe("missing")
  })

  it("a `node --version` presence probe shows 'available', never the Node version", async () => {
    const checks = await agentsStep.detect(
      createFakeContext({
        exec: (_cmd, args) => (args[1] === "node --version" ? { code: 0, stdout: "v22.22.0\n", stderr: "" } : { code: 1, stdout: "", stderr: "" }),
        sources: {
          resolveAdapterHandle: async () => ({
            bin: "node",
            version_check: { cmd: "node --version", parse: "v(\\d+\\.\\d+\\.\\d+)", range: ">=20" },
          }),
        },
      }),
    )
    const shown = only("claude-sdk", "mastra-agent")(checks)
    expect(shown).toHaveLength(2)
    for (const c of shown) {
      expect(c).toMatchObject({ status: "ok", detail: "available", data: { version: null } })
      expect(JSON.stringify(c)).not.toContain("22.22.0")
    }
  })

  it("an in-process adapter is available once its package resolves, without probing", async () => {
    const ctx = createFakeContext({
      exec: () => ({ code: 1, stdout: "", stderr: "" }),
      sources: {
        resolveAdapterHandle: async () => ({
          bin: "in-process",
          version_check: { cmd: "npm view mastracode version", parse: "(\\d+\\.\\d+\\.\\d+)", range: "*" },
        }),
      },
    })
    const checks = await agentsStep.detect(ctx)
    expect(byId(checks, "agents.mastracode-inprocess")).toMatchObject({ status: "ok", detail: "available (in-process)" })
    expect(ctx.execCalls.some((c) => c.includes("npm view"))).toBe(false)
  })

  // ── recap B4: stale daemon PATH diagnosis ──────────────────────────────

  it("an adapter installed in the shell but missing from the daemon PATH warns with the restart fix", async () => {
    const checks = await agentsStep.detect(
      createFakeContext({
        // opencode is the only catalog adapter the default exec leaves absent.
        exec: (cmd, args) => {
          const script = args[1] ?? ""
          if (script === "command -v opencode") return { code: 0, stdout: "/opt/new/bin/opencode\n", stderr: "" }
          return defaultExec(cmd, args)
        },
        health: { version: "1.0.0", uptimeMs: 1, path: "/usr/bin:/bin" }, // daemon PATH lacks /opt/new/bin
      }),
    )
    const c = byId(checks, "agents.opencode")
    expect(c.status).toBe("warn")
    expect(c.detail).toContain("opencode is installed in your login shell (/opt/new/bin/opencode) but not visible to the daemon")
    expect(c.detail).toContain("PATH captured at daemon start")
    expect(c.fix).toBe("agentproto daemon restart")
    // Not counted as "not installed": the install action would be wrong.
    expect(byId(checks, "agents.not-installed").detail).not.toContain("opencode")
  })

  it("the shell probe is skipped when the daemon is not running", async () => {
    const ctx = createFakeContext({
      exec: (cmd, args) => {
        const script = args[1] ?? ""
        if (script === "command -v opencode") return { code: 0, stdout: "/opt/new/bin/opencode\n", stderr: "" }
        return defaultExec(cmd, args)
      },
      health: null, // daemon down → no diagnosis, plain absent entry
    })
    const checks = await agentsStep.detect(ctx)
    expect(ctx.execCalls.some((c) => c.includes("command -v opencode"))).toBe(false)
    const c = checks.find((x) => x.id === "agents.not-installed")
    expect(c?.detail).toContain("opencode")
  })

  it("no hint when the daemon PATH already contains the binary's directory", async () => {
    const checks = await agentsStep.detect(
      createFakeContext({
        exec: (cmd, args) => {
          const script = args[1] ?? ""
          if (script === "command -v opencode") return { code: 0, stdout: "/usr/bin/opencode\n", stderr: "" }
          return defaultExec(cmd, args)
        },
        health: { version: "1.0.0", uptimeMs: 1, path: "/usr/bin:/bin" },
      }),
    )
    expect(checks.find((x) => x.id === "agents.opencode")).toBeUndefined()
    expect(byId(checks, "agents.not-installed").detail).toContain("opencode")
  })
})

describe("parseNpxPackage", () => {
  it("splits scoped/unscoped specs and skips flags", () => {
    expect(parseNpxPackage(["-y", "@agentclientprotocol/claude-agent-acp@0.81.2"])).toEqual({
      name: "@agentclientprotocol/claude-agent-acp",
      version: "0.81.2",
    })
    expect(parseNpxPackage(["-y", "mastracode"])).toEqual({ name: "mastracode", version: null })
    expect(parseNpxPackage(["-y", "opencode-ai", "acp"])).toEqual({ name: "opencode-ai", version: null })
    expect(parseNpxPackage(["-y"])).toBeNull()
  })
})

describe("auth", () => {
  it("no profiles warns", async () => {
    const checks = await authStep.detect(createFakeContext({ sources: { listAuthProfiles: async () => [] } }))
    expect(byId(checks, "auth.profiles").status).toBe("warn")
  })

  it("a discovered-but-not-imported credential warns with the exact import command", async () => {
    const checks = await authStep.detect(
      createFakeContext({
        sources: {
          discoverCredentials: async () => [
            { endpoint: "openrouter", method: "api-key", origin: "hermes-config", hint: "OPENROUTER_API_KEY in ~/.hermes/config.yaml" },
          ],
        },
      }),
    )
    const c = byId(checks, "auth.discover.hermes-config.openrouter")
    expect(c).toMatchObject({ status: "warn", fix: "agentproto auth profile import hermes-config openrouter" })
    // Never carries the locator/secret — only origin + endpoint + method.
    expect(JSON.stringify(c)).not.toContain("OPENROUTER_API_KEY")
  })

  it("a source-backed claude-code profile counts as imported", async () => {
    const checks = await authStep.detect(
      createFakeContext({
        sources: {
          listAuthProfiles: async () => [
            { id: "subs", endpoint: "anthropic", method: "oauth-bearer", source: "claude-code-oauth" },
          ],
        },
      }),
    )
    expect(byId(checks, "auth.discover").status).toBe("ok")
  })

  it("discovery failure degrades to not checked", async () => {
    const checks = await authStep.detect(
      createFakeContext({ sources: { discoverCredentials: async () => { throw new Error("keychain locked") } } }),
    )
    expect(byId(checks, "auth.discover").detail).toContain("not checked")
  })
})

describe("clients", () => {
  it("detected but not registered warns with an install-mcp fix", async () => {
    const checks = await clientsStep.detect(
      createFakeContext({
        fs: createFakeFs({ ...healthyFiles(), [`${HOME}/.cursor/mcp.json`]: JSON.stringify({ mcpServers: {} }) }),
        sources: { loadMcpInstallState: async () => ({ entries: [] }) },
      }),
    )
    expect(byId(checks, "clients.cursor")).toMatchObject({ status: "warn", fix: "agentproto install-mcp --agent cursor" })
  })

  it("recorded in install-state but removed from the config warns", async () => {
    const checks = await clientsStep.detect(
      createFakeContext({ fs: createFakeFs({ ...healthyFiles(), [`${HOME}/.cursor/mcp.json`]: "{}" }) }),
    )
    const c = byId(checks, "clients.cursor")
    expect(c.status).toBe("warn")
    expect(c.detail).toContain("install-state.json")
  })

  it("a pinned URL on the wrong port is broken", async () => {
    const cfg = JSON.stringify({
      mcpServers: { agentproto: { command: "agentproto", args: ["mcp-bridge"], env: { AGENTPROTO_MCP_URL: "http://127.0.0.1:18791/mcp" } } },
    })
    const checks = await clientsStep.detect(
      createFakeContext({ fs: createFakeFs({ ...healthyFiles(), [`${HOME}/.cursor/mcp.json`]: cfg }) }),
    )
    expect(byId(checks, "clients.cursor").status).toBe("broken")
  })

  it("hermes YAML + codex TOML registrations are recognised", async () => {
    const checks = await clientsStep.detect(
      createFakeContext({
        fs: createFakeFs({
          ...healthyFiles(),
          [`${HOME}/.hermes/config.yaml`]: "model: x\nmcp_servers:\n  bureau:\n    url: http://b\n  agentproto:\n    url: http://127.0.0.1:18790/mcp\n",
          [`${HOME}/.codex/config.toml`]: '[mcp_servers.agentproto]\ncommand = "agentproto"\nargs = ["mcp-bridge"]\n',
        }),
        sources: {
          detectClients: async () => [
            { name: "hermes", label: "Hermes", configPath: `${HOME}/.hermes/config.yaml`, hasBinary: true, hasConfig: true },
            { name: "codex", label: "Codex CLI", configPath: `${HOME}/.codex/config.toml`, hasBinary: true, hasConfig: true },
          ],
          loadMcpInstallState: async () => ({ entries: [] }),
        },
      }),
    )
    expect(byId(checks, "clients.hermes").status).toBe("ok")
    expect(byId(checks, "clients.codex").status).toBe("ok")
  })

  it("no clients detected is skipped", async () => {
    const checks = await clientsStep.detect(createFakeContext({ sources: { detectClients: async () => [] } }))
    expect(checks[0]?.status).toBe("skipped")
  })
})

describe("devices", () => {
  it("no pairings is skipped", async () => {
    const checks = await devicesStep.detect(
      createFakeContext({ sources: { loadDevices: async () => [] } }),
    )
    expect(checks).toEqual([
      expect.objectContaining({ id: "devices.count", status: "skipped" }),
    ])
  })

  const NOW = Date.parse("2026-09-27T00:00:00.000Z")

  it("recently-seen devices are just a count", async () => {
    const checks = await devicesStep.detect(
      createFakeContext({
        now: () => NOW,
        sources: {
          loadDevices: async () => [
            { fingerprint: "fp1", name: "laptop", createdAt: "2026-09-01T00:00:00.000Z", lastSeen: "2026-09-26T00:00:00.000Z" },
          ],
        },
      }),
    )
    expect(byId(checks, "devices.count")).toMatchObject({ status: "ok", detail: "1 device(s)" })
    expect(checks).toHaveLength(1)
  })

  it("a device not seen in 30+ days warns with a revoke fix", async () => {
    const checks = await devicesStep.detect(
      createFakeContext({
        now: () => NOW,
        sources: {
          loadDevices: async () => [
            { fingerprint: "fp1", name: "old-phone", createdAt: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-02T00:00:00.000Z" },
          ],
        },
      }),
    )
    expect(byId(checks, "devices.stale.fp1")).toMatchObject({
      status: "warn",
      detail: "not seen in over 30 days",
      fix: "agentproto pair revoke old-phone",
    })
  })

  it("a device never seen since pairing says so, not just 'not seen'", async () => {
    const checks = await devicesStep.detect(
      createFakeContext({
        now: () => NOW,
        sources: {
          loadDevices: async () => [
            { fingerprint: "fp1", name: "ghost", createdAt: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z" },
          ],
        },
      }),
    )
    expect(byId(checks, "devices.stale.fp1").detail).toBe("never seen since paired in over 30 days")
  })

  it("a read failure warns instead of throwing", async () => {
    const checks = await devicesStep.detect(
      createFakeContext({
        sources: {
          loadDevices: async () => {
            throw new Error("pairings.json unreadable")
          },
        },
      }),
    )
    expect(byId(checks, "devices.count").status).toBe("warn")
    expect(byId(checks, "devices.count").detail).toContain("not checked")
  })
})

describe("connect-machines", () => {
  const nonePaired = createFakeContext({ sources: { loadDevices: async () => [] } })

  /** A minimal SetupIO-like stub that just records log.message lines. */
  function printed() {
    const logs: string[] = []
    const io = { log: { message: (m: string) => logs.push(m) } }
    return { io, logs }
  }

  it("a paired machine is settled; nothing paired proposes the direction", async () => {
    const paired = await connectMachinesStep.detect(createFakeContext())
    expect(byId(paired, "connect-machines.direction")).toMatchObject({ status: "ok", data: { count: 1 } })

    const none = await connectMachinesStep.detect(nonePaired)
    const c = byId(none, "connect-machines.direction")
    expect(c).toMatchObject({ status: "warn" })
    expect(c.detail).toContain("no machines paired")
  })

  it("the pilotable direction prints the host-offer commands with the CONTROLLER side explicit", async () => {
    const checks = await connectMachinesStep.detect(nonePaired)
    const [action] = (await connectMachinesStep.plan?.(checks, nonePaired, new Map())) ?? []
    expect(action?.title).toContain("pilot")
    const { io, logs } = printed()
    const result = await (action as unknown as { apply: (io: unknown, selected?: string[]) => Promise<{ detail: string }> }).apply(io, [DIRECTIONS.pilotable])
    expect(result.detail).toBe("commands printed above")
    const text = logs.join("\n")
    expect(text).toContain("agentproto pair offer --host")
    expect(text).toContain("agentproto devices add <offer-url>")
    expect(text).toContain("CONTROLLER")
  })

  it("the piloting direction names both sides of the client offer", async () => {
    const checks = await connectMachinesStep.detect(nonePaired)
    const [action] = (await connectMachinesStep.plan?.(checks, nonePaired, new Map())) ?? []
    const { io, logs } = printed()
    const result = await (action as unknown as { apply: (io: unknown, selected?: string[]) => Promise<{ detail: string }> }).apply(io, [DIRECTIONS.pilot])
    expect(result.detail).toBe("commands printed above")
    const text = logs.join("\n")
    expect(text).toContain("agentproto pair offer")
    expect(text).toContain("agentproto pair accept")
  })

  it("skip prints nothing", async () => {
    const checks = await connectMachinesStep.detect(nonePaired)
    const [action] = (await connectMachinesStep.plan?.(checks, nonePaired, new Map())) ?? []
    const result = await (action as unknown as { apply: (io: unknown, selected?: string[]) => Promise<{ detail: string | undefined }> }).apply(ioNothing(), [DIRECTIONS.skip])
    expect(result.detail).toBe("skipped")
  })
})

function ioNothing(): unknown {
  return { log: { message: () => {} } }
}

describe("rendezvous", () => {
  it("reachable direct reports ok with the hosted default url", async () => {
    const checks = await rendezvousStep.detect(
      createFakeContext({ dialWebSocket: async () => ({ ok: true, via: "direct" }) }),
    )
    expect(byId(checks, "rendezvous.reachable")).toMatchObject({
      status: "ok",
      detail: "reachable (direct) — wss://rdv.agentproto.sh/v1",
    })
  })

  it("reachable via proxy is distinguished from direct", async () => {
    const checks = await rendezvousStep.detect(
      createFakeContext({ dialWebSocket: async () => ({ ok: true, via: "proxy" }) }),
    )
    expect(byId(checks, "rendezvous.reachable").detail).toContain("reachable (via proxy)")
  })

  it("a configured pairing.rendezvous overrides the hosted default", async () => {
    const checks = await rendezvousStep.detect(
      createFakeContext({
        sources: { loadConfig: async () => ({ pairing: { rendezvous: "wss://rv.example.com/v1" } }) },
        dialWebSocket: async () => ({ ok: true, via: "direct" }),
      }),
    )
    expect(byId(checks, "rendezvous.reachable").detail).toContain("wss://rv.example.com/v1")
  })

  it("pairing.rendezvous set to \"\" is skipped, not warned", async () => {
    const checks = await rendezvousStep.detect(
      createFakeContext({ sources: { loadConfig: async () => ({ pairing: { rendezvous: "" } }) } }),
    )
    expect(byId(checks, "rendezvous.reachable").status).toBe("skipped")
  })

  it("an unreachable broker warns with the error and a fix", async () => {
    const checks = await rendezvousStep.detect(
      createFakeContext({ dialWebSocket: async () => ({ ok: false, via: "direct", error: "ECONNREFUSED" }) }),
    )
    expect(byId(checks, "rendezvous.reachable")).toMatchObject({
      status: "warn",
      fix: expect.stringContaining("agentproto rendezvous serve"),
    })
    expect(byId(checks, "rendezvous.reachable").detail).toContain("ECONNREFUSED")
  })

  it("a loadConfig failure warns instead of throwing", async () => {
    const checks = await rendezvousStep.detect(
      createFakeContext({
        sources: {
          loadConfig: async () => {
            throw new Error("config.json unreadable")
          },
        },
      }),
    )
    expect(byId(checks, "rendezvous.reachable").status).toBe("warn")
    expect(byId(checks, "rendezvous.reachable").detail).toContain("not checked")
  })
})

describe("skills", () => {
  it("plugin not installed warns with the install fix", async () => {
    const checks = await skillsStep.detect(
      createFakeContext({
        fs: createFakeFs(filesWithout(`${HOME}/.claude/plugins/agentproto/.claude-plugin/plugin.json`)),
      }),
    )
    expect(byId(checks, "skills.claude-code")).toMatchObject({
      status: "warn",
      fix: "agentproto install skill/agentproto-pack",
    })
  })

  it("stale plugin version warns", async () => {
    const checks = await skillsStep.detect(
      createFakeContext({
        fs: createFakeFs({
          ...healthyFiles(),
          [`${HOME}/.claude/plugins/agentproto/.claude-plugin/plugin.json`]: JSON.stringify({ version: "0.5.0" }),
        }),
      }),
    )
    expect(byId(checks, "skills.claude-code").detail).toContain("older")
  })

  it("flat-dir with missing skills warns stale", async () => {
    const checks = await skillsStep.detect(
      createFakeContext({ fs: createFakeFs(filesWithout(`${HOME}/.hermes/skills/ap-two/SKILL.md`)) }),
    )
    expect(byId(checks, "skills.hermes").detail).toContain("1/2")
  })

  it("no local pack: plugin compares against npm, flat-dir degrades to not checked", async () => {
    const checks = await skillsStep.detect(
      createFakeContext({
        sources: { resolveSkillPackDir: async () => null, latestSkillPackVersion: async () => "0.9.0" },
      }),
    )
    expect(byId(checks, "skills.claude-code").status).toBe("warn")
    expect(byId(checks, "skills.hermes").detail).toContain("not checked")
  })

  it("no skill-capable adapter is skipped", async () => {
    const checks = await skillsStep.detect(createFakeContext({ sources: { skillTargets: async () => [] } }))
    expect(checks[0]?.status).toBe("skipped")
  })
})

describe("local-models", () => {
  it("nothing configured (no FORGE_BASE_URL, no llm-endpoints.json) is skipped", async () => {
    const checks = await localModelsStep.detect(createFakeContext())
    expect(checks).toHaveLength(1)
    expect(checks[0]?.status).toBe("skipped")
  })

  it("FORGE_BASE_URL alone is probed as the implicit forge endpoint", async () => {
    const checks = await localModelsStep.detect(
      createFakeContext({
        env: { FORGE_BASE_URL: "http://10.0.10.20:8000/v1" },
        fetch: (async () => new Response(JSON.stringify({ data: [{ id: "my-lora" }] }), { status: 200 })) as typeof fetch,
      }),
    )
    expect(byId(checks, "local-models.forge")).toMatchObject({ status: "ok" })
  })

  it("a reachable file-configured endpoint reports ok, plus its connector's models", async () => {
    const checks = await localModelsStep.detect(
      createFakeContext({
        fs: createFakeFs({
          ...healthyFiles(),
          [`${HOME}/.agentproto/llm-endpoints.json`]: JSON.stringify({
            endpoints: [{ id: "bonsai", kind: "openai", baseUrl: "http://192.168.1.20:8081/v1", connector: "lmstudio" }],
          }),
        }),
        fetch: (async (url: string | URL) => {
          if (String(url).endsWith("/api/v0/models")) {
            return new Response(
              JSON.stringify({
                data: [
                  { id: "bonsai-27b-win", state: "loaded", loaded_context_length: 62976, max_context_length: 262144 },
                  { id: "other-model", state: "not-loaded" },
                ],
              }),
              { status: 200 },
            )
          }
          return new Response(JSON.stringify({ data: [] }), { status: 200 })
        }) as typeof fetch,
      }),
    )
    const check = byId(checks, "local-models.bonsai")
    expect(check).toMatchObject({
      status: "ok",
      detail: "http://192.168.1.20:8081/v1 reachable — 1 loaded (bonsai-27b-win, ctx 62976/262144 [claude-code✓ claude-sdk✓ pi✓])",
    })
    expect(check.data?.connector).toBe("lmstudio")
    expect(check.data?.models).toEqual([
      { id: "bonsai-27b-win", state: "loaded", loadedCtx: 62976, maxCtx: 262144 },
      { id: "other-model", state: "not-loaded" },
    ])
  })

  it("a reachable endpoint with no models loaded says so", async () => {
    const checks = await localModelsStep.detect(
      createFakeContext({
        fs: createFakeFs({
          ...healthyFiles(),
          [`${HOME}/.agentproto/llm-endpoints.json`]: JSON.stringify({
            endpoints: [{ id: "bonsai", kind: "openai", baseUrl: "http://192.168.1.20:8081/v1", connector: "lmstudio" }],
          }),
        }),
        fetch: (async (url: string | URL) => {
          if (String(url).endsWith("/api/v0/models")) {
            return new Response(
              JSON.stringify({ data: [{ id: "a", state: "not-loaded" }, { id: "b", state: "not-loaded" }] }),
              { status: 200 },
            )
          }
          return new Response(JSON.stringify({ data: [] }), { status: 200 })
        }) as typeof fetch,
      }),
    )
    expect(byId(checks, "local-models.bonsai")).toMatchObject({
      status: "ok",
      detail: "http://192.168.1.20:8081/v1 reachable — 2 models, none loaded",
    })
  })

  it("plan() proposes running detect when an undetected runtime was found", async () => {
    const ctx = createFakeContext()
    const undetectedCheck = {
      id: "local-models.undetected.lmstudio",
      title: "Undetected local model server (LM Studio)",
      status: "warn" as const,
      detail: "LM Studio is running at http://127.0.0.1:1234/v1 but not yet a configured endpoint",
    }
    const actions = await localModelsStep.plan!([undetectedCheck], ctx, new Map())
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ id: "local-models.detect", default: true })

    const { io, calls } = createFakeSetup(ctx)
    const result = await actions[0]!.apply(io)
    expect(calls).toEqual(["llm endpoints detect", "llm endpoints sync-pi"])
    expect(result.ok).toBe(true)
  })

  it("apply()'s pi sync failing is non-fatal — detect itself already succeeded", async () => {
    const ctx = createFakeContext()
    const undetectedCheck = {
      id: "local-models.undetected.lmstudio",
      title: "Undetected local model server (LM Studio)",
      status: "warn" as const,
      detail: "LM Studio is running at http://127.0.0.1:1234/v1 but not yet a configured endpoint",
    }
    const actions = await localModelsStep.plan!([undetectedCheck], ctx, new Map())
    const { io } = createFakeSetup(ctx, { codes: { "llm endpoints sync-pi": 1 } })
    const result = await actions[0]!.apply(io)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain("non-fatal")
  })

  it("plan() proposes nothing when the step is unsettled for a reason detect can't fix", async () => {
    const ctx = createFakeContext()
    const unreachableCheck = {
      id: "local-models.ollama",
      title: 'Endpoint "ollama"',
      status: "warn" as const,
      detail: "http://192.168.1.20:11434/v1 unreachable: ECONNREFUSED",
    }
    expect(await localModelsStep.plan!([unreachableCheck], ctx, new Map())).toEqual([])
  })

  it("detect() surfaces an undetected runtime even with nothing configured yet — otherwise setup would never offer to look", async () => {
    const checks = await localModelsStep.detect(
      createFakeContext({
        fetch: (async (url: string | URL) => {
          if (String(url) === "http://127.0.0.1:1234/api/v0/models") {
            return new Response(JSON.stringify({ data: [{ id: "m", state: "loaded" }] }), { status: 200 })
          }
          return Promise.reject(new Error("ECONNREFUSED"))
        }) as typeof fetch,
      }),
    )
    expect(checks).toEqual([
      {
        id: "local-models.undetected.lmstudio",
        title: "Undetected local model server (LM Studio)",
        status: "warn",
        detail: "LM Studio is running at http://127.0.0.1:1234/v1 but not yet a configured endpoint",
        fix: "agentproto llm endpoints detect",
        data: { connector: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" },
      },
    ])
  })

  it("an unreachable endpoint warns instead of failing the whole step", async () => {
    const checks = await localModelsStep.detect(
      createFakeContext({
        fs: createFakeFs({
          ...healthyFiles(),
          [`${HOME}/.agentproto/llm-endpoints.json`]: JSON.stringify({
            endpoints: [{ id: "ollama", kind: "openai", baseUrl: "http://192.168.1.20:11434/v1" }],
          }),
        }),
        fetch: (async () => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
      }),
    )
    expect(byId(checks, "local-models.ollama")).toMatchObject({ status: "warn" })
  })

  it("a malformed endpoints file is a broken check with a clear fix", async () => {
    const checks = await localModelsStep.detect(
      createFakeContext({
        fs: createFakeFs({
          ...healthyFiles(),
          [`${HOME}/.agentproto/llm-endpoints.json`]: "{ not json",
        }),
      }),
    )
    expect(byId(checks, "local-models.config")).toMatchObject({ status: "broken", fix: "agentproto llm endpoints list" })
  })
})

/** Routes `ctx.fetch` by path: `/health` always answers healthy (so
 *  `fetchHealth` inside the step resolves) while `/llm-endpoint/status`
 *  answers with whatever the test wants — the shared fake context's default
 *  fetch answers every path identically, which can't exercise the step's
 *  status-fetch independently of its health-fetch. */
function fetchRoutingLlmEndpointStatus(respond: () => Response): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes("/llm-endpoint/status")) return respond()
    return new Response(JSON.stringify({ version: "1.0.0", uptimeMs: 65_000, pid: 4242 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

describe("llm-gateway", () => {
  it("daemon unreachable is skipped, not broken", async () => {
    const checks = await llmGatewayStep.detect(createFakeContext({ health: null }))
    expect(checks).toHaveLength(1)
    expect(checks[0]?.status).toBe("skipped")
  })

  it("features.llmEndpoint off (404) is skipped with a fix hint, not missing/broken", async () => {
    const checks = await llmGatewayStep.detect(
      createFakeContext({ fetch: fetchRoutingLlmEndpointStatus(() => new Response("", { status: 404 })) }),
    )
    expect(byId(checks, "llm-gateway.status")).toMatchObject({ status: "skipped" })
    expect(byId(checks, "llm-gateway.status").fix).toMatch(/features\.llmEndpoint/)
  })

  it("an unrecognized 200 body (older/newer daemon) falls back to skipped, not broken", async () => {
    const checks = await llmGatewayStep.detect(createFakeContext())
    expect(byId(checks, "llm-gateway.status").status).toBe("skipped")
  })

  it("managed + healthy reports ok with the version and providers", async () => {
    const status = {
      running: true,
      pid: 4242,
      port: 18090,
      baseUrl: "http://127.0.0.1:18090",
      healthy: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "running",
      owner: "daemon",
      linksApplied: true,
      injectedProviders: ["anthropic"],
      version: "1.2.3",
    }
    const checks = await llmGatewayStep.detect(
      createFakeContext({
        fetch: fetchRoutingLlmEndpointStatus(() => new Response(JSON.stringify(status), { status: 200 })),
      }),
    )
    const c = byId(checks, "llm-gateway.status")
    expect(c.status).toBe("ok")
    expect(c.detail).toContain("managed")
    expect(c.detail).toContain("v1.2.3")
    expect(c.detail).toContain("anthropic")
    expect(c.data).toMatchObject({ owner: "daemon", port: 18090 })
  })

  it("adopted external process reports ok, distinguished from a daemon-managed one", async () => {
    const status = {
      running: true,
      pid: null,
      port: 18090,
      baseUrl: "http://127.0.0.1:18090",
      healthy: true,
      startedAt: null,
      status: "running",
      owner: "external",
      linksApplied: false,
    }
    const checks = await llmGatewayStep.detect(
      createFakeContext({
        fetch: fetchRoutingLlmEndpointStatus(() => new Response(JSON.stringify(status), { status: 200 })),
      }),
    )
    const c = byId(checks, "llm-gateway.status")
    expect(c.status).toBe("ok")
    expect(c.detail).toContain("external")
    expect(c.data).toMatchObject({ owner: "external" })
  })

  it("feature on but not running warns with a restart fix", async () => {
    const status = {
      running: false,
      pid: null,
      port: 18090,
      baseUrl: "http://127.0.0.1:18090",
      healthy: false,
      startedAt: null,
      status: "error",
      owner: "daemon",
      linksApplied: false,
      lastError: "llm-endpoint exited (code=1)",
    }
    const checks = await llmGatewayStep.detect(
      createFakeContext({
        fetch: fetchRoutingLlmEndpointStatus(() => new Response(JSON.stringify(status), { status: 200 })),
      }),
    )
    const c = byId(checks, "llm-gateway.status")
    expect(c.status).toBe("warn")
    expect(c.fix).toBe("agentproto llm gateway restart")
  })

  it("a 5xx from a live daemon is a broken check", async () => {
    const checks = await llmGatewayStep.detect(
      createFakeContext({ fetch: fetchRoutingLlmEndpointStatus(() => new Response("", { status: 500 })) }),
    )
    expect(byId(checks, "llm-gateway.status").status).toBe("broken")
  })
})
