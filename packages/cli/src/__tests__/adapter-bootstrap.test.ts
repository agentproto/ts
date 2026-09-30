/**
 * Adapter-package bootstrap (`registry/adapter-bootstrap.ts`) — recap
 * point 5: `agentproto setup opencode` on a fresh machine used to die with
 * "can't find package '@agentproto/adapter-opencode'" because the verb
 * never installed the adapter package. The package-manager command here is
 * a FAKE (injected into `deps.npmSpawn`) — no network, no real spawn.
 */

import { describe, expect, it } from "vitest"
import {
  bootstrapAdapterPackage,
  isMissingAdapterPackageError,
  resolveAdapterWithBootstrap,
} from "../registry/adapter-bootstrap.js"

const CATALOG = [["opencode", "@agentproto/adapter-opencode"] as const]

function fakeNpm(code = 0) {
  const calls: string[][] = []
  const fn = (args: readonly string[]) => {
    calls.push([...args])
    return Promise.resolve(code)
  }
  return { calls, fn }
}

describe("isMissingAdapterPackageError", () => {
  it("gates to the genuinely-missing-package shape", () => {
    expect(
      isMissingAdapterPackageError(
        new Error(
          "agentproto: could not load adapter 'opencode'. Tried '@agentproto/adapter-opencode'."
        ),
        "opencode"
      )
    ).toBe(true)
    // installed but import-broken / mid-rebuild → NOT bootstrapable
    expect(
      isMissingAdapterPackageError(
        new Error(
          "agentproto: adapter '@agentproto/adapter-opencode' resolves on disk but could not be imported just now"
        ),
        "opencode"
      )
    ).toBe(false)
  })
})

describe("bootstrapAdapterPackage", () => {
  it("prints the exact npm command and runs the fake package manager", async () => {
    const { calls, fn } = fakeNpm()
    const lines: string[] = []
    const code = await bootstrapAdapterPackage("opencode", {
      deps: {
        catalog: CATALOG,
        npmSpawn: fn,
        stdout: { write: (c: string) => (lines.push(c), undefined) },
        stderr: { write: (c: string) => (lines.push(c), undefined) },
      },
    })
    expect(code).toBe(0)
    expect(calls).toEqual([["install", "-g", "@agentproto/adapter-opencode"]])
    expect(lines.join("")).toContain("npm i -g @agentproto/adapter-opencode")
  })

  it("dry-run prints what would run and runs nothing", async () => {
    const { calls, fn } = fakeNpm()
    const code = await bootstrapAdapterPackage("opencode", {
      dryRun: true,
      deps: { catalog: CATALOG, npmSpawn: fn },
    })
    expect(code).toBe(0)
    expect(calls).toEqual([])
  })

  it("surfaces the npm failure + manual path, keeping the exit code", async () => {
    const { fn } = fakeNpm(1)
    const errLines: string[] = []
    const code = await bootstrapAdapterPackage("opencode", {
      deps: {
        catalog: CATALOG,
        npmSpawn: fn,
        stderr: { write: (c: string) => (errLines.push(c), undefined) },
      },
    })
    expect(code).toBe(1)
    expect(errLines.join("")).toContain("Install it manually: npm i -g @agentproto/adapter-opencode")
  })

  it("refuses a slug the catalog doesn't know (no package name to guess)", async () => {
    const { calls, fn } = fakeNpm()
    const code = await bootstrapAdapterPackage("not-in-catalog", {
      deps: { catalog: [["opencode", "@agentproto/adapter-opencode"] as const], npmSpawn: fn },
    })
    expect(code).toBe(1)
    expect(calls).toEqual([])
  })
})

describe("resolveAdapterWithBootstrap", () => {
  it("auto-installs then re-resolves once the package is present", async () => {
    const { calls, fn } = fakeNpm()
    let resolutionMisses = 0
    const fakeResolve = () =>
      resolutionMisses++ === 0
        ? Promise.reject(
            new Error("agentproto: could not load adapter 'opencode'. Install it with: npm i -g @agentproto/adapter-opencode")
          )
        : Promise.resolve({ slug: "opencode", handle: { name: "opencode" } } as never)
    const res = await resolveAdapterWithBootstrap("opencode", {
      deps: { catalog: CATALOG, npmSpawn: fn, resolve: fakeResolve } as never,
    })
    expect(res.ok).toBe(true)
    expect(res.adapter?.slug).toBe("opencode")
    expect(calls).toEqual([["install", "-g", "@agentproto/adapter-opencode"]])
  })

  it("a failed install keeps the ORIGINAL resolveAdapter error (the clear 'Install it with' message)", async () => {
    const { fn } = fakeNpm(1)
    const original = new Error(
      "agentproto: could not load adapter 'opencode'. … Install it with: npm i -g @agentproto/adapter-opencode\n  cause: Cannot find package '@agentproto/adapter-opencode'"
    )
    const fakeResolve = () => Promise.reject(original)
    const res = await resolveAdapterWithBootstrap("opencode", {
      deps: { catalog: CATALOG, npmSpawn: fn, resolve: fakeResolve } as never,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe(original)
  })

  it("never bootstraps for an import-broken (present but unloadable) package", async () => {
    const { calls, fn } = fakeNpm()
    const bad = new Error(
      "agentproto: adapter '@agentproto/adapter-opencode' resolves on disk but could not be imported just now"
    )
    const fakeResolve = () => Promise.reject(bad)
    const res = await resolveAdapterWithBootstrap("opencode", {
      deps: { catalog: CATALOG, npmSpawn: fn, resolve: fakeResolve } as never,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe(bad)
    expect(calls).toEqual([])
  })
})
