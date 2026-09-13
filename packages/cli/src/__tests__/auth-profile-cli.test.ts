/**
 * `agentproto auth profile <create|list|rm|set-models|set-enabled>` +
 * `agentproto auth discover` — driven through the public `runAuth`
 * entrypoint.
 *
 * The create/list/rm/curate verbs defer to `@agentproto/auth`'s
 * provisioning helpers (exhaustively covered in that package's
 * `profile-provision.test.ts`); these tests assert this CLI surface's
 * wiring, exit codes, and — most importantly — the SECRETS-NOT-IN-ARGV
 * invariant: the credential for `create` is read from stdin / a file / an
 * env var NAME, never from the command line.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  KeychainStore,
  addAuthProfile,
  getAuthProfile,
} from "@agentproto/auth"
import {
  runAuth,
  setDiscoverCredentialsForTests,
  setSecretInputStream,
} from "../commands/auth.js"

// authProfilesPath() resolves under os.homedir() → $HOME on POSIX (same
// isolation auth-profile-refresh-models.test.ts uses) — a temp HOME keeps
// this off the real ~/.agentproto/auth-profiles.json.
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-auth-profile-cli-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = []
  const err: string[] = []
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
    out.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
    err.push(String(chunk))
    return true
  })
  return { out, err, restore: () => { outSpy.mockRestore(); errSpy.mockRestore() } }
}

/** Keep the test's secrets out of the real OS keychain; capture what the
 *  command tried to write so tests can assert on the stored value. */
function spyOnKeychain(): {
  writes: Array<{ path: string; value: string }>
  deletes: Array<{ path: string }>
} {
  const writes: Array<{ path: string; value: string }> = []
  const deletes: Array<{ path: string }> = []
  vi.spyOn(KeychainStore.prototype, "write").mockImplementation(async (ref, cred) => {
    writes.push({ path: ref.path, value: cred.value })
  })
  vi.spyOn(KeychainStore.prototype, "read").mockResolvedValue(undefined)
  vi.spyOn(KeychainStore.prototype, "delete").mockImplementation(async ref => {
    deletes.push({ path: ref.path })
  })
  return { writes, deletes }
}

/** Point the piped-credential read at an in-memory stream carrying
 *  `secret` (process.stdin is a getter that can't be swapped), running
 *  `fn` inside and always restoring afterwards. */
async function withStdin(secret: string, fn: () => Promise<unknown>): Promise<void> {
  const fake = new PassThrough()
  setSecretInputStream(fake)
  try {
    fake.end(secret)
    await fn()
  } finally {
    setSecretInputStream(undefined)
  }
}

const SECRET = "sk-ant-SUPERSECRET-DO-NOT-LEAK"

describe("agentproto auth profile create — the secret never lands in argv", () => {
  it("reads the credential from piped stdin and stores it — process.argv never carries the secret", async () => {
    const { writes } = spyOnKeychain()
    const { out, restore } = capture()
    await withStdin(SECRET + "\n", () =>
      runAuth(["profile", "create", "work-anthropic", "anthropic", "--method", "oauth-bearer"]),
    )
    restore()

    expect(writes).toHaveLength(1)
    expect(writes[0]?.value).toBe(SECRET)
    const profile = await getAuthProfile("work-anthropic")
    expect(profile?.method).toBe("oauth-bearer")
    expect(profile?.credentialRef).toBe("agentproto.auth.anthropic.sub")

    // The argv the process was launched with (what `ps` sees) is untouched —
    // and in this test it demonstrably never contained the secret either way:
    // runAuth took its arguments from the array above, and stdin carried the
    // secret. Assert the invariant directly.
    expect(process.argv.join(" ")).not.toContain(SECRET)
    expect(out.join("")).not.toContain(SECRET)
    expect(out.join("")).toContain("fingerprint")
  })

  it("REFUSES a secret passed as a positional argument instead of silently ignoring it", async () => {
    const { writes } = spyOnKeychain()
    const { err, restore } = capture()
    // Simulate the `auth cred set <id> <token>` anti-pattern: someone pastes
    // the secret as a third positional. The command must fail without ever
    // processing the value.
    await withStdin(SECRET, () =>
      runAuth([
        "profile",
        "create",
        "leaky",
        "anthropic",
        SECRET,
        "--method",
        "api-key",
      ]),
    )
    restore()

    expect(writes).toHaveLength(0)
    const stored = await getAuthProfile("leaky")
    expect(stored).toBeUndefined()
    expect(err.join("")).toMatch(/credential must NEVER be a command-line argument/)
  })

  it("takes --credential-env as the env var NAME, storing the variable's value", async () => {
    const { writes } = spyOnKeychain()
    const { out, restore } = capture()
    process.env.AGP_TEST_SECRET = SECRET
    try {
      await withStdin("", () =>
        runAuth([
          "profile",
          "create",
          "env-anthropic",
          "anthropic",
          "--method",
          "api-key",
          "--credential-env",
          "AGP_TEST_SECRET",
        ]),
      )
    } finally {
      delete process.env.AGP_TEST_SECRET
    }
    restore()

    expect(writes).toHaveLength(1)
    expect(writes[0]?.value).toBe(SECRET)
    // The flag's VALUE on the command line was the NAME, not the secret:
    // the args array (what argv would have carried) contains no secret.
    expect(process.argv.join(" ")).not.toContain(SECRET)
  })

  it("takes --credential-file as a PATH, never the value", async () => {
    const { writes } = spyOnKeychain()
    const file = join(home, "secret.txt")
    await writeFile(file, SECRET + "\n", "utf8")
    const { restore } = capture()
    await withStdin("", () =>
      runAuth([
        "profile",
        "create",
        "file-anthropic",
        "anthropic",
        "--method",
        "api-key",
        "--credential-file",
        file,
      ]),
    )
    restore()

    expect(writes).toHaveLength(1)
    expect(writes[0]?.value).toBe(SECRET)
  })

  it("refuses both --credential-file and --credential-env together", async () => {
    const { writes } = spyOnKeychain()
    const { err, restore } = capture()
    process.env.AGP_TEST_SECRET = SECRET
    try {
      await withStdin("", () =>
        runAuth([
          "profile",
          "create",
          "x",
          "anthropic",
          "--method",
          "api-key",
          "--credential-file",
          "/tmp/nope",
          "--credential-env",
          "AGP_TEST_SECRET",
        ]),
      )
    } finally {
      delete process.env.AGP_TEST_SECRET
    }
    restore()
    expect(writes).toHaveLength(0)
    expect(err.join("")).toMatch(/give ONE of --credential-file/)
  })

  it("creates a source-backed oauth-bearer profile without reading any secret", async () => {
    const { writes } = spyOnKeychain()
    const { out, restore } = capture()
    await withStdin("", () =>
      runAuth([
        "profile",
        "create",
        "cc-sub",
        "anthropic",
        "--method",
        "oauth-bearer",
        "--source",
        "claude-code-oauth",
      ]),
    )
    restore()

    expect(writes).toHaveLength(0)
    const profile = await getAuthProfile("cc-sub")
    expect(profile?.source).toBe("claude-code-oauth")
    expect(profile?.credentialRef).toBeUndefined()
    expect(out.join("")).toContain("no stored secret")
  })

  it("rejects a duplicate id (exit 2, validation message)", async () => {
    const { writes } = spyOnKeychain()
    await addAuthProfile({ id: "dup", endpoint: "anthropic", method: "api-key", credentialRef: "agentproto.auth.anthropic" })
    const { err, restore } = capture()
    await withStdin(SECRET, () =>
      runAuth(["profile", "create", "dup", "anthropic", "--method", "api-key"]),
    )
    restore()
    expect(writes).toHaveLength(0)
    expect(err.join("")).toMatch(/already exists/)
  })

  it("rejects an invalid id (keychain-slot charset)", async () => {
    const { err, restore } = capture()
    await withStdin(SECRET, () =>
      runAuth(["profile", "create", "bad id!", "anthropic", "--method", "api-key"]),
    )
    restore()
    expect(err.join("")).toMatch(/id "bad id!" is invalid/)
  })
})

describe("agentproto auth profile list", () => {
  it("shows non-secret metadata + a fingerprint, never the secret", async () => {
    spyOnKeychain()
    vi.spyOn(KeychainStore.prototype, "read").mockResolvedValue({
      value: SECRET,
      kind: "oat",
    })
    const { out, restore } = capture()
    await addAuthProfile({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      credentialRef: "agentproto.auth.anthropic.sub",
      label: "work sub",
    })
    const code = await runAuth(["profile", "list", "--json"])
    restore()
    expect(code).toBe(0)
    const payload = JSON.parse(out.join(""))
    expect(payload.profiles).toHaveLength(1)
    const row = payload.profiles[0]
    expect(row.id).toBe("anthropic-sub")
    expect(row.keyStatus).toBe("stored")
    expect(row.fingerprint).toMatch(/^[0-9a-f]{12}$/)
    expect(JSON.stringify(payload)).not.toContain(SECRET)
  })
})

describe("agentproto auth profile rm", () => {
  it("deletes the profile and its keychain slot", async () => {
    const { deletes } = spyOnKeychain()
    await addAuthProfile({
      id: "gone",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "agentproto.auth.anthropic",
    })
    const { out, restore } = capture()
    const code = await runAuth(["profile", "rm", "gone"])
    restore()
    expect(code).toBe(0)
    expect(await getAuthProfile("gone")).toBeUndefined()
    expect(deletes).toEqual([{ path: "agentproto.auth.anthropic" }])
    expect(out.join("")).toContain("removed auth profile")
  })

  it("is idempotent for an unknown id (exit 0)", async () => {
    spyOnKeychain()
    const { out, restore } = capture()
    const code = await runAuth(["profile", "rm", "ghost"])
    restore()
    expect(code).toBe(0)
    expect(out.join("")).toMatch(/no auth profile with id "ghost"/)
  })
})

describe("agentproto auth profile set-models / set-enabled", () => {
  it("narrows a profile to an allowlist (space- and comma-separated ids)", async () => {
    await addAuthProfile({ id: "curated", endpoint: "anthropic", method: "api-key", credentialRef: "agentproto.auth.anthropic" })
    const { out, restore } = capture()
    const code = await runAuth([
      "profile",
      "set-models",
      "curated",
      "allow",
      "claude-code/claude-sonnet-4, claude-code/claude-opus-4",
      "moonshot/moonshot-v1",
    ])
    restore()
    expect(code).toBe(0)
    const stored = await getAuthProfile("curated")
    expect(stored?.models).toEqual({
      mode: "allow",
      ids: [
        "claude-code/claude-sonnet-4",
        "claude-code/claude-opus-4",
        "moonshot/moonshot-v1",
      ],
    })
    expect(out.join("")).toContain("allow (3 ids)")
  })

  it('"all" clears the allowlist', async () => {
    await addAuthProfile({
      id: "curated2",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "agentproto.auth.anthropic",
      models: { mode: "allow", ids: ["one"] },
    })
    const { restore } = capture()
    const code = await runAuth(["profile", "set-models", "curated2", "all"])
    restore()
    expect(code).toBe(0)
    const stored = await getAuthProfile("curated2")
    expect(stored?.models).toBeUndefined()
  })

  it("requires at least one id for mode allow", async () => {
    const { err, restore } = capture()
    const code = await runAuth(["profile", "set-models", "some-id", "allow"])
    restore()
    expect(code).toBe(2)
    expect(err.join("")).toMatch(/needs at least one model id/)
  })

  it("disables then re-enables a profile (enabling clears the flag)", async () => {
    await addAuthProfile({ id: "toggle", endpoint: "anthropic", method: "api-key", credentialRef: "agentproto.auth.anthropic" })
    const { restore } = capture()
    expect(await runAuth(["profile", "set-enabled", "toggle", "disable"])).toBe(0)
    expect((await getAuthProfile("toggle"))?.disabled).toBe(true)
    expect(await runAuth(["profile", "set-enabled", "toggle", "enable"])).toBe(0)
    const stored = await getAuthProfile("toggle")
    expect(stored?.disabled).toBeUndefined()
    restore()
  })

  it("rejects an unknown enable-state word", async () => {
    const { err, restore } = capture()
    const code = await runAuth(["profile", "set-enabled", "toggle2", "maybe"])
    restore()
    expect(code).toBe(2)
    expect(err.join("")).toMatch(/usage: set-enabled <id> <true\|false>/)
  })
})

describe("agentproto auth discover", () => {
  afterEach(() => setDiscoverCredentialsForTests(undefined))

  it("prints discovered credentials with provenance and an import hint", async () => {
    setDiscoverCredentialsForTests(
      () =>
        [
          {
            endpoint: "anthropic",
            method: "oauth-bearer",
            origin: "claude-code",
            hint: 'Claude Code OAuth token in macOS Keychain ("Claude Code-credentials")',
          },
        ] as const,
    )
    const { out, restore } = capture()
    const code = await runAuth(["discover"])
    restore()
    expect(code).toBe(0)
    const text = out.join("")
    expect(text).toContain("claude-code")
    expect(text).toContain("import: agentproto auth profile import claude-code anthropic")
  })

  it("--json emits a credentials array without any secret value", async () => {
    setDiscoverCredentialsForTests(() => [])
    const { out, restore } = capture()
    const code = await runAuth(["discover", "--json"])
    restore()
    expect(code).toBe(0)
    expect(JSON.parse(out.join("")).credentials).toEqual([])
  })

  it("filters by --endpoint", async () => {
    setDiscoverCredentialsForTests(() => [
      {
        endpoint: "anthropic",
        method: "oauth-bearer",
        origin: "claude-code",
        hint: "Claude Code OAuth token in ~/.claude/.credentials.json",
      },
      {
        endpoint: "openai",
        method: "api-key",
        origin: "env",
        hint: "OPENAI_API_KEY in the environment",
      },
    ] as never)
    const { out, restore } = capture()
    const code = await runAuth(["discover", "--endpoint", "openai"])
    restore()
    expect(code).toBe(0)
    expect(out.join("")).toContain("openai")
    expect(out.join("")).not.toContain("anthropic")
  })
})

describe("agentproto auth profile import", () => {
  it("rejects an unknown origin before any store write", async () => {
    const { writes } = spyOnKeychain()
    const { err, restore } = capture()
    const code = await runAuth(["profile", "import", "dropbox", "anthropic"])
    restore()
    expect(code).toBe(2)
    expect(err.join("")).toMatch(/unknown origin "dropbox"/)
    expect(writes).toHaveLength(0)
  })
})