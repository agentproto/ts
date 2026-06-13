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
} from "../token-store.js"

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
  beforeEach(() => vi.clearAllMocks())

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
  beforeEach(() => vi.clearAllMocks())

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

describe("platform guard", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")

  afterEach(() => {
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform)
  })

  function setPlatform(value: string) {
    Object.defineProperty(process, "platform", {
      value,
      configurable: true,
    })
  }

  it("throws a clear error on a non-macOS platform (read)", async () => {
    setPlatform("linux")
    await expect(readKeychainToken("svc", "acct")).rejects.toThrow(
      /only supports macOS/,
    )
  })

  it("throws a clear error on a non-macOS platform (write)", async () => {
    setPlatform("win32")
    await expect(writeKeychainToken("svc", "acct", "t")).rejects.toThrow(
      /only supports macOS/,
    )
  })

  it("does not guard the pure resolveAccount helper", () => {
    setPlatform("linux")
    expect(resolveAccount("{server}", "https://x")).toBe("https://x")
  })
})
