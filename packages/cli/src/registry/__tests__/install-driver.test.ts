import { describe, expect, it } from "vitest"
import {
  planAdapterInstall,
  parseNpmPackageFromHint,
  type AdapterInstallCandidate,
} from "../install-driver.js"

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

  it("marks an acp entry with no parseable package as unsupported", () => {
    const noHint: AdapterInstallCandidate = {
      slug: "byo-agent",
      status: "supported",
      source: "acp-config",
    }
    expect(planAdapterInstall(noHint).kind).toBe("unsupported")

    const brewHint: AdapterInstallCandidate = {
      slug: "brew-agent",
      status: "supported",
      source: "acp-catalog",
      hint: "brew install brew-agent",
    }
    expect(planAdapterInstall(brewHint).kind).toBe("unsupported")
  })

  it("drives `agentproto install <slug>` for a first-party (no source) adapter", () => {
    const supported: AdapterInstallCandidate = {
      slug: "opencode",
      status: "supported",
    }
    expect(planAdapterInstall(supported)).toEqual({
      kind: "agentproto-install",
      slug: "opencode",
      command: "agentproto",
      args: ["install", "opencode"],
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
