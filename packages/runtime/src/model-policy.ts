/**
 * Generic model policy: the only model rule a session can carry. `allow` and
 * `block` hold model-list ids (see `model-list-store.ts`); nothing here knows
 * about price. A session without a policy may use any model its account allows.
 */

import { z } from "zod"
import { inModelList, ModelListError, type ModelListSource } from "@agentproto/model-catalog/lists"

export interface ModelPolicy {
  /** List ids. When present, a model outside every one of them is refused,
   *  uncataloged ids included. */
  allow?: string[]
  /** List ids. A model in any of them is refused; always wins over `allow`. */
  block?: string[]
}

export type PolicyVerdict =
  | { ok: true }
  | { ok: false; code: "model_blocked" | "model_not_allowed" | "unknown_list"; reason: string }

export const modelPolicySchema = z.object({
  allow: z.array(z.string().min(1)).max(32).optional(),
  block: z.array(z.string().min(1)).max(32).optional(),
})

/** Strict schema for caller input (`agent_start`, HTTP spawn): an unknown key
 *  such as `allows` is a validation error, never a silently dropped
 *  restriction. */
export const modelPolicyInputSchema = modelPolicySchema.strict()

/** Tolerant normalizer for already-validated or stored descriptors: dedupes,
 *  returns undefined when the value is not a policy or has neither key. An
 *  empty `allow` is kept: it means "nothing is allowed". Never use it to
 *  validate caller input; use {@link modelPolicyInputSchema}. */
export function normalizeModelPolicy(raw: unknown): ModelPolicy | undefined {
  const parsed = modelPolicySchema.safeParse(raw)
  if (!parsed.success) return undefined
  const { allow, block } = parsed.data
  if (!allow && !block) return undefined
  return {
    ...(allow ? { allow: [...new Set(allow)] } : {}),
    ...(block ? { block: [...new Set(block)] } : {}),
  }
}

function unknownList(err: unknown): PolicyVerdict {
  return {
    ok: false,
    code: "unknown_list",
    reason: err instanceof Error ? err.message : String(err),
  }
}

export function checkModelPolicy(
  model: string,
  policy: ModelPolicy | undefined,
  src: ModelListSource,
): PolicyVerdict {
  if (!policy) return { ok: true }
  for (const id of [...(policy.block ?? []), ...(policy.allow ?? [])]) {
    if (!src.get(id)) return unknownList(new Error(`unknown model list "${id}"`))
  }
  try {
    for (const id of policy.block ?? []) {
      if (inModelList(model, id, src)) {
        return { ok: false, code: "model_blocked", reason: `model "${model}" is in blocked list "${id}"` }
      }
    }
    if (policy.allow && !policy.allow.some(id => inModelList(model, id, src))) {
      return {
        ok: false,
        code: "model_not_allowed",
        reason: `model "${model}" is not in any allowed list (${policy.allow.join(", ") || "none"})`,
      }
    }
    return { ok: true }
  } catch (err) {
    if (err instanceof ModelListError) return unknownList(err)
    throw err
  }
}
