/**
 * `registry/install-source` — the published-vs-workspace classification shared
 * by `serve`'s `/health` build.source, `daemon install`'s captured-service
 * report, and the onboarding preflight step.
 */

import { describe, it, expect } from "vitest"
import {
  cliInstallSource,
  describeNodeInstall,
  renderServiceTarget,
} from "../registry/install-source.js"

describe("cliInstallSource", () => {
  it("a global npm install is published", () => {
    expect(cliInstallSource("/usr/local/lib/node_modules/@agentproto/cli/dist/cli.mjs")).toBe("published")
  })

  it("an nvm global install is published", () => {
    expect(
      cliInstallSource("/Users/x/.nvm/versions/node/v22.22.0/lib/node_modules/@agentproto/cli/dist/cli.mjs"),
    ).toBe("published")
  })

  it("an npx cache entry is published", () => {
    expect(cliInstallSource("/Users/x/.npm/_npx/abc123/node_modules/@agentproto/cli/dist/cli.mjs")).toBe("published")
  })

  it("a workspace/monorepo dist is a workspace build", () => {
    expect(cliInstallSource("/code/agentproto/packages/cli/dist/cli.mjs")).toBe("workspace")
  })

  it("a pnpm-linked node_modules/.bin entry is published", () => {
    // The .bin shim itself is a symlink; the resolved entry is what matters,
    // and a real resolved entry under node_modules is published.
    expect(cliInstallSource("/repo/node_modules/@agentproto/cli/dist/cli.mjs")).toBe("published")
  })

  it("a missing entry is unknown", () => {
    expect(cliInstallSource(null)).toBe("unknown")
    expect(cliInstallSource(undefined)).toBe("unknown")
    expect(cliInstallSource("")).toBe("unknown")
  })
})

describe("describeNodeInstall", () => {
  it("labels an nvm node and derives its prefix (POSIX)", () => {
    expect(describeNodeInstall("/Users/x/.nvm/versions/node/v22.22.0/bin/node", "darwin")).toEqual({
      kind: "nvm",
      prefix: "/Users/x/.nvm/versions/node/v22.22.0",
    })
  })

  it("labels an fnm node", () => {
    expect(describeNodeInstall("/Users/x/.fnm/node-versions/v22/bin/node", "darwin").kind).toBe("fnm")
  })

  it("labels homebrew and system nodes", () => {
    expect(describeNodeInstall("/opt/homebrew/bin/node", "darwin")).toEqual({
      kind: "homebrew",
      prefix: "/opt/homebrew",
    })
    expect(describeNodeInstall("/usr/bin/node", "linux")).toEqual({ kind: "system", prefix: "/usr" })
  })

  it("derives the prefix on win32", () => {
    expect(describeNodeInstall("C:\\Program Files\\nodejs\\node.exe", "win32")).toEqual({
      kind: "system",
      prefix: "C:\\Program Files\\nodejs",
    })
  })
})

describe("renderServiceTarget", () => {
  it("a published entry says so and does not warn", () => {
    const out = renderServiceTarget(
      "/Users/x/.nvm/versions/node/v22.22.0/bin/node",
      "/Users/x/.nvm/versions/node/v22.22.0/lib/node_modules/@agentproto/cli/dist/cli.mjs",
      "darwin",
    )
    expect(out).toContain("published npm install")
    expect(out).toContain("(nvm, global prefix /Users/x/.nvm/versions/node/v22.22.0)")
    expect(out).not.toContain("LOCAL FOLDER")
  })

  it("a workspace entry warns loudly with the npm fix", () => {
    const out = renderServiceTarget(
      "/usr/local/bin/node",
      "/code/agentproto/packages/cli/dist/cli.mjs",
      "darwin",
    )
    expect(out).toContain("workspace build (LOCAL FOLDER")
    expect(out).toContain("npm i -g @agentproto/cli@latest")
  })
})
