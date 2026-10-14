/**
 * Unit coverage for the pure box-login bridge (`box-login-bridge.ts`): the
 * keep-list, the UNCONDITIONAL refresh deny, home-relative path derivation,
 * the expiry gate, the digest, and the throttled refresher's digest gate.
 *
 * Everything here is strings in / results out — no I/O, no recipe reads beyond
 * the registry lookup that derives the destination path, and no token value
 * ever appears in a message.
 */

import { describe, it, expect, vi } from "vitest"
import { createHash } from "node:crypto"

import {
  buildLoginCopy,
  createBoxLoginRefresher,
  type BoxLoginDecl,
} from "../box-login-bridge.js"

const CODEX_DECL: BoxLoginDecl = {
  recipe: "codex",
  keep: [
    "tokens.access_token",
    "tokens.id_token",
    "tokens.account_id",
    "tokens.refresh_token",
    "last_refresh",
  ],
}

const OPENCODE_DECL: BoxLoginDecl = {
  recipe: "opencode",
  methodId: "anthropic-oauth",
  keep: ["anthropic.type", "anthropic.access", "anthropic.expires", "anthropic.refresh"],
  expiresPath: "anthropic.expires",
}

const HOST_CODEX_JSON = JSON.stringify({
  tokens: {
    access_token: "at-live",
    refresh_token: "rt-SECRET",
    id_token: "header.payload.sig",
    account_id: "acc_1",
    extra_account: "another-login",
  },
  last_refresh: "2026-10-13T00:00:00Z",
  OPENAI_API_KEY: "sk-host-secret",
})

describe("buildLoginCopy — keep-list", () => {
  it("keeps only the declared dotted paths and derives the codex path from the recipe", () => {
    const copy = buildLoginCopy(CODEX_DECL, HOST_CODEX_JSON)
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    expect(copy.path).toBe(".codex/auth.json")
    const parsed = JSON.parse(copy.body) as Record<string, any>
    expect(parsed.tokens.access_token).toBe("at-live")
    expect(parsed.tokens.id_token).toBe("header.payload.sig")
    expect(parsed.tokens.account_id).toBe("acc_1")
    expect(parsed.last_refresh).toBe("2026-10-13T00:00:00Z")
    // Everything outside the allowlist is gone: the sibling login and the
    // host's API key never reach the box.
    expect(parsed.tokens.extra_account).toBeUndefined()
    expect(parsed.OPENAI_API_KEY).toBeUndefined()
    expect(copy.body.endsWith("\n")).toBe(true)
  })

  it("scopes an opencode copy to the declared provider entry (recipe method picks the path)", () => {
    const host = JSON.stringify({
      anthropic: { type: "oauth", access: "an-at", refresh: "an-rt", expires: 4_102_444_800_000 },
      openai: { type: "oauth", access: "oa-at", refresh: "oa-rt", expires: 4_102_444_800_000 },
      other: { key: "nope" },
    })
    const copy = buildLoginCopy(OPENCODE_DECL, host)
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    expect(copy.path).toBe(".local/share/opencode/auth.json")
    const parsed = JSON.parse(copy.body) as Record<string, any>
    expect(parsed.anthropic.access).toBe("an-at")
    expect(parsed.openai).toBeUndefined()
    expect(parsed.other).toBeUndefined()
  })

  it("omits a keep path the host login does not have (CLI versions differ)", () => {
    const copy = buildLoginCopy(
      { recipe: "codex", file: ".codex/auth.json", keep: ["tokens.access_token", "tokens.nope"] },
      JSON.stringify({ tokens: { access_token: "at" } }),
    )
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    expect(JSON.parse(copy.body)).toEqual({ tokens: { access_token: "at" } })
  })
})

describe("buildLoginCopy — unconditional refresh deny", () => {
  it("empties a keep-listed refresh key instead of copying its material", () => {
    const copy = buildLoginCopy(CODEX_DECL, HOST_CODEX_JSON)
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    expect(JSON.parse(copy.body).tokens.refresh_token).toBe("")
    expect(copy.body).not.toContain("rt-SECRET")
  })

  it("drops a refresh key reached only through a kept subtree", () => {
    const copy = buildLoginCopy(
      { recipe: "codex", file: ".codex/auth.json", keep: ["tokens"] },
      HOST_CODEX_JSON,
    )
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    const parsed = JSON.parse(copy.body) as Record<string, any>
    expect(parsed.tokens.access_token).toBe("at-live")
    expect("refresh_token" in parsed.tokens).toBe(false)
    expect(copy.body).not.toContain("rt-SECRET")
  })

  it("empties the opencode refresh entry too, keeping the provider's shape", () => {
    const host = JSON.stringify({
      anthropic: { type: "oauth", access: "an-at", refresh: "an-rt", expires: 4_102_444_800_000 },
    })
    const copy = buildLoginCopy(OPENCODE_DECL, host)
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    const parsed = JSON.parse(copy.body) as Record<string, any>
    expect(parsed.anthropic.refresh).toBe("")
    expect(copy.body).not.toContain("an-rt")
  })

  it("synthesizes an empty refresh field the host file has no room for", () => {
    const copy = buildLoginCopy(
      CODEX_DECL,
      JSON.stringify({ tokens: { access_token: "at", id_token: "i", account_id: "a" } }),
    )
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    expect(JSON.parse(copy.body).tokens.refresh_token).toBe("")
  })

  it("keeps last_refresh (codex's own timestamp) despite the name", () => {
    const copy = buildLoginCopy(CODEX_DECL, HOST_CODEX_JSON)
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    expect(JSON.parse(copy.body).last_refresh).toBe("2026-10-13T00:00:00Z")
  })

  it("refuses a keep-list that retains nothing usable", () => {
    const copy = buildLoginCopy(
      { recipe: "codex", file: ".codex/auth.json", keep: ["nope"] },
      HOST_CODEX_JSON,
    )
    expect(copy.ok).toBe(false)
    if (copy.ok) return
    expect(copy.reason).toBe("empty")
  })
})

describe("buildLoginCopy — destination path validation", () => {
  it("strips the leading ~ from the recipe's own file source", () => {
    const copy = buildLoginCopy(
      { recipe: "codex", keep: ["tokens.access_token"] },
      JSON.stringify({ tokens: { access_token: "at" } }),
    )
    expect(copy.ok).toBe(true)
    if (copy.ok) expect(copy.path).toBe(".codex/auth.json")
  })

  it("rejects an absolute destination", () => {
    const copy = buildLoginCopy(
      { recipe: "codex", file: "/etc/codex/auth.json", keep: ["tokens.access_token"] },
      HOST_CODEX_JSON,
    )
    expect(copy.ok).toBe(false)
    if (copy.ok) return
    expect(copy.reason).toBe("bad_path")
    expect(copy.message).toContain("auth.json")
    expect(copy.message).not.toContain("at-live")
  })

  it("rejects a destination that escapes the box home", () => {
    for (const file of ["../.ssh/authorized_keys", ".codex/../../auth.json", "a/./b/../c.json"]) {
      const copy = buildLoginCopy(
        { recipe: "codex", file, keep: ["tokens.access_token"] },
        HOST_CODEX_JSON,
      )
      expect(copy.ok, file).toBe(false)
      if (!copy.ok) expect(copy.reason).toBe("bad_path")
    }
  })

  it("reports no_path when neither `file` nor the recipe method names a file", () => {
    // codex's `api-key` method reads only from env — nothing to copy.
    const copy = buildLoginCopy(
      { recipe: "codex", methodId: "api-key", keep: ["tokens.access_token"] },
      HOST_CODEX_JSON,
    )
    expect(copy.ok).toBe(false)
    if (copy.ok) return
    expect(copy.reason).toBe("no_path")
  })
})

describe("buildLoginCopy — source shape and expiry", () => {
  it("reports unparseable / not_object without echoing the source", () => {
    const bad = buildLoginCopy(CODEX_DECL, "not json at-live")
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.reason).toBe("unparseable")
      expect(bad.message).not.toContain("at-live")
    }
    const arr = buildLoginCopy(CODEX_DECL, "[1,2,3]")
    expect(arr.ok).toBe(false)
    if (!arr.ok) expect(arr.reason).toBe("not_object")
  })

  it("refuses an already-expired login", () => {
    const copy = buildLoginCopy(
      OPENCODE_DECL,
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "an-at",
          refresh: "an-rt",
          expires: Date.now() - 60_000,
        },
      }),
    )
    expect(copy.ok).toBe(false)
    if (copy.ok) return
    expect(copy.reason).toBe("expired")
    expect(copy.expiresAt).toBeDefined()
  })

  it("accepts a future expiry and reports it in ISO form", () => {
    const expires = Date.now() + 86_400_000
    const copy = buildLoginCopy(
      OPENCODE_DECL,
      JSON.stringify({
        anthropic: { type: "oauth", access: "an-at", refresh: "an-rt", expires },
      }),
    )
    expect(copy.ok).toBe(true)
    if (!copy.ok) return
    expect(copy.expiresAt).toBe(new Date(expires).toISOString())
  })

  it("reads expiry in epoch seconds and as a date string", () => {
    const decl = { ...OPENCODE_DECL, expiresPath: "anthropic.expires" }
    const seconds = Math.floor(Date.now() / 1000) + 3_600
    const a = buildLoginCopy(
      decl,
      JSON.stringify({ anthropic: { type: "oauth", access: "a", expires: seconds } }),
    )
    expect(a.ok).toBe(true)
    const b = buildLoginCopy(
      decl,
      JSON.stringify({
        anthropic: { type: "oauth", access: "a", expires: new Date(Date.now() + 60_000).toISOString() },
      }),
    )
    expect(b.ok).toBe(true)
  })

  it("does not fail a live login whose expiry field it cannot read", () => {
    const copy = buildLoginCopy(
      OPENCODE_DECL,
      JSON.stringify({
        anthropic: { type: "oauth", access: "an-at", refresh: "an-rt", expires: "soon-ish" },
      }),
    )
    expect(copy.ok).toBe(true)
    if (copy.ok) expect(copy.expiresAt).toBeUndefined()
  })
})

describe("buildLoginCopy — digest", () => {
  it("is the sha256 of the exact body and changes with the content", () => {
    const first = buildLoginCopy(CODEX_DECL, HOST_CODEX_JSON)
    const second = buildLoginCopy(CODEX_DECL, HOST_CODEX_JSON)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.digest).toBe(second.digest)
    expect(first.digest).toBe(createHash("sha256").update(first.body).digest("hex"))

    const rotated = buildLoginCopy(
      CODEX_DECL,
      HOST_CODEX_JSON.replace("at-live", "at-rotated"),
    )
    expect(rotated.ok).toBe(true)
    if (rotated.ok) expect(rotated.digest).not.toBe(first.digest)
  })
})

describe("createBoxLoginRefresher", () => {
  const decl: BoxLoginDecl = {
    recipe: "codex",
    file: ".codex/auth.json",
    keep: ["tokens.access_token", "tokens.refresh_token"],
  }
  const raw = JSON.stringify({
    tokens: { access_token: "at-1", refresh_token: "rt" },
  })

  function setup(hostRaw = raw) {
    const writes: Array<{ path: string; body: string }> = []
    const read = vi.fn(async () => hostRaw)
    const written = buildLoginCopy(decl, raw)
    if (!written.ok) throw new Error("fixture must build")
    const refresh = createBoxLoginRefresher({
      decl,
      path: "/home/user/.codex/auth.json",
      read,
      write: async (path, data) => {
        writes.push({ path, body: new TextDecoder().decode(data) })
      },
      digest: written.digest,
    })
    return { refresh, writes, read }
  }

  it("skips the upload when the box already holds the host's copy", async () => {
    const { refresh, writes, read } = setup()
    await expect(refresh()).resolves.toBe("unchanged")
    expect(read).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(0)
  })

  it("re-uploads only when the host's login changed", async () => {
    const rotated = JSON.stringify({
      tokens: { access_token: "at-2", refresh_token: "rt" },
    })
    const { refresh, writes } = setup(rotated)
    await expect(refresh()).resolves.toBe("written")
    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe("/home/user/.codex/auth.json")
    expect(writes[0]!.body).toContain("at-2")
    expect(writes[0]!.body).not.toContain('"rt"')
    // Second call: the new digest is the gate, so the same file is quiet.
    await expect(refresh()).resolves.toBe("unchanged")
    expect(writes).toHaveLength(1)
  })

  it("reports unavailable (never throws) when the host login is unusable", async () => {
    const { refresh, writes } = setup("this is not json")
    await expect(refresh()).resolves.toBe("unavailable")
    expect(writes).toHaveLength(0)

    // A read failure is transport trouble, not an unusable login: it PROPAGATES
    // (the proxy logs it) so a transient FS error is never mistaken for "the
    // box is up to date".
    const failing = createBoxLoginRefresher({
      decl,
      path: "/home/user/.codex/auth.json",
      read: async () => {
        throw new Error("login file vanished")
      },
      write: async () => {
        throw new Error("should not write")
      },
      digest: "anything",
    })
    await expect(failing()).rejects.toThrow("login file vanished")
  })
})
