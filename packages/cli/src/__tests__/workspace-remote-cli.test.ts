/**
 * `agentproto workspace remote <set|show|unset>` — driven through the public
 * `runWorkspace` entrypoint with a temp HOME (workspaces.json resolves under
 * os.homedir()) and a spied keychain. Asserts the SECRETS-NOT-IN-ARGV
 * invariant: the git PAT only ever arrives on stdin and lands only in the
 * keychain, never in workspaces.json or on stdout/stderr.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KeychainStore } from "@agentproto/auth"
import { loadWorkspacesConfig } from "@agentproto/runtime/workspaces-config"

import { setSecretInputStream } from "../commands/auth.js"
import { runWorkspace } from "../commands/workspace.js"

const TOKEN = "ghp_FAKE_TOKEN_DO_NOT_LEAK_0001"
const URL = "https://github.com/acme/repo.git"

let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-ws-remote-cli-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function capture(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
    out.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
    err.push(String(chunk))
    return true
  })
  return { out, err }
}

function spyOnKeychain(): { writes: Array<{ path: string; value: string; kind: string }> } {
  const writes: Array<{ path: string; value: string; kind: string }> = []
  vi.spyOn(KeychainStore.prototype, "write").mockImplementation(async (ref, cred) => {
    writes.push({ path: ref.path, value: cred.value, kind: cred.kind })
  })
  return { writes }
}

async function withStdin(secret: string, fn: () => Promise<number>): Promise<number> {
  const fake = new PassThrough()
  setSecretInputStream(fake)
  try {
    fake.end(secret)
    return await fn()
  } finally {
    setSecretInputStream(undefined)
  }
}

async function registerWorkspace(slug = "agentproto"): Promise<void> {
  const io = capture()
  expect(await runWorkspace(["add", home, "--slug", slug])).toBe(0)
  io.out.length = 0
  vi.restoreAllMocks()
}

async function configText(): Promise<string> {
  return readFile(join(home, ".agentproto", "workspaces.json"), "utf8")
}

describe("workspace remote set", () => {
  it("records url/branch/credential-ref without touching the keychain", async () => {
    await registerWorkspace()
    const { writes } = spyOnKeychain()
    const { out } = capture()
    const code = await runWorkspace([
      "remote", "set", "agentproto", "--url", URL, "--branch", "develop", "--credential-ref", "my.slot",
    ])
    expect(code).toBe(0)
    expect(writes).toEqual([])
    const ws = (await loadWorkspacesConfig()).workspaces[0]!
    expect(ws.remote).toEqual({ url: URL, defaultBranch: "develop", credentialRef: "my.slot" })
    expect(out.join("")).toContain("agentproto remote")
  })

  it("--token-stdin stores the PAT in the keychain under agentproto.git.<slug> and records only the ref", async () => {
    await registerWorkspace()
    const { writes } = spyOnKeychain()
    const { out, err } = capture()
    const code = await withStdin(TOKEN + "\n", () =>
      runWorkspace(["remote", "set", "agentproto", "--url", URL, "--token-stdin"]),
    )
    expect(code).toBe(0)
    expect(writes).toEqual([{ path: "agentproto.git.agentproto", value: TOKEN, kind: "pat" }])
    const ws = (await loadWorkspacesConfig()).workspaces[0]!
    expect(ws.remote?.credentialRef).toBe("agentproto.git.agentproto")
    for (const text of [await configText(), out.join(""), err.join(""), process.argv.join(" ")]) {
      expect(text).not.toContain(TOKEN)
    }
  })

  it("REFUSES the token as an argv flag and never stores anything", async () => {
    await registerWorkspace()
    const { writes } = spyOnKeychain()
    const { err } = capture()
    const code = await runWorkspace(["remote", "set", "agentproto", "--url", URL, "--token", TOKEN])
    expect(code).toBe(2)
    expect(writes).toEqual([])
    expect((await loadWorkspacesConfig()).workspaces[0]!.remote).toBeUndefined()
    // The unknown-flag error may name the flag, but must not repeat its value.
    expect(err.join("")).not.toContain(TOKEN)
    expect(err.join("")).toContain("--token-stdin")
  })

  it("rejects --token-stdin together with --credential-ref", async () => {
    await registerWorkspace()
    const { writes } = spyOnKeychain()
    const { err } = capture()
    const code = await runWorkspace([
      "remote", "set", "agentproto", "--url", URL, "--token-stdin", "--credential-ref", "x",
    ])
    expect(code).toBe(2)
    expect(writes).toEqual([])
    expect(err.join("")).toContain("mutually exclusive")
  })

  it("validates the URL before reading stdin or writing the keychain", async () => {
    await registerWorkspace()
    const { writes } = spyOnKeychain()
    const { err } = capture()
    const code = await withStdin(TOKEN, () =>
      runWorkspace(["remote", "set", "agentproto", "--url", "http://github.com/acme/repo.git", "--token-stdin"]),
    )
    expect(code).toBe(2)
    expect(writes).toEqual([])
    expect(err.join("")).toContain("https")
  })

  it("rejects an https URL with embedded credentials without echoing them", async () => {
    await registerWorkspace()
    spyOnKeychain()
    const { err } = capture()
    const code = await runWorkspace([
      "remote", "set", "agentproto", "--url", `https://x-access-token:${TOKEN}@github.com/acme/repo.git`,
    ])
    expect(code).toBe(2)
    expect(err.join("")).not.toContain(TOKEN)
  })

  it("rejects an empty stdin token and an unknown workspace", async () => {
    await registerWorkspace()
    const { writes } = spyOnKeychain()
    const { err } = capture()
    expect(await withStdin("  \n", () => runWorkspace(["remote", "set", "agentproto", "--url", URL, "--token-stdin"]))).toBe(2)
    expect(writes).toEqual([])
    expect(await runWorkspace(["remote", "set", "ghost", "--url", URL])).toBe(2)
    expect(err.join("")).toContain("no workspace named")
  })

  it("re-running set without --branch/--credential-ref keeps the prior values", async () => {
    await registerWorkspace()
    capture()
    await runWorkspace(["remote", "set", "agentproto", "--url", URL, "--branch", "develop", "--credential-ref", "my.slot"])
    await runWorkspace(["remote", "set", "agentproto", "--url", "https://github.com/acme/other.git"])
    expect((await loadWorkspacesConfig()).workspaces[0]!.remote).toEqual({
      url: "https://github.com/acme/other.git",
      defaultBranch: "develop",
      credentialRef: "my.slot",
    })
  })
})

describe("workspace remote show / unset", () => {
  it("show prints the remote (json and text) and exits 1 when unset", async () => {
    await registerWorkspace()
    const io = capture()
    expect(await runWorkspace(["remote", "show", "agentproto"])).toBe(1)
    expect(io.out.join("")).toContain("no remote set")
    io.out.length = 0
    await runWorkspace(["remote", "set", "agentproto", "--url", URL, "--credential-ref", "my.slot"])
    io.out.length = 0
    expect(await runWorkspace(["remote", "show", "agentproto", "--json"])).toBe(0)
    expect(JSON.parse(io.out.join(""))).toEqual({ url: URL, credentialRef: "my.slot" })
    io.out.length = 0
    expect(await runWorkspace(["remote", "show", "agentproto"])).toBe(0)
    expect(io.out.join("")).toContain("main (default)")
  })

  it("unset drops the remote and leaves the keychain alone", async () => {
    await registerWorkspace()
    const { writes } = spyOnKeychain()
    capture()
    await withStdin(TOKEN, () => runWorkspace(["remote", "set", "agentproto", "--url", URL, "--token-stdin"]))
    const del = vi.spyOn(KeychainStore.prototype, "delete")
    expect(await runWorkspace(["remote", "unset", "agentproto"])).toBe(0)
    expect(del).not.toHaveBeenCalled()
    expect(writes).toHaveLength(1)
    expect((await loadWorkspacesConfig()).workspaces[0]!.remote).toBeUndefined()
  })

  it("an unknown action prints usage and exits 2", async () => {
    const { err } = capture()
    expect(await runWorkspace(["remote", "frobnicate"])).toBe(2)
    expect(err.join("")).toContain("unknown action")
  })
})
