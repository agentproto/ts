/**
 * AIP-45 protocol arm: `protocol: "proprietary"`.
 *
 * Loads an NPM adapter package (named in the manifest's `adapter`
 * field) implementing `AgentCliClient`. The package translates the
 * vendor's REPL/proprietary stream into the canonical StreamEvent
 * taxonomy.
 *
 * Unlike the `acp` / `print` arms (built into this package, driving a
 * spawned subprocess), a proprietary arm may not involve a subprocess
 * at all — e.g. an in-process SDK integration. `createAgentCliRuntime`
 * skips the subprocess spawn entirely for `protocol: "proprietary"`
 * (see `define-agent-cli.ts`); this loader has no opinion on whether
 * the loaded package owns a child process, a socket, or nothing.
 *
 * ## Adapter package contract
 *
 * The named package's default export path (its `main`/`exports["."]`)
 * must export a factory:
 *
 *   export function createAgentCliClient(
 *     definition: AgentCliHandle,
 *   ): AgentCliClient | Promise<AgentCliClient>
 *
 * A default export function is accepted as a fallback for adapters
 * that only have one thing to export. The factory receives the full
 * manifest handle so adapter-specific config (models, capabilities,
 * metadata) is available without a second lookup — mirrors the ACP
 * arm receiving `clientInfo` derived from the manifest.
 */

import type { AgentCliClient, AgentCliHandle } from "../types.js"

export interface ProprietaryProtocolOptions {
  /** NPM package name to load — from manifest.adapter. */
  adapter: string
  /** Full manifest handle, forwarded verbatim to the loaded factory. */
  definition: AgentCliHandle
}

type AgentCliClientFactory = (
  definition: AgentCliHandle,
) => AgentCliClient | Promise<AgentCliClient>

export async function createProprietaryProtocolArm(
  options: ProprietaryProtocolOptions,
): Promise<AgentCliClient> {
  let mod: Record<string, unknown>
  try {
    mod = (await import(options.adapter)) as Record<string, unknown>
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(
      `createProprietaryProtocolArm: could not load adapter package '${options.adapter}'. ` +
        `Install it with: npm i ${options.adapter}\n  cause: ${cause}`,
    )
  }

  const candidate =
    "createAgentCliClient" in mod ? mod.createAgentCliClient : mod.default
  if (typeof candidate !== "function") {
    throw new Error(
      `createProprietaryProtocolArm: adapter package '${options.adapter}' does not export a ` +
        `'createAgentCliClient' factory function (or a default export function). A ` +
        `protocol="proprietary" adapter must export ` +
        `createAgentCliClient(definition: AgentCliHandle): AgentCliClient | Promise<AgentCliClient>.`,
    )
  }

  return await (candidate as AgentCliClientFactory)(options.definition)
}
