/**
 * AIP-45 protocol arm: `protocol: "proprietary"`.
 *
 * Loads an NPM adapter package (named in the manifest's `adapter`
 * field) implementing `AgentCliClient`. The package translates the
 * vendor's REPL/proprietary stream into the canonical StreamEvent
 * taxonomy.
 */

import type { AgentCliClient } from "../types.js"

export interface ProprietaryProtocolOptions {
  /** NPM package name to load — from manifest.adapter. */
  adapter: string
}

export async function createProprietaryProtocolArm(
  _options: ProprietaryProtocolOptions,
): Promise<AgentCliClient> {
  throw new Error("createProprietaryProtocolArm: not yet implemented")
}
