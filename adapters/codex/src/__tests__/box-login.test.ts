import { describe, expect, it } from "vitest"
import { codex } from "../index.js"

describe("codex box-login marker", () => {
  // A fresh box has no `~/.codex/auth.json`, so the box's own fail-loud login
  // verify would refuse every codex subscription spawn. The host re-creates a
  // REDACTED copy there before `host.start` — this pins the keep-list contract
  // (the shape only: never a host token value).
  it("declares the file-based boxLogin marker on the external subscription", () => {
    const subscription = codex.authSubscription as {
      external: boolean
      conflictEnv?: string[]
      boxLogin?: { recipe: string; keep: string[] }
    }
    expect(subscription.external).toBe(true)
    expect(subscription.conflictEnv).toEqual(["CODEX_API_KEY"])
    expect(subscription.boxLogin).toEqual({
      recipe: "codex",
      keep: [
        "tokens.access_token",
        "tokens.id_token",
        "tokens.account_id",
        // Keep-listed EXACTLY to be emptied: codex's parser requires the field
        // to exist as a string, and the bridge writes "" — never the host's
        // refresh token.
        "tokens.refresh_token",
        // Non-secret timestamp; the bridge's deny rule exempts it by name.
        "last_refresh",
      ],
    })
  })
})
