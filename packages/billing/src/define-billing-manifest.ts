import { createDoctype } from "@agentproto/doctype"
import {
  defineAsset,
  meet,
  verifyNoArbitrage,
  type AssetDeclaration,
  type ConvertEdge,
  type PartitionSpec,
  type Restriction,
} from "@agentproto/wallet"
import { billingFrontmatterSchema } from "./schema.js"
import type { BillingDefinition, Offer, Grant } from "./types.js"
import {
  fiatDeclaration,
  fiatPartition,
  isFiatRef,
  normalizeCurrency,
  normalizeRef,
} from "./model.js"
import { entryRatio } from "./rate.js"

/** A conversion with its rate computed (rule 26) and its AIP-49 edge derived. */
export interface DerivedConversion {
  readonly id: string
  readonly from: string
  readonly to: string
  /** Destination major units per source major unit, derived for a fiat `from` (rule 26). */
  readonly ratio: number
  readonly fromDecimals: number
  readonly toDecimals: number
  readonly rail?: string
  readonly mintPartition: string
  readonly expires?: { after: string } | { atPeriodEnd: true }
  readonly bonus?: {
    readonly partition: string
    readonly tiers: readonly (readonly [number, number])[]
  }
  readonly capMinor?: { amount: number; windowSec: number }
  readonly enabled: boolean
  /** Restriction tags of the bonus partition: no conversion draws a lot carrying them (rule 12). */
  readonly excludes: readonly string[]
  /** The edge declared on the asset `from`. `excludes` and `capMinor` are carried here, not in the wallet type (see README, wallet gaps). */
  readonly edge: ConvertEdge
}

export interface BillingDerived {
  readonly assets: ReadonlyMap<string, AssetDeclaration>
  readonly partitions: ReadonlyMap<string, PartitionSpec>
  readonly conversions: ReadonlyMap<string, DerivedConversion>
  readonly offers: ReadonlyMap<string, Offer>
  readonly features: ReadonlyMap<string, "boolean" | "credits">
}

/** The validated, normalised manifest plus everything derived from it. */
export type BillingHandle = Readonly<BillingDefinition> & { readonly derived: BillingDerived }

export interface DefineBillingManifestOptions {
  /** Vendor strategies this host knows (`x-<vendor>:<name>`). An unknown one is refused (rules 21, 25). */
  strategies?: readonly string[]
  /** Oracle rates by source id, for the no-arbitrage check. An oracle edge with no entry is skipped. */
  oracleRates?: Readonly<Record<string, number>>
}

/** Rule 22: refs without `aip://49/`, currency codes upper case. Pure, returns a new object. */
export function normalizeManifest(def: BillingDefinition): BillingDefinition {
  const cur = normalizeCurrency
  const ref = normalizeRef
  const fx = def.fx ? Object.fromEntries(Object.entries(def.fx).map(([k, v]) => [cur(k), v])) : undefined
  return {
    ...def,
    assets: def.assets.map(a => ({ ...a, ref: ref(a.ref) })) as BillingDefinition["assets"],
    primaryAsset: ref(def.primaryAsset),
    anchor: { ...def.anchor, currency: cur(def.anchor.currency) },
    ...(fx ? { fx } : {}),
    conversions: def.conversions?.map(c => ({ ...c, from: ref(c.from), to: ref(c.to) })),
    offers: def.offers?.map(o => ({ ...o, price: { ...o.price, ...(typeof o.price.currency === "string" ? { currency: cur(o.price.currency) } : {}) } }) as Offer),
  }
}

const periodTokens = (g: Grant): boolean => g.trigger.kind === "cron" || g.trigger.kind === "calendar"

/** Every problem of the manifest, in one list. Rules 10 to 14 and 19 to 25 that are about the document itself. */
export function manifestProblems(input: BillingDefinition, opts: DefineBillingManifestOptions = {}): string[] {
  const def = normalizeManifest(input)
  const out: string[] = []
  const known = new Set(opts.strategies ?? [])
  const refused = (where: string, s: string) => {
    if (!known.has(s)) out.push(`${where}: unknown vendor strategy or model '${s}' (not registered by the host)`)
  }

  // assets and partitions
  const declared = new Map<string, BillingDefinition["assets"][number]>()
  const partitions = new Set<string>()
  for (const a of def.assets) {
    if (declared.has(a.ref)) out.push(`assets: '${a.ref}' is declared twice`)
    declared.set(a.ref, a)
    if (isFiatRef(a.ref)) partitions.add(fiatPartition(a.ref))
    if ("partitions" in a) {
      for (const p of a.partitions ?? []) {
        if (p.asset !== a.ref) out.push(`assets.${a.ref}: partition '${p.id}' belongs to '${p.asset}'`)
        partitions.add(p.id)
      }
    }
    if ("ruleSet" in a && a.ruleSet.convertEdges.length > 0) {
      out.push(`assets.${a.ref}: convertEdges must be empty, edges come from \`conversions\` (rule 21)`)
    }
    if ("ruleSet" in a && "peg" in a && a.peg !== undefined) {
      out.push(`assets.${a.ref}: no peg is declared, it is derived from \`anchor\` (rules 10, 26)`)
    }
  }
  const assetOk = (r: string) => declared.has(r)
  const partitionOk = (p: string, where: string) => {
    if (!partitions.has(p)) out.push(`${where}: unknown partition '${p}'`)
  }

  const primary = declared.get(def.primaryAsset)
  if (!primary) out.push(`primaryAsset: '${def.primaryAsset}' is not declared`)
  else if (isFiatRef(def.primaryAsset)) out.push("primaryAsset: must not be a fiat asset")
  const anchorCur = def.anchor.currency
  if (!declared.has(anchorCur) || !isFiatRef(anchorCur)) out.push(`anchor: currency '${anchorCur}' is not a declared fiat asset`)
  for (const k of Object.keys(def.fx ?? {})) {
    if (!declared.has(k) || !isFiatRef(k)) out.push(`fx: '${k}' is not a declared fiat asset`)
  }
  for (const p of def.spendOrder ?? []) partitionOk(p, "spendOrder")
  for (const p of def.transfers?.from ?? []) partitionOk(p, "transfers.from")

  const features = new Map((def.features ?? []).map(f => [f.id, f.type]))
  const rails = new Set<string>()
  for (const r of def.rails) {
    if (rails.has(r.id)) out.push(`rails: duplicate id '${r.id}'`)
    rails.add(r.id)
  }

  // payer
  if (def.payer.strategy.startsWith("x-")) refused("payer.strategy", def.payer.strategy)

  // conversions
  const conversions = new Map<string, NonNullable<BillingDefinition["conversions"]>[number]>()
  let anyFiat = false
  for (const c of def.conversions ?? []) {
    const w = `conversions.${c.id}`
    if (conversions.has(c.id)) out.push(`${w}: duplicate id`)
    conversions.set(c.id, c)
    if (!assetOk(c.from)) out.push(`${w}: unknown asset '${c.from}'`)
    if (!assetOk(c.to)) out.push(`${w}: unknown asset '${c.to}'`)
    const fiat = isFiatRef(c.from)
    if (isFiatRef(c.to)) out.push(`${w}: no conversion to fiat, money leaves only by a rail refund (rule 11)`)
    anyFiat ||= fiat
    if (fiat) {
      if (c.to !== def.primaryAsset) out.push(`${w}: a fiat entry must convert into the primary asset (rule 26)`)
      if (entryRatio(def, c.from) === null) out.push(`${w}: currency '${c.from}' is neither the anchor currency nor a key of fx`)
      if (!c.rail) out.push(`${w}: a fiat conversion needs a rail`)
      else if (!rails.has(c.rail)) out.push(`${w}: unknown rail '${c.rail}'`)
    } else {
      if (c.bonus) out.push(`${w}: bonus on a non-fiat conversion (rule 21)`)
    }
    if (c.mint) {
      partitionOk(c.mint.partition, `${w}.mint`)
      if (!c.mint.partition.startsWith(`${c.to}:`)) out.push(`${w}.mint: partition '${c.mint.partition}' is not a partition of '${c.to}'`)
    }
    if (c.bonus) {
      partitionOk(c.bonus.partition, `${w}.bonus`)
      if (!c.bonus.partition.startsWith(`${c.to}:`)) out.push(`${w}.bonus: partition '${c.bonus.partition}' is not a partition of '${c.to}'`)
    }
  }
  if (anyFiat && !def.taxBasis) out.push("taxBasis: required when a conversion starts from fiat (rule 13)")

  // offers
  const offers = new Map<string, Offer>()
  for (const o of def.offers ?? []) {
    const w = `offers.${o.id}`
    if (offers.has(o.id)) out.push(`${w}: duplicate id`)
    offers.set(o.id, o)
    const model = o.price.model
    if (typeof o.price.currency === "string") {
      const cur = o.price.currency
      if (entryRatio(def, cur) === null) out.push(`${w}: currency '${cur}' is neither the anchor currency nor a key of fx (rule 21)`)
    }
    if (model.startsWith("x-")) refused(w, model)
    if (model === "prepaid-pool") {
      const c = o.convert ? conversions.get(o.convert) : undefined
      if (!o.convert) out.push(`${w}: a prepaid-pool offer needs \`convert\``)
      else if (!c) out.push(`${w}: unknown conversion '${o.convert}'`)
      else if ("currency" in o.price && c.from !== o.price.currency) out.push(`${w}: price currency differs from the conversion source '${c.from}'`)
      if (o.includes) out.push(`${w}: includes on a prepaid-pool offer (rule 21)`)
    } else if (o.convert) out.push(`${w}: convert outside prepaid-pool (rule 21)`)
    if (model === "subscription") {
      if (!o.subscription) out.push(`${w}: a subscription offer needs \`subscription\``)
    } else if (o.subscription) out.push(`${w}: subscription block outside the subscription model (rule 21)`)
    for (const i of o.includes ?? []) {
      const t = features.get(i.feature)
      if (t === undefined) out.push(`${w}.includes: unknown feature '${i.feature}'`)
      if ("amountMinor" in i) {
        if (t !== undefined && t !== "credits") out.push(`${w}.includes: feature '${i.feature}' is not a credits feature`)
        partitionOk(i.partition, `${w}.includes`)
        if (primary && !i.partition.startsWith(`${def.primaryAsset}:`)) out.push(`${w}.includes: partition '${i.partition}' is not a partition of the primary asset`)
      } else if (t !== undefined && t !== "boolean") out.push(`${w}.includes: credits feature '${i.feature}' needs amountMinor and partition`)
    }
    for (const r of Object.keys(o.rail ?? {})) if (!rails.has(r)) out.push(`${w}.rail: unknown rail '${r}'`)
  }

  // grants
  const grantIds = new Set<string>()
  for (const g of def.grants ?? []) {
    const w = `grants.${g.id}`
    if (grantIds.has(g.id)) out.push(`${w}: duplicate id`)
    grantIds.add(g.id)
    partitionOk(g.partition, w)
    if (!g.key.includes("{account}")) out.push(`${w}: key '${g.key}' has no {account} (rules 15, 21)`)
    if (periodTokens(g) && !g.key.includes("{period}")) out.push(`${w}: a scheduled grant key needs {period} (rule 21)`)
    for (const p of g.eligible?.plans ?? []) if (p !== "none" && !offers.has(p)) out.push(`${w}.eligible: unknown offer '${p}'`)
    if ("strategy" in g.amount) refused(`${w}.amount`, g.amount.strategy)
  }
  return out
}

/** Build the derived data. Assumes `manifestProblems` found nothing. */
export function deriveManifest(def: BillingDefinition, opts: DefineBillingManifestOptions = {}): BillingDerived {
  const assets = new Map<string, AssetDeclaration>()
  const partitions = new Map<string, PartitionSpec>()
  const conversions = new Map<string, DerivedConversion>()
  const edgesBySource = new Map<string, ConvertEdge[]>()

  // first pass: raw declarations, to know decimals and partition restrictions
  const raw = new Map<string, AssetDeclaration>()
  for (const a of def.assets) {
    if (isFiatRef(a.ref) && !("name" in a)) raw.set(a.ref, fiatDeclaration(a.ref))
    else raw.set(a.ref, a as unknown as AssetDeclaration)
    for (const p of raw.get(a.ref)?.partitions ?? []) partitions.set(p.id, p)
  }
  const restrictionOf = (p: string): Restriction => partitions.get(p)?.restriction ?? []

  for (const c of def.conversions ?? []) {
    const fromDecl = raw.get(c.from)!
    const toDecl = raw.get(c.to)!
    const ratio = isFiatRef(c.from) ? entryRatio(def, c.from)! : c.rate && c.rate.kind === "fixed" ? c.rate.ratio : 0
    const excludes = c.bonus ? [...restrictionOf(c.bonus.partition)] : []
    const edge: ConvertEdge = {
      to: c.to,
      rate: c.rate && c.rate.kind === "oracle" ? { kind: "oracle", source: c.rate.source } : { kind: "fixed", ratio },
      addsRestriction: [] as Restriction,
      ...(c.capMinor ? { cap: { amount: c.capMinor.amount, windowSec: c.capMinor.windowSec } } : {}),
    }
    conversions.set(c.id, {
      id: c.id,
      from: c.from,
      to: c.to,
      ratio,
      fromDecimals: fromDecl.decimals,
      toDecimals: toDecl.decimals,
      ...(c.rail ? { rail: c.rail } : {}),
      mintPartition: c.mint.partition,
      ...(c.mint.expires ? { expires: c.mint.expires } : {}),
      ...(c.bonus ? { bonus: { partition: c.bonus.partition, tiers: c.bonus.tiers as unknown as [number, number][] } } : {}),
      ...(c.capMinor ? { capMinor: c.capMinor } : {}),
      enabled: c.enabled ?? true,
      excludes,
      edge,
    })
    edgesBySource.set(c.from, [...(edgesBySource.get(c.from) ?? []), edge])
  }

  const credits = def.primaryAsset
  for (const [ref, decl] of raw) {
    const edges = edgesBySource.get(ref) ?? []
    const withPeg = ref === credits ? { peg: { vs: def.anchor.currency, source: `fixed:${1 / def.anchor.creditsPerUnit}` } } : {}
    // defineAsset enforces the AIP-49 structural guards and freezes the result.
    assets.set(
      ref,
      defineAsset({ ...decl, ...withPeg, ruleSet: { ...decl.ruleSet, convertEdges: edges } } as AssetDeclaration),
    )
  }

  const arbitrage = verifyNoArbitrage([...assets.values()], e =>
    e.rate.kind === "fixed" ? e.rate.ratio : (opts.oracleRates?.[e.rate.source] ?? 0),
  )
  if (!arbitrage.ok) {
    throw new Error(`conversions: arbitrage cycle ${arbitrage.cycle?.join(" -> ")} (rule 14)`)
  }

  const offers = new Map<string, Offer>((def.offers ?? []).map(o => [o.id, o]))
  const features = new Map<string, "boolean" | "credits">((def.features ?? []).map(f => [f.id, f.type]))
  return { assets, partitions, conversions, offers, features }
}

/**
 * AIP-74 reference constructor `defineBillingManifest`.
 *
 * Built on `createDoctype`, like every AIP defineX. Field-level validation is
 * the zod schema derived from `BILLING.schema.json` (`./schema.ts`), the same
 * one the `BILLING.md` path runs, so a TypeScript-authored manifest fails with
 * the diagnostic of a malformed file. The cross-reference rules of AIP-74 rule
 * 21 and the arbitrage check of rule 14 then run on the normalised document.
 */
export function defineBillingManifest(def: BillingDefinition, opts: DefineBillingManifestOptions = {}): BillingHandle {
  return createDoctype<BillingDefinition, BillingHandle>({
    aip: 74,
    name: "billingManifest",
    readIdentity: d => d.name,
    readDescription: d => d.title,
    validate(d) {
      const shape = billingFrontmatterSchema.safeParse(d)
      if (!shape.success) {
        throw new Error(
          `defineBillingManifest (AIP-74): ${shape.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        )
      }
      // Cross-field rules of the JSON Schema (if/then) and rule 21 are not zod-shaped.
      const problems = manifestProblems(d, opts)
      if (problems.length > 0) throw new Error(`defineBillingManifest (AIP-74): ${problems.join("; ")}`)
    },
    build(d) {
      const normalized = normalizeManifest(d)
      return { ...normalized, derived: deriveManifest(normalized, opts) } as BillingHandle
    },
  })(def)
}
