import { createDoctype } from "@agentproto/define-doctype"
import type { OperatorDefinition, OperatorHandle } from "./types.js"

/**
 * AIP-9 id pattern — `^[a-z][a-z0-9-]*[a-z0-9]$` (slug-style, no dots,
 * no underscores, 2+ chars). Stricter than the createDoctype default
 * because operator ids double as dispatch slugs in conversation
 * mentions (`@<slug>`) where dot/underscore would collide with
 * shell/file conventions.
 */
const OPERATOR_ID_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/
const POLICY_REF_PATTERN = /^policy:[A-Za-z0-9_./-]+$/
const AUDIT_REF_PATTERN = /^audit:[A-Za-z0-9_./-]+$/
const SHARE_WITH_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*$/
const TAG_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * AIP-9 reference implementation of `defineOperator`.
 *
 * Built on `createDoctype` so the cross-AIP invariants (id pattern,
 * top-level freeze, "defineOperator (AIP-9): …" error prefix) run
 * uniformly with every other AIP defineX. Spec-9-specific checks live
 * in `validate(def)`; defaulting + nested freezing in `build(def)`.
 *
 * Cross-field invariants enforced:
 *   - persona_summary 1–280 chars (the LLM-facing one-liner)
 *   - profile.role / profile.voice 1–1000 chars
 *   - version matches semver (with optional prerelease/build)
 *   - governance.audit_log shape `audit:<slug>`
 *   - governance.policies entries shape `policy:<slug>`
 *   - memory.kind === "external" requires memory.external.uri
 *   - governance.autonomy === "gated" forces participation.mode in
 *     {mention-only, silent} (matches the schema's allOf/if/then)
 */
export const defineOperator = createDoctype<OperatorDefinition, OperatorHandle>(
  {
    aip: 9,
    name: "operator",
    idPattern: OPERATOR_ID_PATTERN,
    // OPERATOR.md uses `persona_summary` for LLM-facing prose; no
    // `description` field. Use it as the description-equivalent for
    // length validation, capped at 280 per the schema.
    readDescription: (def) => def.persona_summary,
    maxDescriptionLen: 280,
    validate(def) {
      // Required-field shape checks beyond what createDoctype does.
      if (typeof def.name !== "string" || def.name.length === 0 || def.name.length > 80) {
        throw new Error(
          `defineOperator (AIP-9): id='${def.id}' name must be 1–80 chars`,
        )
      }
      if (!VERSION_PATTERN.test(def.version ?? "")) {
        throw new Error(
          `defineOperator (AIP-9): id='${def.id}' version must match ${VERSION_PATTERN}`,
        )
      }
      if (!def.profile) {
        throw new Error(
          `defineOperator (AIP-9): id='${def.id}' profile is required`,
        )
      }
      if (
        typeof def.profile.role !== "string" ||
        def.profile.role.length === 0 ||
        def.profile.role.length > 1000
      ) {
        throw new Error(
          `defineOperator (AIP-9): id='${def.id}' profile.role must be 1–1000 chars`,
        )
      }
      if (
        typeof def.profile.voice !== "string" ||
        def.profile.voice.length === 0 ||
        def.profile.voice.length > 1000
      ) {
        throw new Error(
          `defineOperator (AIP-9): id='${def.id}' profile.voice must be 1–1000 chars`,
        )
      }
      if (!Array.isArray(def.profile.boundaries)) {
        throw new Error(
          `defineOperator (AIP-9): id='${def.id}' profile.boundaries must be an array`,
        )
      }

      // Memory: external kind needs an `external.uri`.
      if (def.memory?.kind === "external" && !def.memory.external?.uri) {
        throw new Error(
          `defineOperator (AIP-9): id='${def.id}' memory.kind='external' requires memory.external.uri`,
        )
      }

      // Governance ref shapes.
      if (def.governance) {
        if (!AUDIT_REF_PATTERN.test(def.governance.audit_log ?? "")) {
          throw new Error(
            `defineOperator (AIP-9): id='${def.id}' governance.audit_log must match ${AUDIT_REF_PATTERN}`,
          )
        }
        for (const p of def.governance.policies ?? []) {
          if (!POLICY_REF_PATTERN.test(p)) {
            throw new Error(
              `defineOperator (AIP-9): id='${def.id}' governance.policies entry '${p}' must match ${POLICY_REF_PATTERN}`,
            )
          }
        }
      }

      // share_with entries follow the operator-id pattern.
      for (const peer of def.memory?.share_with ?? []) {
        if (!SHARE_WITH_PATTERN.test(peer)) {
          throw new Error(
            `defineOperator (AIP-9): id='${def.id}' memory.share_with entry '${peer}' must match ${SHARE_WITH_PATTERN}`,
          )
        }
      }

      // Capabilities + tags: lowercase-slug pattern.
      for (const c of def.capabilities ?? []) {
        if (!CAPABILITY_PATTERN.test(c)) {
          throw new Error(
            `defineOperator (AIP-9): id='${def.id}' capabilities entry '${c}' must match ${CAPABILITY_PATTERN}`,
          )
        }
      }
      for (const t of def.tags ?? []) {
        if (!TAG_PATTERN.test(t)) {
          throw new Error(
            `defineOperator (AIP-9): id='${def.id}' tags entry '${t}' must match ${TAG_PATTERN}`,
          )
        }
      }

      // Cross-field: autonomy=gated → participation.mode in {mention-only, silent}.
      // Mirrors the schema's allOf/if/then. The default participation mode
      // is mention-only (which satisfies the constraint) — only catch
      // explicit "proactive" with "gated".
      if (def.governance?.autonomy === "gated") {
        const mode = def.participation?.mode ?? "mention-only"
        if (mode !== "mention-only" && mode !== "silent") {
          throw new Error(
            `defineOperator (AIP-9): id='${def.id}' governance.autonomy='gated' forbids participation.mode='${mode}' — must be 'mention-only' or 'silent'`,
          )
        }
      }

      // Cross-field: runtime.kind=agent-cli requires runtime.ref.
      if (def.runtime?.kind === "agent-cli" && !def.runtime.ref) {
        throw new Error(
          `defineOperator (AIP-9): id='${def.id}' runtime.kind='agent-cli' requires runtime.ref (e.g. '@agentproto/adapter-hermes#hermes')`,
        )
      }
    },
    build(def) {
      return {
        id: def.id,
        name: def.name,
        persona_summary: def.persona_summary,
        version: def.version,
        entry: def.entry,
        profile: Object.freeze({
          role: def.profile.role,
          voice: def.profile.voice,
          boundaries: Object.freeze([...def.profile.boundaries]),
        }),
        skills: Object.freeze([...(def.skills ?? [])]),
        tools: Object.freeze([...(def.tools ?? [])]),
        memory: def.memory
          ? Object.freeze({
              kind: def.memory.kind,
              policy: def.memory.policy ?? "summarising",
              share_with: Object.freeze([...(def.memory.share_with ?? [])]),
              external: def.memory.external
                ? Object.freeze({ ...def.memory.external })
                : undefined,
            })
          : undefined,
        governance: def.governance
          ? Object.freeze({
              policies: Object.freeze([...(def.governance.policies ?? [])]),
              audit_log: def.governance.audit_log,
              autonomy: def.governance.autonomy,
            })
          : undefined,
        capabilities: Object.freeze([...(def.capabilities ?? [])]),
        participation: def.participation
          ? Object.freeze({
              mode: def.participation.mode ?? "mention-only",
              pass_when: def.participation.pass_when,
              reactions: def.participation.reactions ?? false,
            })
          : Object.freeze({ mode: "mention-only", reactions: false }),
        runtime: def.runtime
          ? Object.freeze({
              kind: def.runtime.kind,
              ref: def.runtime.ref,
              session: def.runtime.session
                ? Object.freeze({
                    mode: def.runtime.session.mode,
                    idle_timeout_ms: def.runtime.session.idle_timeout_ms,
                  })
                : undefined,
            })
          : undefined,
        tags: Object.freeze([...(def.tags ?? [])]),
        metadata: Object.freeze({ ...(def.metadata ?? {}) }),
      }
    },
  },
)
