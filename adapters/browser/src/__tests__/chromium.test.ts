import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveCmd } from "../adapters/chromium.js"

// Guards the chromium adapter's launch-command resolution. The original bug was
// a wrong literal package name in the default pnpm filter
// (`@browser/service` instead of `@agstudio/browser-service`), which made
// `agentproto browser start chromium` silently never boot the service. These
// tests pin the default command string and the override precedence.
describe("chromium adapter resolveCmd", () => {
  let savedCmd: string | undefined
  let savedCwd: string | undefined

  beforeEach(() => {
    // Isolate from the host environment so the default-path assertion is stable.
    savedCmd = process.env.CHROMIUM_SERVE_CMD
    savedCwd = process.env.CHROMIUM_SERVE_CWD
    delete process.env.CHROMIUM_SERVE_CMD
    delete process.env.CHROMIUM_SERVE_CWD
  })

  afterEach(() => {
    if (savedCmd === undefined) delete process.env.CHROMIUM_SERVE_CMD
    else process.env.CHROMIUM_SERVE_CMD = savedCmd
    if (savedCwd === undefined) delete process.env.CHROMIUM_SERVE_CWD
    else process.env.CHROMIUM_SERVE_CWD = savedCwd
  })

  it("defaults to the @agstudio/browser-service pnpm filter", () => {
    const { file, args } = resolveCmd(undefined, undefined, undefined)
    expect(file).toBe("/bin/sh")
    expect(args[0]).toBe("-c")
    expect(args[1]).toBe("pnpm --filter=@agstudio/browser-service start")
  })

  it("prefers an explicit launchCmd over the default", () => {
    const { args } = resolveCmd("custom-launcher --port 3200", undefined, undefined)
    expect(args[1]).toBe("custom-launcher --port 3200")
  })

  it("falls back to CHROMIUM_SERVE_CMD from the caller env", () => {
    const { args } = resolveCmd(undefined, { CHROMIUM_SERVE_CMD: "env-launcher" }, undefined)
    expect(args[1]).toBe("env-launcher")
  })

  it("honours CHROMIUM_SERVE_CWD for the default command", () => {
    const { cwd } = resolveCmd(undefined, { CHROMIUM_SERVE_CWD: "/repo/root" }, undefined)
    expect(cwd).toBe("/repo/root")
  })
})
