/**
 * Command construction + round-trip parse for the Windows DPAPI backend of
 * `token-store.ts` (recap D7). No real DPAPI, no real PowerShell: the fake
 * runner decodes the constructed scripts the way PowerShell would and fakes
 * the Protect/Unprotect byte step as identity.
 */

import { describe, it, expect } from "vitest"

import {
  buildDpapiDeleteCommand,
  buildDpapiReadCommand,
  buildDpapiWriteCommand,
  deleteDpapiToken,
  dpapiDir,
  dpapiFile,
  readDpapiToken,
  writeDpapiToken,
} from "../win-token-store.js"

const HOME = "/home/tester"

/** Pull the single-quoted base64 argument out of a `&$d('...')` occurrence. */
function b64Args(script: string): string[] {
  return [...script.matchAll(/&\$d\('([^']+)'\)/g)].map((m) =>
    Buffer.from(m[1] ?? "", "base64").toString("utf8"),
  )
}

describe("dpapi command construction", () => {
  it("write: powershell -NoProfile -NonInteractive, DPAPI Protect at CurrentUser scope", () => {
    const { cmd, args } = buildDpapiWriteCommand("agentproto-foo", "acct", "secret-token", { home: HOME })
    expect(cmd).toBe("powershell")
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"])
    const script = args[3]!;
    expect(script).toContain("ProtectedData]::Protect")
    expect(script).toContain("DataProtectionScope]::CurrentUser")
    expect(script).toContain("System.Security")
  })

  it("write: the token and the file path never appear in the clear", () => {
    const { args } = buildDpapiWriteCommand("svc-with spaces", "acc:ount", "plain", { home: HOME })
    const script = args[3]!;
    expect(script).not.toContain("plain'") // b64-wrapped, never a bare literal
    expect(script).not.toContain("svc-with spaces")
    const quoted = Array.from(script.matchAll(/'([A-Za-z0-9+/=]+)'/g)).map((m) => m[1])
    expect(Buffer.from(quoted.at(-1)!, "base64").toString("utf8")).toBe("plain")
  })

  it("write: the decoded path is the slot's .dpapi file under ~/.agentproto", () => {
    const { args } = buildDpapiWriteCommand("svc", "acct", "t", { home: HOME })
    const file = b64Args(args[3]!)[0]!
    expect(file).toContain("keychain-dpapi")
    expect(file.endsWith(".dpapi")).toBe(true)
    expect(file.startsWith(dpapiFile("svc", "acct", { home: HOME }))).toBe(true)
  })

  it("read: DPAPI Unprotect at CurrentUser scope, output on stdout", () => {
    const { cmd, args } = buildDpapiReadCommand("svc", "acct", { home: HOME })
    expect(cmd).toBe("powershell")
    const script = args[3]!;
    expect(script).toContain("ProtectedData]::Unprotect")
    expect(script).toContain("[Console]::Out.Write")
    expect(b64Args(script)[0]!).toContain("keychain-dpapi")
  })

  it("delete: Remove-Item guarded by Test-Path", () => {
    const script = buildDpapiDeleteCommand("svc", "acct", { home: HOME }).args[3]!
    expect(script).toContain("Test-Path -LiteralPath")
    expect(script).toContain("Remove-Item -LiteralPath")
    expect(b64Args(script)[0]!).toContain("keychain-dpapi")
  })

  it("distinct (service, account) pairs get distinct files; the same pair is stable", () => {
    expect(dpapiFile("a", "b", { home: HOME })).not.toBe(dpapiFile("a", "c", { home: HOME }))
    expect(dpapiFile("a", "b", { home: HOME })).toBe(dpapiFile("a", "b", { home: HOME }))
    expect(dpapiFile("a", "b", { home: "/other" })).toBe(joinOther(dpapiFile("a", "b", { home: HOME })))
  })
})

function joinOther(file: string): string {
  return file.replace(/^\/home\/tester/, "/other")
}

describe("dpapi round trip", () => {
  /** A fake PowerShell: decodes the scripts like the real one would, and
   *  fakes Protect/Unprotect as an identity over a byte-stable envelope
   *  (`ença!<base64>` marker — good enough to pin the parse order). */
  function fakePowerShell() {
    const files = new Map<string, string>()
    const run = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      const script = args[3] ?? ""
      const file = b64Args(script)[0]!!;
      if (script.includes("::Protect")) {
        const payload = script.match(/FromBase64String\('([^']+)'\)/)?.[1] ?? ""
        // The "encrypted" bytes: a marker + the raw payload bytes, base64'd.
        files.set(file, Buffer.from(`DPAPI!`, "utf8").toString("base64") + "." + payload)
        return { stdout: "" }
      }
      if (script.includes("::Unprotect")) {
        const stored = files.get(file)
        if (stored === undefined) throw new Error(`no file ${file}`)
        const payload = stored.split(".")[1] ?? ""
        // Real DPAPI gives raw bytes; PowerShell then encodes to the console.
        return { stdout: Buffer.from(payload, "base64").toString("utf8") }
      }
      if (script.includes("Remove-Item")) {
        const existed = files.delete(file)
        return { stdout: existed ? "1" : "0" }
      }
      throw new Error(`unexpected script: ${script.slice(0, 80)}`)
    }
    return { run, files }
  }

  it("write → read → delete round-trips the token", async () => {
    const ps = fakePowerShell()
    const deps = { home: HOME, run: ps.run }
    await writeDpapiToken("agentproto-aos", "acct", "tok_secret_1", deps)
    await expect(readDpapiToken("agentproto-aos", "acct", deps)).resolves.toBe("tok_secret_1")
    await expect(deleteDpapiToken("agentproto-aos", "acct", deps)).resolves.toBe(true)
    await expect(readDpapiToken("agentproto-aos", "acct", deps)).resolves.toBeUndefined()
    await expect(deleteDpapiToken("agentproto-aos", "acct", deps)).resolves.toBe(false)
  })

  it("read is undefined on a miss; write failure surfaces a clear error", async () => {
    const ps = fakePowerShell()
    const deps = { home: HOME, run: ps.run }
    await expect(readDpapiToken("nope", "x", deps)).resolves.toBeUndefined()
    await expect(writeDpapiToken("boom", "x", "t", { home: HOME, run: async () => { throw new Error("ps exploded") } })).rejects.toThrow(
      /Windows DPAPI credential store: ps exploded/,
    )
  })

  it("dpapiDir honours the injected home", () => {
    expect(dpapiDir({ home: HOME })).toBe(`${HOME}/.agentproto/keychain-dpapi`)
  })
})
