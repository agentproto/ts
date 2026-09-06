import { describe, expect, it, vi } from "vitest"
import {
  installAdapter,
  planAdapterInstall,
  parseNpmPackageFromHint,
  parseShellHint,
  type AdapterInstallCandidate,
} from "../install-driver.js"

vi.mock("../resolve.js", () => ({
  listAdaptersWithAcp: vi.fn(async () => [
    { slug: "antigravity", status: "supported" },
  ]),
}))
vi.mock("../../commands/install.js", () => ({
  runInstall: vi.fn(async () => 0),
}))
import { runInstall } from "../../commands/install.js"

// ── parseNpmPackageFromHint ─────────────────────────────────────────────

describe("parseNpmPackageFromHint", () => {
  it("extracts a scoped package from an `npm install -g` hint", () => {
    expect(parseNpmPackageFromHint("npm install -g @google/gemini-cli")).toBe(
      "@google/gemini-cli",
    )
  })

  it("accepts the `npm i -g` and `--global` spellings", () => {
    expect(parseNpmPackageFromHint("npm i -g @qwen-code/qwen-code")).toBe(
      "@qwen-code/qwen-code",
    )
    expect(parseNpmPackageFromHint("npm install --global foo-cli")).toBe(
      "foo-cli",
    )
  })

  it("returns undefined for a non-npm-global hint or missing hint", () => {
    expect(parseNpmPackageFromHint("brew install gemini")).toBeUndefined()
    expect(parseNpmPackageFromHint("npm install foo")).toBeUndefined() // no -g
    expect(parseNpmPackageFromHint(undefined)).toBeUndefined()
    expect(parseNpmPackageFromHint("")).toBeUndefined()
  })
})

// ── parseShellHint ────────────────────────────────────────────────────────

describe("parseShellHint", () => {
  it("parses a uv tool install hint", () => {
    expect(parseShellHint("uv tool install mistral-vibe")).toEqual({
      command: "uv",
      args: ["tool", "install", "mistral-vibe"],
    })
  })

  it("parses a uv hint with extra flags", () => {
    expect(
      parseShellHint("uv tool install --python 3.13 kimi-cli"),
    ).toEqual({
      command: "uv",
      args: ["tool", "install", "--python", "3.13", "kimi-cli"],
    })
  })

  it("parses brew, pip, pipx, cargo, go", () => {
    expect(parseShellHint("brew install foo")?.command).toBe("brew")
    expect(parseShellHint("pip install foo-cli")?.command).toBe("pip")
    expect(parseShellHint("pip3 install foo-cli")?.command).toBe("pip3")
    expect(parseShellHint("pipx install foo-cli")?.command).toBe("pipx")
    expect(parseShellHint("cargo install foo-cli")?.command).toBe("cargo")
    expect(parseShellHint("go install example.com/foo@latest")?.command).toBe(
      "go",
    )
  })

  it("returns undefined for unknown commands and empty/missing hints", () => {
    expect(parseShellHint("curl -sSL https://install.sh | sh")).toBeUndefined()
    expect(parseShellHint("npm install -g foo")).toBeUndefined()
    expect(parseShellHint(undefined)).toBeUndefined()
    expect(parseShellHint("")).toBeUndefined()
  })
})

// ── planAdapterInstall: which install command per adapter class ─────────

describe("planAdapterInstall", () => {
  it("reports already-installed for a ready adapter (any class)", () => {
    const entry: AdapterInstallCandidate = {
      slug: "claude-code",
      status: "ready",
    }
    expect(planAdapterInstall(entry)).toEqual({ kind: "already-installed" })
  })

  it("ready wins even for an acp-catalog entry", () => {
    const entry: AdapterInstallCandidate = {
      slug: "gemini-cli",
      status: "ready",
      source: "acp-catalog",
      hint: "npm install -g @google/gemini-cli",
    }
    expect(planAdapterInstall(entry).kind).toBe("already-installed")
  })

  it("plans an npm-global install for an acp-catalog adapter", () => {
    const entry: AdapterInstallCandidate = {
      slug: "gemini-cli",
      status: "supported",
      source: "acp-catalog",
      hint: "npm install -g @google/gemini-cli",
    }
    expect(planAdapterInstall(entry)).toEqual({
      kind: "npm-global",
      packageName: "@google/gemini-cli",
      command: "npm",
      args: ["install", "-g", "@google/gemini-cli"],
    })
  })

  it("plans an npm-global install for a user acp-config adapter with a hint", () => {
    const entry: AdapterInstallCandidate = {
      slug: "my-acp",
      status: "supported",
      source: "acp-config",
      hint: "npm i -g my-acp-cli",
    }
    const plan = planAdapterInstall(entry)
    expect(plan.kind).toBe("npm-global")
    if (plan.kind === "npm-global") expect(plan.packageName).toBe("my-acp-cli")
  })

  it("plans a shell-hint install for a uv/brew/pip hint", () => {
    const uvHint: AdapterInstallCandidate = {
      slug: "mistral-vibe",
      status: "supported",
      source: "acp-catalog",
      hint: "uv tool install mistral-vibe",
    }
    expect(planAdapterInstall(uvHint)).toEqual({
      kind: "shell-hint",
      command: "uv",
      args: ["tool", "install", "mistral-vibe"],
    })

    const brewHint: AdapterInstallCandidate = {
      slug: "brew-agent",
      status: "supported",
      source: "acp-catalog",
      hint: "brew install brew-agent",
    }
    expect(planAdapterInstall(brewHint)).toEqual({
      kind: "shell-hint",
      command: "brew",
      args: ["install", "brew-agent"],
    })
  })

  it("handles kimi-cli's uv hint with --python flag", () => {
    const entry: AdapterInstallCandidate = {
      slug: "kimi-cli",
      status: "supported",
      source: "acp-catalog",
      hint: "uv tool install --python 3.13 kimi-cli",
    }
    expect(planAdapterInstall(entry)).toEqual({
      kind: "shell-hint",
      command: "uv",
      args: ["tool", "install", "--python", "3.13", "kimi-cli"],
    })
  })

  it("marks an acp entry with no hint or unrecognized command as unsupported", () => {
    const noHint: AdapterInstallCandidate = {
      slug: "byo-agent",
      status: "supported",
      source: "acp-config",
    }
    expect(planAdapterInstall(noHint).kind).toBe("unsupported")

    const curlHint: AdapterInstallCandidate = {
      slug: "curl-agent",
      status: "supported",
      source: "acp-catalog",
      hint: "curl -sSL https://install.sh | sh",
    }
    expect(planAdapterInstall(curlHint).kind).toBe("unsupported")
  })

  it("drives `agentproto install <slug> --allow-unverified` for a first-party (no source) adapter", () => {
    // The flag is deliberate: adapter_install is an explicit request to
    // install a cataloged manifest, and the TTY-less daemon would otherwise
    // refuse every curl/download-method adapter (see planAdapterInstall).
    const supported: AdapterInstallCandidate = {
      slug: "opencode",
      status: "supported",
    }
    expect(planAdapterInstall(supported)).toEqual({
      kind: "agentproto-install",
      slug: "opencode",
      command: "agentproto",
      args: ["install", "opencode", "--allow-unverified"],
    })
  })

  it("still drives the manifest pipeline for an installed-but-not-ready native adapter", () => {
    // "available" = package resolves but setup/auth pending — an idempotent
    // re-run through the same pipeline is the right move.
    const available: AdapterInstallCandidate = {
      slug: "claude-code",
      status: "available",
    }
    expect(planAdapterInstall(available).kind).toBe("agentproto-install")
  })
})

// ── installAdapter: the plan → runInstall seam ──────────────────────────

describe("installAdapter", () => {
  it("passes runInstall the args AFTER the verb (slug first)", async () => {
    // Regression: plan.args keeps the leading "install" for command logging,
    // but runInstall IS the install verb — handing it the verb made it
    // resolve an adapter literally named "install" and fail with exit 1 for
    // every first-party daemon/UI install.
    const result = await installAdapter("antigravity")
    expect(vi.mocked(runInstall)).toHaveBeenCalledWith([
      "antigravity",
      "--allow-unverified",
    ])
    expect(result.ok).toBe(true)
    expect(result.command).toBe(
      "agentproto install antigravity --allow-unverified",
    )
  })
})
