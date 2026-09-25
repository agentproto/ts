/**
 * Each onboarding step against a fake StepContext: the happy path and every
 * failure branch.
 */

import { describe, it, expect } from "vitest"
import { preflightStep } from "./steps/preflight.js"
import { workspaceStep } from "./steps/workspace.js"
import { daemonStep } from "./steps/daemon.js"
import { agentsStep } from "./steps/agents.js"
import { authStep } from "./steps/auth.js"
import { clientsStep } from "./steps/clients.js"
import { skillsStep } from "./steps/skills.js"
import { ONBOARDING_STEPS } from "./registry.js"
import { runChecks } from "./run.js"
import type { StepCheck } from "./types.js"
import { HOME, createFakeContext, createFakeFs, healthyFiles } from "./__fixtures__/fake-context.js"

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
    expect(reports.map((r) => r.id)).toEqual(["preflight", "workspace", "daemon", "agents", "auth", "clients", "skills"])
  })

  it("detect is read-only: zero fs writes after a full run", async () => {
    const ctx = createFakeContext()
    await runChecks(ONBOARDING_STEPS, ctx)
    expect(ctx.fs.writes).toEqual([])
    // Only read-only probes were spawned.
    for (const call of ctx.execCalls) expect(call).toMatch(/^(launchctl print |bash -lc probe-)/)
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
