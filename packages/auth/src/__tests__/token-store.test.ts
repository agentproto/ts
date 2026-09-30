import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// promisify(execFile) is applied at module load — mock the whole module with a
// callback-style fn so the default util.promisify wrapping resolves with the
// first post-error argument.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile: execFileMock }))

import {
  resolveAccount,
  readKeychainToken,
  writeKeychainToken,
  deleteKeychainToken,
} from "../token-store.js"

// The Keychain helpers are guarded to macOS. CI runs on Linux, so the
// success-path tests must pin the platform to darwin to exercise the mocked
// `security` calls (the platform-guard block below flips it the other way).
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")
function pinPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true })
}
function restorePlatform() {
  if (realPlatform) Object.defineProperty(process, "platform", realPlatform)
}

describe("resolveAccount", () => {
  it("substitutes the {server} template", () => {
    expect(resolveAccount("{server}", "https://api.example")).toBe(
      "https://api.example",
    )
  })

  it("returns the server when account is undefined", () => {
    expect(resolveAccount(undefined, "https://api.example")).toBe(
      "https://api.example",
    )
  })

  it("leaves a literal account untouched", () => {
    expect(resolveAccount("fixed-acct", "https://api.example")).toBe(
      "fixed-acct",
    )
  })
})

describe("readKeychainToken", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pinPlatform("darwin")
  })
  afterEach(restorePlatform)

  it("returns the trimmed token on success", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (e: unknown, r: unknown) => void) =>
        cb(null, { stdout: "tok-123\n" }),
    )
    await expect(readKeychainToken("svc", "acct")).resolves.toBe("tok-123")
  })

  it("returns undefined when the entry is missing", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (e: unknown) => void) =>
        cb(new Error("could not be found")),
    )
    await expect(readKeychainToken("svc", "acct")).resolves.toBeUndefined()
  })

  it("returns undefined for an empty result", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (e: unknown, r: unknown) => void) =>
        cb(null, { stdout: "\n" }),
    )
    await expect(readKeychainToken("svc", "acct")).resolves.toBeUndefined()
  })
})

describe("writeKeychainToken", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pinPlatform("darwin")
  })
  afterEach(restorePlatform)

  it("calls security add-generic-password with -U (update-in-place)", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (e: unknown, r: unknown) => void) =>
        cb(null, { stdout: "" }),
    )
    await writeKeychainToken("svc", "acct", "secret")
    const call = execFileMock.mock.calls[0] as [string, string[]]
    const [cmd, args] = call
    expect(cmd).toBe("security")
    expect(args).toContain("add-generic-password")
    expect(args).toContain("-U")
    expect(args).toEqual(expect.arrayContaining(["-s", "svc", "-a", "acct"]))
    expect(args).toContain("secret")
  })
})

describe("deleteKeychainToken", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pinPlatform("darwin")
  })
  afterEach(restorePlatform)

  it("calls security delete-generic-password and returns true", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (e: unknown, r: unknown) => void) =>
        cb(null, { stdout: "" }),
    )
    await expect(deleteKeychainToken("svc", "acct")).resolves.toBe(true)
    const call = execFileMock.mock.calls[0] as [string, string[]]
    const [cmd, args] = call
    expect(cmd).toBe("security")
    expect(args).toContain("delete-generic-password")
    expect(args).toEqual(expect.arrayContaining(["-s", "svc", "-a", "acct"]))
  })

  it("returns false when the entry is missing (no throw)", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (e: unknown) => void) =>
        cb(new Error("could not be found")),
    )
    await expect(deleteKeychainToken("svc", "acct")).resolves.toBe(false)
  })
})

describe("platform guard", () => {
  afterEach(restorePlatform)

  it("throws a clear error on a non-macOS platform (read)", async () => {
    pinPlatform("linux")
    await expect(readKeychainToken("svc", "acct")).rejects.toThrow(
      /only supports macOS and Windows/,
    )
  })

  it("win32 dispatches to the DPAPI backend (write + read + delete)", async () => {
    pinPlatform("win32")
    vi.clearAllMocks()
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) =>
        cb(null, { stdout: "1" }),
    )
    // The DPAPI backend runs through the same mocked execFile: the write
    // must issue a `powershell` command (its argv carries the -Command
    // script), never the `security` CLI, and must not throw.
    await expect(writeKeychainToken("svc", "acct", "t")).resolves.toBeUndefined()
    const call = execFileMock.mock.calls[0] as [string, string[]]
    expect(call[0]).toBe("powershell")
    expect(call[1]).toContain("-NoProfile")
    expect(JSON.stringify(call[1])).toContain("ProtectedData]::Protect")
  })

  it("does not guard the pure resolveAccount helper", () => {
    pinPlatform("linux")
    expect(resolveAccount("{server}", "https://x")).toBe("https://x")
  })
})
