/**
 * The three system-prompt fields an adapter resolver entry returns next to
 * `startSession` (`supportsSystemPrompt`, `systemPromptMaxChars`,
 * `systemPromptUnavailable` — see `AgentAdapterResolver` in
 * `@agentproto/runtime`'s http-server). Factored out of `serve.ts` so the
 * CONDITIONAL hermes channel — real only while its agentproto plugin is
 * installed AND enabled under `$HERMES_HOME` — is unit-testable without
 * booting a daemon.
 *
 * The plugin status is a couple of cheap file reads; callers evaluate it on
 * every resolve (one per spawn), so installing the plugin takes effect
 * without a daemon restart.
 */
import { hermesSystemPromptPluginStatus } from "@agentproto/adapter-hermes"
import type { AgentCliDefinition } from "@agentproto/driver-agent-cli"

export interface SystemPromptCaps {
  /** True when `start({ appendSystemPrompt })` really lands the text in the
   *  harness's own system prompt — a declared channel that is currently
   *  usable (for hermes: plugin installed AND enabled). Absent/false ⇒ the
   *  runtime prefixes the first prompt + warns, never a silent drop. */
  supportsSystemPrompt: boolean
  /** The channel's char budget (manifest `systemPrompt.maxChars`) — a longer
   *  text degrades to the same prefix + a warning naming the limit instead
   *  of being truncated by the driver. */
  systemPromptMaxChars?: number
  /** Why a DECLARED channel is unusable right now (hermes without its
   *  plugin), appended to the runtime's fallback warning so the fix is
   *  named, not guessed. */
  systemPromptUnavailable?: string
}

/** Hermes fallback reason — the install command, named verbatim. */
export const HERMES_SYSTEM_PROMPT_UNAVAILABLE =
  "the agentproto hermes plugin is not installed/enabled — " +
  "run `agentproto adapters hermes-plugin install --enable`"

/**
 * Project one adapter's declared `systemPrompt` channel (plus, for hermes,
 * the live plugin status) onto the resolver's system-prompt fields.
 *
 * - No declaration ⇒ no channel, and NO `systemPromptUnavailable` reason
 *   (there is nothing to be unavailable — the generic "no channel" warning
 *   applies).
 * - hermes is the only conditional channel: its channel IS the plugin, so
 *   it counts only while `hermesSystemPromptPluginStatus({ env })` reports
 *   `installed && enabled`.
 * - Any other adapter with a declaration takes the text unconditionally.
 */
export function systemPromptCapsFor(
  slug: string,
  declaration: AgentCliDefinition["systemPrompt"],
  env: NodeJS.ProcessEnv = process.env,
): SystemPromptCaps {
  if (declaration === undefined) return { supportsSystemPrompt: false }
  const hermesReady =
    slug !== "hermes" ||
    (() => {
      const status = hermesSystemPromptPluginStatus({ env })
      return status.installed && status.enabled
    })()
  const maxChars = "maxChars" in declaration ? declaration.maxChars : undefined
  return {
    supportsSystemPrompt: hermesReady,
    ...(maxChars !== undefined ? { systemPromptMaxChars: maxChars } : {}),
    ...(slug === "hermes" && !hermesReady
      ? { systemPromptUnavailable: HERMES_SYSTEM_PROMPT_UNAVAILABLE }
      : {}),
  }
}
