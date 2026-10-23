/**
 * Model lists — named, user-editable selections over the model catalog.
 *
 * A list is data: a set of include selectors (OR), optional exclusions that
 * always win, explicit id pins, and an ordering mode. The selector vocabulary
 * is the existing `AccessTarget` matcher plus the catalog dimensions that have
 * no access-rule target (price, context window, route variant) and list
 * composition.
 *
 * `zero-cost` (the seed list) is the one way "free" is expressed in code now:
 * `{ include: [{ kind: "tag", value: "price:zero" }] }`.
 */

import type { AccessTarget } from "../access/types.js"
import { modelMatchesTarget } from "../access/evaluate.js"
import { isZeroPriced } from "../enrichment/index.js"
import { resolveContextWindow } from "../llm/index.js"
import type { ResolvedModel } from "../registry/index.js"
import { getModel, listModels, resolveAlias } from "../registry/index.js"
import {
  formatModelRef,
  listRouterLlmRoutes,
  resolveLlmModelRoute,
  stripRouteSuffix,
  tryParseModelRef,
} from "../route-identity/index.js"

export type ModelSelector =
  | AccessTarget
  | { kind: "price"; maxInPer1M?: number; maxOutPer1M?: number }
  | { kind: "context"; min: number }
  | { kind: "variant"; value: string }
  | { kind: "list"; id: string }

/** A named selection over the model catalog. An uncataloged `ids` pin is only
 *  removed by a `{ kind: "model" }` exclude; no other selector can match an id
 *  the catalog does not know. */
export interface ModelList {
  id: string
  label?: string
  include?: ModelSelector[]
  exclude?: ModelSelector[]
  ids?: string[]
  order?: "listed" | "cheapest" | "largest-context" | "newest"
  rotation?: "priority" | "round-robin" | "least-recently-limited"
}

export interface ModelListSource {
  get(id: string): ModelList | undefined
}

export class ModelListError extends Error {
  readonly name = "ModelListError"
}

/** Routers whose generated route tables are part of the catalog surface. */
const ROUTERS = [
  "openrouter",
  "requesty",
  "huggingface",
  "opencode",
  "opencode-go",
] as const

/**
 * Every LLM candidate selectors can match: the registry's own `listModels`
 * view plus each router's generated route table (whose ids, e.g.
 * `opencode/big-pickle`, the bare-id registry deliberately does not carry).
 */
let candidateCache: ResolvedModel[] | undefined
let candidateIndexCache: Map<string, ResolvedModel> | undefined
const subjectIdsCache = new Map<string, string[]>()

function candidates(): ResolvedModel[] {
  if (candidateCache) return candidateCache
  const out = listModels({ kind: "llm" })
  const seen = new Set(out.map(model => model.id))
  for (const router of ROUTERS) {
    for (const route of listRouterLlmRoutes(router)) {
      const id = formatModelRef(route.ref)
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        kind: "llm",
        id,
        canonicalId: route.canonicalProductId,
        pricing: route.pricing,
        provider: route.pricing.provider,
      })
    }
  }
  candidateCache = out
  return out
}

/** Test/consumer helper after an overlay or route registration changes. */
export function clearModelListCache(): void {
  candidateCache = undefined
  candidateIndexCache = undefined
  subjectIdsCache.clear()
}

function selectorLabel(selector: ModelSelector): string {
  switch (selector.kind) {
    case "model":
      return `model:${selector.id}`
    case "price":
      return `price:${selector.maxInPer1M ?? "*"}/${selector.maxOutPer1M ?? "*"}`
    case "context":
      return `context:>=${selector.min}`
    case "variant":
      return `variant:${selector.value}`
    case "list":
      return `list:${selector.id}`
    default:
      return `${selector.kind}:${selector.value}`
  }
}

function isListSelector(
  selector: ModelSelector,
): selector is Extract<ModelSelector, { kind: "list" }> {
  return selector.kind === "list"
}

function contextWindowOf(model: ResolvedModel): number | undefined {
  if (model.kind !== "llm") return undefined
  return (
    resolveContextWindow(model.id)?.contextWindow ??
    resolveContextWindow(model.canonicalId)?.contextWindow
  )
}

function variantOf(id: string): string | undefined {
  const ref = tryParseModelRef(id)
  return ref?.variant
}

/**
 * Does a selector match one model? `model` is the catalog candidate when one
 * exists; `rawId` is the id being tested (a route-suffixed or bare spelling
 * may differ from the catalog key). Uncataloged ids only match through an
 * explicit `ids` pin, handled by the caller.
 */
function selectorMatches(
  selector: ModelSelector,
  model: ResolvedModel | undefined,
  rawId: string,
  src: ModelListSource,
  stack: string[],
): boolean {
  if (isListSelector(selector)) {
    return inList(selector.id, rawId, src, stack)
  }
  switch (selector.kind) {
    case "variant":
      return variantOf(rawId) === selector.value ||
        (model !== undefined && variantOf(model.id) === selector.value)
    case "price": {
      const pricing = model?.kind === "llm" ? model.pricing : undefined
      if (!pricing) return false
      if (
        selector.maxInPer1M !== undefined &&
        pricing.inputPer1M > selector.maxInPer1M
      ) {
        return false
      }
      if (
        selector.maxOutPer1M !== undefined &&
        pricing.outputPer1M > selector.maxOutPer1M
      ) {
        return false
      }
      return true
    }
    case "context": {
      if (!model) return false
      const window = contextWindowOf(model)
      return window !== undefined && window >= selector.min
    }
    default:
      return model !== undefined && modelMatchesTarget(selector, model)
  }
}

/** Exclusion is a negation: an explicit `model` target must also be able to
 *  remove an uncataloged `ids` pin, which no include selector can match. */
function excludeMatches(
  selector: ModelSelector,
  model: ResolvedModel | undefined,
  rawId: string,
  src: ModelListSource,
  stack: string[],
): boolean {
  if (
    selector.kind === "model" &&
    pinsMatch(selector.id, rawId)
  ) {
    return true
  }
  return selectorMatches(selector, model, rawId, src, stack)
}

function candidateIndex(): Map<string, ResolvedModel> {
  if (candidateIndexCache) return candidateIndexCache
  const index = new Map<string, ResolvedModel>()
  for (const model of candidates()) index.set(model.id, model)
  candidateIndexCache = index
  return index
}

/**
 * Normalize a model id to the catalog spellings it may match. A trailing
 * `@<route>` is stripped; the registry and the route resolver get a chance;
 * and a bare id (`big-pickle`) also matches catalog ids whose last `/`
 * segment equals it (`opencode/big-pickle`).
 */
function subjectIds(raw: string): string[] {
  const cached = subjectIdsCache.get(raw)
  if (cached) return cached
  const stripped = stripRouteSuffix(raw)
  const out = new Set<string>([raw, stripped])
  const consider = (id: string): void => {
    out.add(id)
    const model = getModel(id)
    if (model) {
      out.add(model.id)
      if (model.kind === "llm") out.add(model.canonicalId)
    }
    out.add(resolveAlias(id))
    try {
      const route = resolveLlmModelRoute(id)
      if (route) {
        out.add(formatModelRef(route.ref))
        out.add(`${route.vendor}/${route.product}`)
      }
    } catch {
      // Not a canonical `vendor/product` ref (e.g. an internal `~vendor/...`
      // spelling). It can still match through `ids` or a bare-id key.
    }
  }
  consider(stripped)
  if (!stripped.includes("/")) {
    const bare = stripped.split(":")[0] ?? stripped
    for (const model of candidates()) {
      const segment = model.id.split("/").pop()?.split(":")[0]
      if (segment === bare) out.add(model.id)
    }
  }
  const result = [...out]
  subjectIdsCache.set(raw, result)
  return result
}

function pinsMatch(pin: string, id: string): boolean {
  if (pin === id) return true
  const pinStripped = stripRouteSuffix(pin)
  const idStripped = stripRouteSuffix(id)
  return pin === idStripped || pinStripped === id || pinStripped === idStripped
}

function listContains(
  list: ModelList,
  rawId: string,
  src: ModelListSource,
  stack: string[],
): boolean {
  const index = candidateIndex()
  const model = index.get(rawId) ?? index.get(stripRouteSuffix(rawId))
  for (const selector of list.exclude ?? []) {
    if (excludeMatches(selector, model, rawId, src, stack)) return false
  }
  if ((list.ids ?? []).some(pin => pinsMatch(pin, rawId))) return true
  return (list.include ?? []).some(selector =>
    selectorMatches(selector, model, rawId, src, stack),
  )
}

/** Membership of ONE normalized id in a list (no subject expansion). */
function inList(
  listId: string,
  rawId: string,
  src: ModelListSource,
  stack: string[],
): boolean {
  const list = src.get(listId)
  if (!list) throw new ModelListError(`unknown model list "${listId}"`)
  if (stack.includes(listId)) {
    throw new ModelListError(
      `model list cycle: ${[...stack, listId].join(" -> ")}`,
    )
  }
  return listContains(list, rawId, src, [...stack, listId])
}

/** Membership without full expansion; uncataloged ids match only via `ids`. */
export function inModelList(
  model: string,
  id: string,
  src: ModelListSource,
): boolean {
  return subjectIds(model).some(candidate =>
    inList(id, candidate, src, []),
  )
}

interface ResolvedEntry {
  model: string
  via: string
}

function insert(
  entries: Map<string, ResolvedEntry>,
  model: string,
  via: string,
): void {
  if (!entries.has(model)) entries.set(model, { model, via })
}

function resolveEntries(
  id: string,
  src: ModelListSource,
  stack: string[],
): ResolvedEntry[] {
  const list = src.get(id)
  if (!list) throw new ModelListError(`unknown model list "${id}"`)
  if (stack.includes(id)) {
    throw new ModelListError(`model list cycle: ${[...stack, id].join(" -> ")}`)
  }
  const nextStack = [...stack, id]
  const entries = new Map<string, ResolvedEntry>()
  const index = candidateIndex()
  const all = candidates()

  for (const selector of list.include ?? []) {
    if (isListSelector(selector)) {
      for (const entry of resolveEntries(selector.id, src, nextStack)) {
        insert(entries, entry.model, `list:${selector.id}`)
      }
      continue
    }
    for (const model of all) {
      if (selectorMatches(selector, model, model.id, src, nextStack)) {
        insert(entries, model.id, selectorLabel(selector))
      }
    }
  }
  for (const pin of list.ids ?? []) insert(entries, pin, "ids")

  for (const selector of list.exclude ?? []) {
    if (isListSelector(selector)) {
      for (const entry of resolveEntries(selector.id, src, nextStack)) {
        entries.delete(entry.model)
      }
      continue
    }
    for (const model of all) {
      if (selectorMatches(selector, model, model.id, src, nextStack)) {
        entries.delete(model.id)
      }
    }
    for (const key of [...entries.keys()]) {
      if (excludeMatches(selector, index.get(key), key, src, nextStack)) {
        entries.delete(key)
      }
    }
  }

  return [...entries.values()]
}

function applyOrder(
  entries: ResolvedEntry[],
  order: ModelList["order"],
  index: Map<string, ResolvedModel>,
): ResolvedEntry[] {
  if (!order || order === "listed" || entries.length === 0) return entries
  const pricingOf = (entry: ResolvedEntry) => {
    const model = index.get(entry.model)
    return model?.kind === "llm" ? model.pricing : undefined
  }
  const sorted = [...entries]
  sorted.sort((a, b) => {
    const pa = pricingOf(a)
    const pb = pricingOf(b)
    if (order === "cheapest") {
      const ca = pa ? pa.inputPer1M + pa.outputPer1M : Number.POSITIVE_INFINITY
      const cb = pb ? pb.inputPer1M + pb.outputPer1M : Number.POSITIVE_INFINITY
      return ca - cb
    }
    if (order === "largest-context") {
      const ma = index.get(a.model)
      const mb = index.get(b.model)
      const ca = ma ? contextWindowOf(ma) ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY
      const cb = mb ? contextWindowOf(mb) ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY
      return cb - ca
    }
    // newest — a missing `addedAt` sorts last.
    const aa = pa?.addedAt ?? ""
    const ab = pb?.addedAt ?? ""
    return aa === ab ? 0 : aa < ab ? 1 : -1
  })
  return sorted
}

/** Ordered, de-duplicated model ids. Throws ModelListError on unknown id or cycle. */
export function resolveModelList(id: string, src: ModelListSource): string[] {
  const list = src.get(id)
  if (!list) throw new ModelListError(`unknown model list "${id}"`)
  const entries = resolveEntries(id, src, [])
  return applyOrder(entries, list.order, candidateIndex()).map(
    entry => entry.model,
  )
}

/** Explain: per model, which selector or pin included it. */
export function explainModelList(
  id: string,
  src: ModelListSource,
): Array<{ model: string; via: string }> {
  const list = src.get(id)
  if (!list) throw new ModelListError(`unknown model list "${id}"`)
  const entries = resolveEntries(id, src, [])
  return applyOrder(entries, list.order, candidateIndex()).map(entry => ({
    model: entry.model,
    via: entry.via,
  }))
}

/** True iff the model is in a zero-priced list entry; re-exported for convenience. */
export { isZeroPriced }
