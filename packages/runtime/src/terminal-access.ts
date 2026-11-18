/**
 * Access-profile pinning for a PTY (`kind: "terminal"`) session.
 *
 * An agent-cli spawn resolves its named `access.profileRef` into a billing
 * credential (`resolveAccessProfileAuth`). A raw `sessions terminal -- claude`
 * used to inherit the daemon's ambient login instead, so an operator could not
 * say "this TUI bills the Agentik subscription / the OpenCode Go key". This
 * helper runs the SAME resolver against the harness the argv launches and
 * turns the result into what a PTY can consume: the env to set, the env to
 * scrub, and the non-secret `accessProfile` echo for the descriptor.
 */

import type { AgentAdapterResolver } from "./http-server.js"
import { conversationTerminalSlugFor } from "./conversation-store.js"
import { resolveAccessProfileAuth } from "./session-spawn.js"
import type { SessionAccessProfileEcho } from "./sessions.js"

export interface TerminalAccessResolved {
  ok: true
  env: Record<string, string>
  unsetEnv: string[]
  echo: SessionAccessProfileEcho
}

export interface TerminalAccessRefused {
  ok: false
  code: "access_profile_unsupported_argv" | "adapter_not_found" | string
  message: string
}

export async function resolveTerminalAccess(input: {
  argv: string[]
  profileRef: string
  model?: string
  resolveAgentAdapter: AgentAdapterResolver
  /** Test seam; defaults to the real profile resolver. */
  resolveProfile?: typeof resolveAccessProfileAuth
}): Promise<TerminalAccessResolved | TerminalAccessRefused> {
  const adapter = conversationTerminalSlugFor({ argv: input.argv })
  if (!adapter) {
    return {
      ok: false,
      code: "access_profile_unsupported_argv",
      message:
        `an access profile can only be pinned on a provider TUI (claude, codex, opencode, …); ` +
        `"${input.argv[0] ?? ""}" is not one the daemon recognises.`,
    }
  }
  const resolved = await input.resolveAgentAdapter(adapter)
  if (!resolved) {
    return { ok: false, code: "adapter_not_found", message: `no adapter "${adapter}" to resolve the profile against.` }
  }
  const result = await (input.resolveProfile ?? resolveAccessProfileAuth)({
    adapter,
    profileRef: input.profileRef,
    authDescriptor: resolved.authDescriptor,
    ...(input.model ? { model: input.model } : {}),
    ...(resolved.defaultModel ? { defaultModel: resolved.defaultModel } : {}),
  })
  if (!result.ok) return { ok: false, code: result.code, message: result.message }
  const spec = result.authSpec
  const env: Record<string, string> = { ...(spec?.extraEnv ?? {}) }
  if (spec?.credential !== undefined && spec.setEnv) env[spec.setEnv] = spec.credential
  return {
    ok: true,
    env,
    unsetEnv: spec?.unsetEnv ?? [],
    echo: result.accessProfileEcho as SessionAccessProfileEcho,
  }
}
