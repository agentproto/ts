/**
 * Regression tests: `--help` / `-h` on every verb must print usage and
 * exit 0 — never throw a raw ERR_PARSE_ARGS_UNKNOWN_OPTION stack.
 *
 * Before the fix, `install`, `setup` and `run-swarm` called `parseArgs`
 * in strict mode without declaring a `help` option, so `--help` fell
 * through to an unhandled throw. An unknown flag must also produce a
 * readable CLI error (exit 2), not a stack trace.
 */

import { describe, it, expect, vi } from "vitest"

import { runInstall } from "../commands/install.js"
import { runSetupCommand } from "../commands/setup.js"
import { runRunSwarm } from "../commands/run-swarm.js"

describe("agentproto install --help", () => {
  for (const flag of ["--help", "-h"]) {
    it(`prints usage and exits 0 for ${flag}`, async () => {
      const writeSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true)
      const code = await runInstall([flag])
      expect(code).toBe(0)
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining("agentproto install")
      )
      writeSpy.mockRestore()
    })
  }

  it("exits 2 with a readable error on an unknown flag", async () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    const code = await runInstall(["--bogus"])
    expect(code).toBe(2)
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("agentproto install:")
    )
    writeSpy.mockRestore()
  })
})

describe("agentproto setup --help", () => {
  for (const flag of ["--help", "-h"]) {
    it(`prints usage and exits 0 for ${flag}`, async () => {
      const writeSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true)
      const code = await runSetupCommand([flag])
      expect(code).toBe(0)
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining("agentproto setup")
      )
      writeSpy.mockRestore()
    })
  }

  it("exits 2 with a readable error on an unknown flag", async () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    const code = await runSetupCommand(["--bogus"])
    expect(code).toBe(2)
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("agentproto setup:")
    )
    writeSpy.mockRestore()
  })
})

describe("agentproto run-swarm --help", () => {
  for (const flag of ["--help", "-h"]) {
    it(`prints usage and exits 0 for ${flag}`, async () => {
      const writeSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true)
      const code = await runRunSwarm([flag])
      expect(code).toBe(0)
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining("agentproto run-swarm")
      )
      writeSpy.mockRestore()
    })
  }

  it("exits 2 with a readable error on an unknown flag", async () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    const code = await runRunSwarm(["--bogus"])
    expect(code).toBe(2)
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("agentproto run-swarm:")
    )
    writeSpy.mockRestore()
  })
})
