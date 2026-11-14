import { findReauthAdapter, registerReauthAdapter, type ReauthAdapter } from "@agentproto/auth"

/**
 * Register the re-login adapters that ship with the CLI. This is the one place a
 * source is named: adding one is a small module plus one line here. A source that
 * already has an adapter registered (an embedder's, or a test's) is left alone.
 * Lazy-imported so the common `auth` help path doesn't load adapters.
 */
export async function registerBuiltinReauthAdapters(): Promise<void> {
  const builtins: Array<() => Promise<ReauthAdapter>> = [
    async () => (await import("@agentproto/adapter-opencode")).opencodeReauth,
    async () => (await import("./claude-code.js")).claudeCodeReauth,
    async () => (await import("./codex.js")).codexReauth,
    async () => (await import("./gemini.js")).geminiReauth,
  ]
  for (const load of builtins) {
    const adapter = await load()
    if (findReauthAdapter(adapter.source) === undefined) registerReauthAdapter(adapter)
  }
}
