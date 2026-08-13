/**
 * `runSetup` — the interactive-without-a-TTY refusal.
 *
 * An `interactive: true` cmd step attaches the child to this process's
 * stdio; without a TTY (daemon `adapter_install`, CI, `< /dev/null`) a
 * TUI there can only hang or die on its own defaults — the openclaw
 * incident: `onboard --install-daemon`'s confirm silently defaulted to
 * "No" and the install died as a bare exit 1. The engine must instead
 * refuse the step pre-spawn and return EXIT_SETUP_NEEDS_TTY so
 * programmatic hosts can offer a real terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentCliHandle } from "@agentproto/driver-agent-cli"

import { EXIT_SETUP_NEEDS_TTY, runSetup } from "../commands/setup.js"

let home: string
let hadTty: boolean | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentproto-setup-tty-"))
  vi.stubEnv("AGENTPROTO_HOME", home)
  hadTty = process.stdin.isTTY
})

afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process.stdin, "isTTY", { value: hadTty, configurable: true })
  rmSync(home, { recursive: true, force: true })
})

function setTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true })
}

function handleWith(steps: unknown[]): AgentCliHandle {
  return {
    name: "fake",
    id: "fake",
    description: "fake adapter for setup tests",
    version: "0.0.1",
    bin: "true",
    setup: steps,
  } as unknown as AgentCliHandle
}

describe("runSetup — interactive cmd steps without a TTY", () => {
  it("refuses the step pre-spawn and returns EXIT_SETUP_NEEDS_TTY", async () => {
    setTty(undefined)
    const code = await runSetup({
      slug: "fake",
      handle: handleWith([
        {
          id: "onboard",
          kind: "cmd",
          // Would exit 0 instantly if it ever ran — the refusal must win.
          cmd: "true",
          interactive: true,
        },
      ]),
    })
    expect(code).toBe(EXIT_SETUP_NEEDS_TTY)
  })

  it("still runs non-interactive cmd steps to completion", async () => {
    setTty(undefined)
    const code = await runSetup({
      slug: "fake",
      handle: handleWith([{ id: "probe", kind: "cmd", cmd: "true" }]),
    })
    expect(code).toBe(0)
  })

  it("keeps a plain failing step as a plain failure, not the TTY code", async () => {
    setTty(undefined)
    const code = await runSetup({
      slug: "fake",
      handle: handleWith([{ id: "probe", kind: "cmd", cmd: "false" }]),
    })
    expect(code).not.toBe(0)
    expect(code).not.toBe(EXIT_SETUP_NEEDS_TTY)
  })
})
