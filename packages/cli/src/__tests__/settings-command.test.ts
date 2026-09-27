/**
 * Smoke tests for the `agentproto settings` verb dispatch/usage surface
 * only — never the real `export`/`import` paths, which (unlike the fully
 * dependency-injected `../lib/settings-bundle.ts`, covered in
 * `settings-bundle.test.ts`) read/write the REAL `~/.agentproto/*` files via
 * their default deps. Exercising those here would touch whatever machine
 * runs the test suite.
 */
import { describe, it, expect, vi } from "vitest"
import { runSettings } from "../commands/settings.js"

describe("agentproto settings — usage surface", () => {
  for (const flag of ["--help", "-h"]) {
    it(`prints usage and exits 0 for ${flag}`, async () => {
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      try {
        const code = await runSettings([flag])
        expect(code).toBe(0)
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("agentproto settings"))
      } finally {
        spy.mockRestore()
      }
    })
  }

  it("prints usage and exits 2 with no arguments", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const code = await runSettings([])
      expect(code).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })

  it("exits 2 with a readable error on an unknown subcommand", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const code = await runSettings(["bogus"])
      expect(code).toBe(2)
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("agentproto settings:"))
    } finally {
      spy.mockRestore()
    }
  })

  it("documents every export/import flag it implements", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    let out = ""
    spy.mockImplementation(((chunk: string) => {
      out += String(chunk)
      return true
    }) as typeof process.stdout.write)
    try {
      await runSettings(["--help"])
    } finally {
      spy.mockRestore()
    }
    for (const flag of [
      "--out",
      "--include-secrets",
      "--passphrase-env",
      "--json",
      "--dry-run",
      "--yes",
      "--unseal-passphrase-env",
    ]) {
      expect(out).toContain(flag)
    }
  })
})
