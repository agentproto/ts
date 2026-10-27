/**
 * `systemPromptCapsFor` — the resolver's three system-prompt fields, i.e.
 * serve.ts's rule for hermes: the `env-file` channel counts ONLY while the
 * bundled agentproto plugin is installed AND enabled under `$HERMES_HOME`,
 * it always carries the 7500-char budget, and an unusable channel names the
 * install command instead of leaving the runtime to guess.
 *
 * Uses a tmp `HERMES_HOME` — no daemon, no network, no real hermes binary.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { AgentCliDefinition } from "@agentproto/harness"
import {
  HERMES_SYSTEM_PROMPT_UNAVAILABLE,
  systemPromptCapsFor,
} from "../commands/system-prompt-caps.js"

type Declaration = AgentCliDefinition["systemPrompt"]

const ENV_FILE: Declaration = {
  via: "env-file",
  env: "AGENTPROTO_SYSTEM_PROMPT_FILE",
  maxChars: 7500,
}
const ACP_META: Declaration = { via: "acp-meta" }

/** A tmp hermes home with the plugin installed / enabled per the flags. */
function hermesEnv(opts: { installed?: boolean; enabled?: boolean } = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "agentproto-system-prompt-caps-"))
  const pluginDir = join(home, "plugins", "agentproto-system-prompt")
  if (opts.installed !== false) {
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, "plugin.yaml"),
      "name: agentproto-system-prompt\nversion: 0.1.0\ndescription: test\n",
    )
  }
  writeFileSync(
    join(home, "config.yaml"),
    opts.enabled
      ? "plugins:\n  enabled:\n    - agentproto-system-prompt\n"
      : "plugins:\n  enabled: []\n",
  )
  return { HERMES_HOME: home }
}

describe("systemPromptCapsFor", () => {
  it("a manifest with no channel gives no channel and no reason", () => {
    expect(systemPromptCapsFor("claude-code", undefined)).toEqual({
      supportsSystemPrompt: false,
    })
    expect(systemPromptCapsFor("hermes", undefined, hermesEnv({ installed: true, enabled: true }))).toEqual({
      supportsSystemPrompt: false,
    })
  })

  it("an unconditional channel (non-hermes) is supported without consulting env", () => {
    const caps = systemPromptCapsFor("claude-code", ACP_META, { HERMES_HOME: "/nonexistent" })
    expect(caps.supportsSystemPrompt).toBe(true)
    expect(caps).not.toHaveProperty("systemPromptMaxChars")
    expect(caps).not.toHaveProperty("systemPromptUnavailable")
  })

  it("hermes with the plugin installed AND enabled takes the channel, budget included", () => {
    const caps = systemPromptCapsFor("hermes", ENV_FILE, hermesEnv({ installed: true, enabled: true }))
    expect(caps).toEqual({ supportsSystemPrompt: true, systemPromptMaxChars: 7500 })
    expect(caps).not.toHaveProperty("systemPromptUnavailable")
  })

  it("hermes without the plugin degrades, naming the install command", () => {
    const caps = systemPromptCapsFor("hermes", ENV_FILE, hermesEnv({ installed: false, enabled: false }))
    expect(caps.supportsSystemPrompt).toBe(false)
    expect(caps.systemPromptMaxChars).toBe(7500)
    expect(caps.systemPromptUnavailable).toBe(HERMES_SYSTEM_PROMPT_UNAVAILABLE)
    expect(caps.systemPromptUnavailable).toContain(
      "agentproto adapters hermes-plugin install --enable",
    )
  })

  it("installed but not enabled (no consent) is still unavailable", () => {
    const caps = systemPromptCapsFor("hermes", ENV_FILE, hermesEnv({ installed: true, enabled: false }))
    expect(caps.supportsSystemPrompt).toBe(false)
    expect(caps.systemPromptUnavailable).toBe(HERMES_SYSTEM_PROMPT_UNAVAILABLE)
  })

  it("enabled but not installed is still unavailable", () => {
    const caps = systemPromptCapsFor("hermes", ENV_FILE, hermesEnv({ installed: false, enabled: true }))
    expect(caps.supportsSystemPrompt).toBe(false)
    expect(caps.systemPromptUnavailable).toBe(HERMES_SYSTEM_PROMPT_UNAVAILABLE)
  })

  it("a channel with no declared budget omits systemPromptMaxChars", () => {
    const caps = systemPromptCapsFor("some-harness", { via: "env-file", env: "TEXT_FILE" })
    expect(caps).toEqual({ supportsSystemPrompt: true })
    expect(caps).not.toHaveProperty("systemPromptMaxChars")
  })
})
