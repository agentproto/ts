import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import type { AuthProviderHandle, FlowRunOptions } from "../types.js"
import { MemoryStore } from "../store/memory-store.js"

const promptAnswer = { value: "" }
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

// Matches what resolveStoreRef(auth.tokenStore, opts.server) computes for
// `provider` above: path = tokenStore.keychain, account = server (via the
// {server} template).
const ref = { path: "acme", account: "https://api.example" }

describe("patFlowEngine", () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
    promptAnswer.value = ""
  })

  const opts = (extra?: Partial<FlowRunOptions>): FlowRunOptions => ({
    server: "https://api.example",
    store,
    ...extra,
  })

  it("returns an existing stored token without prompting", async () => {
    await store.write(ref, { value: "gld_existing", kind: "pat" })
    const r = await patFlowEngine.run(provider, null, opts())
    expect(r).toEqual({ accessToken: "gld_existing", tokenKind: "pat" })
  })

  it("prompts for a token when none is cached", async () => {
    promptAnswer.value = "  gld_typed  "
    const r = await patFlowEngine.run(provider, null, opts())
    expect(r).toEqual({ accessToken: "gld_typed", tokenKind: "pat" })
  })

  it("persists the prompted token to the store", async () => {
    promptAnswer.value = "gld_new"
    await patFlowEngine.run(provider, null, opts())
    const stored = await store.read(ref)
    expect(stored).toEqual({ value: "gld_new", kind: "pat" })
  })

  it("rejects when the prompt yields nothing", async () => {
    promptAnswer.value = ""
    await expect(patFlowEngine.run(provider, null, opts())).rejects.toThrow(
      /no token provided/,
    )
  })

  it("ignores the cache when force is set (skips the read, then prompts)", async () => {
    await store.write(ref, { value: "gld_existing", kind: "pat" })
    promptAnswer.value = "gld_forced"
    const r = await patFlowEngine.run(provider, null, opts({ force: true }))
    expect(r).toEqual({ accessToken: "gld_forced", tokenKind: "pat" })
  })

  it("throws if invoked with a non-pat provider", async () => {
    const wrong = {
      ...provider,
      auth: { flow: "service-auth", tokenStore: { keychain: "k" } },
    } as AuthProviderHandle
    await expect(patFlowEngine.run(wrong, null, opts())).rejects.toThrow(
      /invoked with flow="service-auth"/,
    )
  })

  it("writes and reads through the audience-prefixed path when the provider declares one", async () => {
    const scoped = { ...provider, audience: "tunnel" } as AuthProviderHandle
    promptAnswer.value = "gld_scoped"
    await patFlowEngine.run(scoped, null, opts())

    // Written under the prefixed path, not the legacy one.
    await expect(store.read(ref)).resolves.toBeUndefined()
    await expect(
      store.read({ path: "tunnel:acme", account: "https://api.example" }),
    ).resolves.toEqual({ value: "gld_scoped", kind: "pat" })

    // Read back without prompting again.
    promptAnswer.value = ""
    const r = await patFlowEngine.run(scoped, null, opts())
    expect(r).toEqual({ accessToken: "gld_scoped", tokenKind: "pat" })
  })

  it("falls back once to the legacy unprefixed path for a pre-existing credential", async () => {
    // Simulate a credential written before this provider adopted an audience.
    await store.write(ref, { value: "gld_legacy", kind: "pat" })
    const scoped = { ...provider, audience: "tunnel" } as AuthProviderHandle

    const r = await patFlowEngine.run(scoped, null, opts())
    expect(r).toEqual({ accessToken: "gld_legacy", tokenKind: "pat" })
  })

  it("defaults to a KeychainStore when opts.store is omitted", async () => {
    // Off macOS the Keychain backend fails loudly rather than silently — this
    // asserts the default wiring reaches KeychainStore without needing a real
    // Keychain in CI.
    if (process.platform === "darwin") return
    await expect(
      patFlowEngine.run(provider, null, { server: "https://api.example" }),
    ).rejects.toThrow(/only supports macOS/)
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
  let store: MemoryStore
  let opts: FlowRunOptions

  beforeEach(() => {
    store = new MemoryStore()
    opts = { server: "https://api.example", store }
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

  // Let the engine attach its `data` listener (after the awaited store read)
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
    fake.emit("data", "\u0003") // Ctrl-C

    await expect(p).rejects.toThrow(/cancelled/)
    expect(fake.setRawMode).toHaveBeenCalledWith(false)
  })
})
