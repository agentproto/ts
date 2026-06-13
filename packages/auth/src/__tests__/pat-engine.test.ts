import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import type { AuthProviderHandle, FlowRunOptions } from "../types.js"

const { readKeychainToken, promptAnswer } = vi.hoisted(() => ({
  readKeychainToken: vi.fn(),
  promptAnswer: { value: "" },
}))
vi.mock("../token-store.js", () => ({
  readKeychainToken,
  resolveAccount: (acct: string | undefined, server: string) =>
    acct ? acct.replace("{server}", server) : server,
}))
// Make the interactive prompt deterministic — no real stdin/TTY in tests.
vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(promptAnswer.value),
    close: () => {},
  }),
}))

import { patFlowEngine } from "../flow-engines/pat.js"

const provider = {
  id: "acme",
  description: "d",
  apiBase: "https://api.example",
  auth: { flow: "pat", tokenStore: { keychain: "acme", account: "{server}" } },
} as AuthProviderHandle

const opts: FlowRunOptions = { server: "https://api.example" }

describe("patFlowEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    promptAnswer.value = ""
  })

  it("returns an existing Keychain token without prompting", async () => {
    readKeychainToken.mockResolvedValue("gld_existing")
    const r = await patFlowEngine.run(provider, null, opts)
    expect(r).toEqual({ accessToken: "gld_existing", tokenKind: "pat" })
    expect(readKeychainToken).toHaveBeenCalledWith("acme", "https://api.example")
  })

  it("prompts for a token when none is cached", async () => {
    readKeychainToken.mockResolvedValue(undefined)
    promptAnswer.value = "  gld_typed  "
    const r = await patFlowEngine.run(provider, null, opts)
    expect(r).toEqual({ accessToken: "gld_typed", tokenKind: "pat" })
  })

  it("rejects when the prompt yields nothing", async () => {
    readKeychainToken.mockResolvedValue(undefined)
    promptAnswer.value = ""
    await expect(patFlowEngine.run(provider, null, opts)).rejects.toThrow(
      /no token provided/,
    )
  })

  it("ignores the cache when force is set (skips the read, then prompts)", async () => {
    readKeychainToken.mockResolvedValue("gld_existing")
    promptAnswer.value = "gld_forced"
    const r = await patFlowEngine.run(provider, null, { ...opts, force: true })
    expect(r).toEqual({ accessToken: "gld_forced", tokenKind: "pat" })
    expect(readKeychainToken).not.toHaveBeenCalled()
  })

  it("throws if invoked with a non-pat provider", async () => {
    const wrong = {
      ...provider,
      auth: { flow: "service-auth", tokenStore: { keychain: "k" } },
    } as AuthProviderHandle
    await expect(patFlowEngine.run(wrong, null, opts)).rejects.toThrow(
      /invoked with flow="service-auth"/,
    )
  })
})

/**
 * On a real terminal, promptToken drops to raw mode and masks input so the
 * personal access token never lands on screen / in scrollback. Simulate a TTY
 * stdin (EventEmitter + the tty method surface) and capture stderr to assert
 * the key is masked, edited, and that raw mode is entered and restored.
 */
class FakeTtyStdin extends EventEmitter {
  isTTY = true as const
  setRawMode = vi.fn()
  resume = vi.fn()
  pause = vi.fn()
  setEncoding = vi.fn()
}

describe("patFlowEngine — masked TTY entry", () => {
  let fake: FakeTtyStdin
  let origStdin: PropertyDescriptor | undefined
  let writes: string[]
  let errSpy: { mockRestore: () => void }

  beforeEach(() => {
    vi.clearAllMocks()
    readKeychainToken.mockResolvedValue(undefined)
    fake = new FakeTtyStdin()
    origStdin = Object.getOwnPropertyDescriptor(process, "stdin")
    Object.defineProperty(process, "stdin", { value: fake, configurable: true })
    writes = []
    errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((s: string | Uint8Array): boolean => {
        writes.push(String(s))
        return true
      })
  })

  afterEach(() => {
    errSpy.mockRestore()
    if (origStdin) Object.defineProperty(process, "stdin", origStdin)
  })

  // Let the engine attach its `data` listener (after the awaited Keychain read)
  // before we feed keystrokes.
  const tick = () => new Promise((r) => setImmediate(r))

  it("masks each character with '*' and never echoes the token", async () => {
    const p = patFlowEngine.run(provider, null, opts)
    await tick()
    fake.emit("data", "gld_")
    fake.emit("data", "secret")
    fake.emit("data", "\r")

    const r = await p
    expect(r).toEqual({ accessToken: "gld_secret", tokenKind: "pat" })

    const out = writes.join("")
    expect(out).not.toContain("gld_secret")
    expect((out.match(/\*/g) ?? []).length).toBe("gld_secret".length)
    expect(fake.setRawMode).toHaveBeenCalledWith(true)
    expect(fake.setRawMode).toHaveBeenCalledWith(false) // restored on exit
  })

  it("handles backspace by erasing the last masked character", async () => {
    const p = patFlowEngine.run(provider, null, opts)
    await tick()
    fake.emit("data", "abc")
    fake.emit("data", "\u007f") // delete the 'c'
    fake.emit("data", "X")
    fake.emit("data", "\n")

    expect((await p).accessToken).toBe("abX")
    expect(writes.join("")).toContain("\b \b") // terminal erase sequence
  })

  it("rejects on Ctrl-C and restores raw mode", async () => {
    const p = patFlowEngine.run(provider, null, opts)
    await tick()
    fake.emit("data", "\u0003")

    await expect(p).rejects.toThrow(/cancelled/)
    expect(fake.setRawMode).toHaveBeenCalledWith(false)
  })
})
