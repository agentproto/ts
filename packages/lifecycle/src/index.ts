/**
 * @agentproto/lifecycle — AIP-37 event-name vocabulary.
 *
 * Type: Meta. There is no `defineLifecycle` doctype — AIP-37 specifies a
 * shared vocabulary of event names that other AIPs reference (e.g.
 * `STORAGE.md.sync.commit.on: turn-end`). This package exports the
 * constants + alias resolution so consumers get type-safe event names.
 *
 * Spec: https://agentproto.sh/docs/aip-37
 */

export * from "./events.js"
export * from "./hooks.js"
