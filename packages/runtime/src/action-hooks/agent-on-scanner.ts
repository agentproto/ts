/**
 * Agent `on` scanner: re-read every `<workspace>/.agents/<id>/AGENT.md` and
 * turn each manifest's AIP-42 `on` map into resolved event bindings.
 *
 * The scanner never rejects and never touches the runner. It caches the last
 * result so `createReactionWiring` can read it synchronously on every
 * reconcile. A manifest that fails to load is logged and skipped; a manifest
 * whose `on` map is present but invalid becomes one refusal entry for the
 * whole agent, never a partial binding set.
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { loadAgent } from "@agentproto/agent"
import { stripOwner } from "@agentproto/app"
import { isClerkTurnEndEntry } from "./clerk-on-entry.js"
import {
  resolveAgentOnBindings,
  type ResolvedEventBinding,
} from "./event-bindings.js"

const LOG_PREFIX = "[agent-on-scanner]"

export interface AgentOnScanError {
  agentId: string
  error: string
}

export interface AgentOnScanResult {
  bindings: ResolvedEventBinding[]
  /** One entry per agent whose `on` map was present but invalid; reported as refused `<agent-id>/on`. */
  errors: AgentOnScanError[]
}

export interface AgentOnScanner {
  /** Re-read every manifest of the workspace; replaces the cached result. Never rejects. */
  rescan(): Promise<AgentOnScanResult>
  /** The cached result of the last rescan (empty before the first). */
  current(): AgentOnScanResult
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function copy(result: AgentOnScanResult): AgentOnScanResult {
  return {
    bindings: result.bindings.slice(),
    errors: result.errors.map(entry => ({ ...entry })),
  }
}

function emptyResult(): AgentOnScanResult {
  return { bindings: [], errors: [] }
}

function hasEntries(on: unknown): boolean {
  if (on === undefined) return false
  if (typeof on !== "object" || on === null) return true
  return Object.keys(on).length > 0
}

export function createAgentOnScanner(opts: {
  workspace: string
  loadAgent?: typeof loadAgent
  log?: (line: string) => void
}): AgentOnScanner {
  const log = opts.log ?? ((line: string): void => console.warn(line))
  const load = opts.loadAgent ?? loadAgent
  const loggedLoadFailures = new Set<string>()
  let cached = emptyResult()

  return {
    current(): AgentOnScanResult {
      return copy(cached)
    },

    async rescan(): Promise<AgentOnScanResult> {
      try {
        const agentsDir = join(opts.workspace, ".agents")
        let names: string[]
        try {
          const entries = await readdir(agentsDir, { withFileTypes: true })
          names = entries
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort()
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            cached = emptyResult()
            return copy(cached)
          }
          throw err
        }

        const bindings: ResolvedEventBinding[] = []
        const errors: AgentOnScanError[] = []
        const seen = new Set<string>()

        for (const name of names) {
          const path = join(agentsDir, name, "AGENT.md")
          let handle
          try {
            handle = (await load(path, { workspace: opts.workspace })).handle
          } catch (err) {
            const message = messageOf(err)
            const key = `${path}\u0000${message}`
            if (!loggedLoadFailures.has(key)) {
              loggedLoadFailures.add(key)
              log(`${LOG_PREFIX} skipped ${path}: ${message}`)
            }
            continue
          }

          const agentId = stripOwner(handle.id)
          if (seen.has(agentId)) {
            errors.push({ agentId, error: "duplicate agent id" })
            continue
          }
          seen.add(agentId)

          if (!hasEntries(handle.on)) continue

          try {
            // The clerk's turn-end entry is read at spawn (it enables the clerk
            // hook); it is not a reaction binding, so it must not reach the
            // wiring and be refused there as an unsupported event.
            bindings.push(
              ...resolveAgentOnBindings(agentId, handle.on).filter(
                binding =>
                  !(
                    "action" in binding.target &&
                    isClerkTurnEndEntry(binding.event.event, binding.target.action)
                  ),
              ),
            )
          } catch (err) {
            errors.push({ agentId, error: messageOf(err) })
          }
        }

        cached = { bindings, errors }
        return copy(cached)
      } catch (err) {
        log(`${LOG_PREFIX} rescan failed: ${messageOf(err)}`)
        return copy(cached)
      }
    },
  }
}
