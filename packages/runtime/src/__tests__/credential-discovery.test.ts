/**
 * Unit coverage for the read-only credential DISCOVERY SCANNER
 * (`credential-discovery.ts`). Two money-safety invariants are the point of
 * this suite (mirroring the doc comment on the module):
 *
 *   1. NEVER return a discovered secret VALUE — only provenance + a non-secret
 *      hint. The `never-returns-the-value` block feeds a unique sentinel secret
 *      into EVERY source and asserts it appears nowhere in the output.
 *   2. NEVER throw on a malformed/unreadable source — a corrupt file becomes a
 *      per-source warn+skip and the rest of the scan still runs. A MISSING file
 *      is a normal "not found" with no warning at all.
 *
 * The scanner takes injectable I/O (home dir / env / readFile / keychain), so
 * these tests drive it with fakes and never touch the real host, Keychain, or
 * `~`.
 */

import { describe, it, expect } from "vitest"
import {
  discoverCredentials,
  jsonFieldPresent,
  yamlKeyPresent,
  type CredentialDiscoveryDeps,
} from "../credential-discovery.js"

const HOME = "/home/tester"

/** A readFile that serves a fixed file map and throws an ENOENT-shaped error
 *  for anything else — exactly how `fs.readFileSync` behaves for a missing
 *  file, which the scanner must treat as normal "not found". */
function fakeReadFile(files: Record<string, string>): (path: string) => string {
  return (path: string) => {
    const hit = files[path]
    if (hit !== undefined) return hit
    const err = new Error(`ENOENT: no such file, open '${path}'`) as NodeJS.ErrnoException
    err.code = "ENOENT"
    throw err
  }
}

/** Base deps: linux (Keychain off), empty env, no files, collecting warnings. */
function deps(over: Partial<CredentialDiscoveryDeps> = {}): {
  deps: CredentialDiscoveryDeps
  warnings: string[]
} {
  const warnings: string[] = []
  return {
    warnings,
    deps: {
      homeDir: HOME,
      env: {},
      platform: "linux",
      readFile: fakeReadFile({}),
      keychainLookup: () => {
        throw new Error("no keychain in test")
      },
      warn: (m) => warnings.push(m),
      ...over,
    },
  }
}

describe("jsonFieldPresent — boolean, never the value", () => {
  it("is true for a non-empty string at the path", () => {
    expect(jsonFieldPresent('{"a":{"b":"tok"}}', "a.b")).toBe(true)
  })
  it("is false for a missing path, empty string, or non-string", () => {
    expect(jsonFieldPresent('{"a":{}}', "a.b")).toBe(false)
    expect(jsonFieldPresent('{"a":{"b":""}}', "a.b")).toBe(false)
    expect(jsonFieldPresent('{"a":{"b":123}}', "a.b")).toBe(false)
  })
  it("throws on non-JSON (a malformed source the caller turns into warn+skip)", () => {
    expect(() => jsonFieldPresent("not json", "a")).toThrow()
  })
})

describe("yamlKeyPresent — presence only", () => {
  it("detects a key with a non-empty value, quoted or not", () => {
    expect(yamlKeyPresent("OPENROUTER_API_KEY: sk-or-123", "OPENROUTER_API_KEY")).toBe(true)
    expect(yamlKeyPresent('OPENAI_API_KEY: "sk-abc"', "OPENAI_API_KEY")).toBe(true)
    expect(yamlKeyPresent("  OPENAI_API_KEY:   sk-x  ", "OPENAI_API_KEY")).toBe(true)
  })
  it("is false for an absent key or an empty/blank value", () => {
    expect(yamlKeyPresent("OTHER: x", "OPENROUTER_API_KEY")).toBe(false)
    expect(yamlKeyPresent("OPENROUTER_API_KEY:", "OPENROUTER_API_KEY")).toBe(false)
    expect(yamlKeyPresent('OPENROUTER_API_KEY: ""', "OPENROUTER_API_KEY")).toBe(false)
  })
})

describe("discoverCredentials — env keys", () => {
  it("reports each present provider env key as an api-key with an env hint", () => {
    const { deps: d } = deps({
      env: { OPENROUTER_API_KEY: "sk-or-x", ANTHROPIC_API_KEY: "sk-ant-x", XAI_API_KEY: "" },
    })
    const found = discoverCredentials(d)
    const openrouter = found.find((f) => f.endpoint === "openrouter")
    const anthropic = found.find((f) => f.endpoint === "anthropic")
    expect(openrouter).toMatchObject({ method: "api-key", origin: "env" })
    expect(anthropic).toMatchObject({ method: "api-key", origin: "env" })
    // Blank env value is not "present".
    expect(found.find((f) => f.endpoint === "xai")).toBeUndefined()
    expect(openrouter?.hint).toContain("OPENROUTER_API_KEY")
  })
})

describe("discoverCredentials — claude-code OAuth", () => {
  it("reports the Keychain item first on darwin (credentials file not consulted)", () => {
    const reads: string[] = []
    const { deps: d } = deps({
      platform: "darwin",
      keychainLookup: () => JSON.stringify({ claudeAiOauth: { accessToken: "oauth-tok" } }),
      readFile: (p) => {
        reads.push(p)
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException
        err.code = "ENOENT"
        throw err
      },
    })
    const found = discoverCredentials(d)
    expect(found).toContainEqual(
      expect.objectContaining({ endpoint: "anthropic", method: "oauth-bearer", origin: "claude-code" }),
    )
    // The Keychain hit short-circuits the claude-code probe — its file fallback
    // is never read (other origins' files may still be probed).
    expect(reads).not.toContain(`${HOME}/.claude/.credentials.json`)
  })

  it("falls back to ~/.claude/.credentials.json when the Keychain item is absent", () => {
    const { deps: d, warnings } = deps({
      platform: "darwin",
      keychainLookup: () => {
        throw new Error("item not found") // a missing item, not a malformed source
      },
      readFile: fakeReadFile({
        [`${HOME}/.claude/.credentials.json`]: JSON.stringify({
          claudeAiOauth: { accessToken: "file-tok" },
        }),
      }),
    })
    const found = discoverCredentials(d)
    expect(found).toEqual([
      expect.objectContaining({ origin: "claude-code", method: "oauth-bearer" }),
    ])
    // A missing Keychain item is normal "not logged in", not a warning.
    expect(warnings).toEqual([])
  })
})

describe("discoverCredentials — codex / gemini file logins", () => {
  it("reports codex and gemini OAuth tokens from their login files", () => {
    const { deps: d } = deps({
      readFile: fakeReadFile({
        [`${HOME}/.codex/auth.json`]: JSON.stringify({ tokens: { access_token: "codex-tok" } }),
        [`${HOME}/.gemini/oauth_creds.json`]: JSON.stringify({ access_token: "gem-tok" }),
      }),
    })
    const found = discoverCredentials(d)
    expect(found).toContainEqual(
      expect.objectContaining({ origin: "codex", endpoint: "openai", method: "oauth-bearer" }),
    )
    expect(found).toContainEqual(
      expect.objectContaining({ origin: "gemini", endpoint: "google", method: "oauth-bearer" }),
    )
  })
})

describe("discoverCredentials — hermes config", () => {
  it("reports OPENROUTER/OPENAI keys present in ~/.hermes/config.yaml", () => {
    const { deps: d } = deps({
      readFile: fakeReadFile({
        [`${HOME}/.hermes/config.yaml`]: "OPENROUTER_API_KEY: sk-or-1\nOPENAI_API_KEY: sk-oa-1\n",
      }),
    })
    const found = discoverCredentials(d).filter((f) => f.origin === "hermes-config")
    expect(found.map((f) => f.endpoint).sort()).toEqual(["openai", "openrouter"])
    expect(found.every((f) => f.hint.includes("~/.hermes/config.yaml"))).toBe(true)
  })
})

describe("INVARIANT: malformed source is skipped and warned, never fatal", () => {
  it("skips a corrupt codex file (warn), still finds a valid env key", () => {
    const { deps: d, warnings } = deps({
      env: { OPENROUTER_API_KEY: "sk-or-x" },
      readFile: fakeReadFile({
        [`${HOME}/.codex/auth.json`]: "}{ not json",
      }),
    })
    const found = discoverCredentials(d)
    // The scan did NOT throw and still surfaced the good env credential.
    expect(found).toContainEqual(expect.objectContaining({ origin: "env", endpoint: "openrouter" }))
    // The corrupt file produced exactly one warning naming it.
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("~/.codex/auth.json")
  })

  it("treats a MISSING file as a silent not-found (no warning)", () => {
    const { deps: d, warnings } = deps({ readFile: fakeReadFile({}) })
    const found = discoverCredentials(d)
    expect(found).toEqual([])
    expect(warnings).toEqual([])
  })

  it("does not throw when the Keychain lookup itself errors on darwin", () => {
    const { deps: d } = deps({
      platform: "darwin",
      keychainLookup: () => {
        throw new Error("security: SecKeychainSearchCopyNext failed")
      },
    })
    expect(() => discoverCredentials(d)).not.toThrow()
    expect(discoverCredentials(d)).toEqual([])
  })
})

describe("INVARIANT: never returns a discovered secret value", () => {
  it("emits provenance + hints but never any credential value, across all origins", () => {
    // A unique sentinel per source. If ANY leaks into the output, the
    // stringified result will contain it.
    const SENTINELS = {
      keychain: "SENTINEL-claude-keychain-VALUE",
      codex: "SENTINEL-codex-VALUE",
      gemini: "SENTINEL-gemini-VALUE",
      hermesOr: "SENTINEL-hermes-openrouter-VALUE",
      hermesOa: "SENTINEL-hermes-openai-VALUE",
      env: "SENTINEL-env-openrouter-VALUE",
    }
    const { deps: d } = deps({
      platform: "darwin",
      env: { OPENROUTER_API_KEY: SENTINELS.env },
      keychainLookup: () =>
        JSON.stringify({ claudeAiOauth: { accessToken: SENTINELS.keychain } }),
      readFile: fakeReadFile({
        [`${HOME}/.codex/auth.json`]: JSON.stringify({ tokens: { access_token: SENTINELS.codex } }),
        [`${HOME}/.gemini/oauth_creds.json`]: JSON.stringify({ access_token: SENTINELS.gemini }),
        [`${HOME}/.hermes/config.yaml`]:
          `OPENROUTER_API_KEY: ${SENTINELS.hermesOr}\nOPENAI_API_KEY: ${SENTINELS.hermesOa}\n`,
      }),
    })
    const found = discoverCredentials(d)
    // We DID discover across every origin...
    expect(new Set(found.map((f) => f.origin))).toEqual(
      new Set(["claude-code", "codex", "gemini", "hermes-config", "env"]),
    )
    // ...yet no sentinel value appears anywhere in the reported output.
    const dump = JSON.stringify(found)
    for (const secret of Object.values(SENTINELS)) {
      expect(dump).not.toContain(secret)
    }
  })
})
