/**
 * A `curl | bash` (or `download`) install step that declares no
 * `verify_sha256` is a silent MITM/supply-chain vector. `agentproto install`
 * refuses one in a NON-interactive context (agent, daemon, CI) unless the
 * caller explicitly passes `--allow-unverified`; a human at a TTY keeps the
 * warn-and-proceed dev behavior. This pins that policy.
 */

import { describe, it, expect } from "vitest"
import { shouldRefuseUnverifiedInstaller } from "../commands/install.js"

describe("shouldRefuseUnverifiedInstaller", () => {
  it("never refuses a verified installer, regardless of context", () => {
    for (const interactive of [true, false]) {
      for (const allowUnverified of [true, false]) {
        expect(
          shouldRefuseUnverifiedInstaller({
            verifySha256: "abc123",
            allowUnverified,
            interactive,
          }),
        ).toBe(false)
      }
    }
  })

  it("never refuses when --allow-unverified is set", () => {
    expect(
      shouldRefuseUnverifiedInstaller({
        allowUnverified: true,
        interactive: false,
      }),
    ).toBe(false)
  })

  it("lets a human at a TTY proceed on an unverified installer", () => {
    expect(
      shouldRefuseUnverifiedInstaller({
        allowUnverified: false,
        interactive: true,
      }),
    ).toBe(false)
  })

  it("REFUSES an unverified installer in a non-interactive context", () => {
    expect(
      shouldRefuseUnverifiedInstaller({
        allowUnverified: false,
        interactive: false,
      }),
    ).toBe(true)
  })
})
