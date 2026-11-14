/**
 * AIP-47 §Slots: the typed holes a role declares, and the pure validation of
 * an operator's `role.bind` / `role.with` against them (§Validating a binding).
 *
 * Nothing here fetches. A ref is classified from its own spelling, using the
 * AIP-54 collection table; a ref that is well typed but unknown to the host is
 * the warning `role_slot_unresolvable`, reported only when the caller hands in
 * a `refResolves` predicate.
 */

import { z } from "zod"

export type SlotScalarType = "string" | "number" | "boolean"
export type SlotScalar = string | number | boolean

interface SlotCommon {
  /** Label shown in the rendered bindings block and in a hiring UI. */
  description?: string
  /** An optional slot may be left unbound. */
  optional?: boolean
}

/** A ref to an artifact whose doctype is owned by AIP `aip`. Never 38. */
export interface RoleSlotAip extends SlotCommon {
  aip: number
}
/** A ref whose kind belongs to `collection`. Never `policies`. */
export interface RoleSlotCollection extends SlotCommon {
  collection: string
}
/** `mcp`: a `{kind: mcp, server, allow?, deny?}` ref. `ref`: one `<server>/<name>` tool. */
export interface RoleSlotTool extends SlotCommon {
  tool: "mcp" | "ref"
}
/** A JSON scalar, filled through `role.with`. */
export interface RoleSlotScalar extends SlotCommon {
  scalar: SlotScalarType
  enum?: SlotScalar[]
  default?: SlotScalar
}

export type RoleSlot =
  | RoleSlotAip
  | RoleSlotCollection
  | RoleSlotTool
  | RoleSlotScalar

export type RoleSlots = Record<string, RoleSlot>

/** The `{kind: mcp, ...}` value a `{tool: mcp}` slot takes (AIP-42 `tools`). */
export interface McpToolRefValue {
  kind: "mcp"
  server: string
  allow?: string[]
  deny?: string[]
}

/** An operator's `role.bind` and `role.with` (AIP-9 §Role binding). */
export interface RoleBinding {
  bind?: Readonly<Record<string, unknown>>
  with?: Readonly<Record<string, unknown>>
}

export type RoleBindingErrorCode =
  | "role_slot_unknown"
  | "role_slot_unbound"
  | "role_slot_type_mismatch"

export interface RoleBindingError {
  code: RoleBindingErrorCode
  slot: string
  message: string
}

export interface RoleBindingWarning {
  code: "role_slot_unresolvable"
  slot: string
  message: string
}

export interface RoleBindingResult {
  /** False iff `errors` is not empty. Errors are errors of the operator, never of the role. */
  ok: boolean
  errors: RoleBindingError[]
  warnings: RoleBindingWarning[]
}

export interface ValidateBindingOptions {
  /**
   * Host-supplied, synchronous: does this well typed ref resolve in the host?
   * Absent = nobody is asked and no `role_slot_unresolvable` is emitted.
   */
  refResolves?: (ref: unknown, slot: string) => boolean
}

const SLOT_NAME = /^[a-z][a-z0-9_]{0,63}$/
const TOOL_PART = "[A-Za-z0-9_.-]+"
const TOOL_NAME = new RegExp(`^${TOOL_PART}$`)

/** AIP-54 `ws://` collection to kind and owning AIP (null = host registry). */
const WS_COLLECTIONS: Readonly<Record<string, { kind: string; aip: number | null }>> = {
  operators: { kind: "operator", aip: 9 },
  personas: { kind: "persona", aip: 25 },
  users: { kind: "user", aip: null },
  sessions: { kind: "session", aip: 46 },
  companies: { kind: "company", aip: 6 },
  collections: { kind: "collection_doc", aip: 18 },
  wikis: { kind: "wiki", aip: 10 },
  workspaces: { kind: "workspace", aip: 34 },
  skills: { kind: "skill", aip: 3 },
  identities: { kind: "identity_workspace", aip: 23 },
  playbooks: { kind: "playbook", aip: 12 },
  agencies: { kind: "agency", aip: 21 },
  tools: { kind: "tool", aip: 14 },
  roles: { kind: "role", aip: 47 },
  assemblies: { kind: "assembly", aip: 24 },
  actions: { kind: "action", aip: 39 },
  policies: { kind: "policy", aip: 38 },
  workflows: { kind: "workflow", aip: 15 },
  offices: { kind: "office", aip: 22 },
  avatars: { kind: "avatar", aip: 25 },
  orgs: { kind: "org", aip: null },
  guilds: { kind: "guild", aip: null },
}

/** AIP-54 §Base collections: the cross-cutting groupings of compact kinds. */
const BASE_COLLECTIONS: Readonly<Record<string, readonly string[]>> = {
  file: ["local", "url", "git", "github", "ipfs"],
  identity: ["operator", "user", "persona", "email"],
  anchor: ["eth_tx", "ots"],
  chain: ["eth_tx"],
}

const COLLECTION_OF_KIND = new Map<string, string>(
  Object.entries(WS_COLLECTIONS).map(([collection, { kind }]) => [kind, collection]),
)
const BASE_KINDS = new Set(Object.values(BASE_COLLECTIONS).flat())

interface RefFamily {
  /** The AIP that owns the referenced doctype; null when no AIP owns it. */
  aip: number | null
  /** Every collection the ref belongs to: its `ws://` collection and base collections. */
  collections: ReadonlySet<string>
}

function collectionsOfKind(kind: string): Set<string> {
  const out = new Set<string>()
  const ws = COLLECTION_OF_KIND.get(kind)
  if (ws) out.add(ws)
  for (const [name, kinds] of Object.entries(BASE_COLLECTIONS)) {
    if (kinds.includes(kind)) out.add(name)
  }
  return out
}

function familyOfAip(aip: number): RefFamily {
  const collections = new Set<string>()
  for (const [name, c] of Object.entries(WS_COLLECTIONS)) {
    if (c.aip === aip) collections.add(name)
  }
  return { aip, collections }
}

const AIP_URI = /^aip:\/\/([1-9][0-9]*)\/[^\s/@]+(?:@\S+)?$/
const WS_URI = /^ws:\/\/([a-z][a-z0-9-]*)\/(\S+)$/
const COMPACT = /^([a-z][a-z0-9_]*):(\S+)$/

/** Read the family of an AIP-54 ref from its spelling alone. Null = not a ref. */
export function classifyRef(value: unknown): RefFamily | null {
  if (typeof value === "string") {
    const aipUri = AIP_URI.exec(value)
    if (aipUri) return familyOfAip(Number(aipUri[1]))
    const ws = WS_URI.exec(value)
    if (ws) {
      const entry = WS_COLLECTIONS[ws[1]!]
      if (!entry) return null
      return { aip: entry.aip, collections: collectionsOfKind(entry.kind) }
    }
    const compact = COMPACT.exec(value)
    if (compact) {
      const kind = compact[1]!
      const ws = COLLECTION_OF_KIND.get(kind)
      if (!ws && !BASE_KINDS.has(kind)) return null
      return { aip: ws ? WS_COLLECTIONS[ws]!.aip : null, collections: collectionsOfKind(kind) }
    }
    return null
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    const keys = Object.keys(o)
    if (
      keys.every((k) => k === "aip" || k === "id" || k === "version") &&
      typeof o.aip === "number" &&
      Number.isInteger(o.aip) &&
      o.aip >= 1 &&
      typeof o.id === "string" &&
      o.id.length > 0 &&
      (o.version === undefined || typeof o.version === "string")
    ) {
      return familyOfAip(o.aip)
    }
  }
  return null
}

function isMcpToolRef(value: unknown): value is McpToolRefValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (!Object.keys(o).every((k) => k === "kind" || k === "server" || k === "allow" || k === "deny")) {
    return false
  }
  if (o.kind !== "mcp" || typeof o.server !== "string" || !TOOL_NAME.test(o.server)) return false
  for (const list of [o.allow, o.deny]) {
    if (list === undefined) continue
    if (!Array.isArray(list)) return false
    if (!list.every((n) => typeof n === "string" && TOOL_NAME.test(n))) return false
  }
  return true
}

const TOOL_REF = new RegExp(`^(?:tool:|ws://tools/)${TOOL_PART}/${TOOL_PART}$`)

function isScalarSlot(slot: RoleSlot): slot is RoleSlotScalar {
  return "scalar" in slot
}

function isRequired(slot: RoleSlot): boolean {
  if (slot.optional === true) return false
  if (isScalarSlot(slot) && slot.default !== undefined) return false
  return true
}

function describeSlot(slot: RoleSlot): string {
  if ("aip" in slot) return `a ref to an AIP-${slot.aip} artifact`
  if ("collection" in slot) return `a ref of the '${slot.collection}' collection`
  if ("tool" in slot) {
    return slot.tool === "mcp"
      ? "a {kind: mcp, server} tool ref"
      : "a '<server>/<name>' tool ref (tool: or ws://tools/)"
  }
  const base = `a ${slot.scalar}`
  return slot.enum ? `${base} among ${JSON.stringify(slot.enum)}` : base
}

function matches(slot: RoleSlot, value: unknown): boolean {
  if ("aip" in slot) return classifyRef(value)?.aip === slot.aip
  if ("collection" in slot) return classifyRef(value)?.collections.has(slot.collection) === true
  if ("tool" in slot) {
    return slot.tool === "mcp" ? isMcpToolRef(value) : typeof value === "string" && TOOL_REF.test(value)
  }
  if (typeof value !== slot.scalar) return false
  if (typeof value === "number" && !Number.isFinite(value)) return false
  return slot.enum === undefined || slot.enum.includes(value as SlotScalar)
}

/**
 * Validate an operator's binding against the MERGED slots of its resolved role.
 *
 * 1. every `bind` key names a declared non-scalar slot and every `with` key a
 *    declared scalar slot (`role_slot_unknown`);
 * 2. every required slot is bound (`role_slot_unbound`);
 * 3. every value matches its slot (`role_slot_type_mismatch`).
 *
 * Pure: it reads the values and never fetches. The three codes are errors of
 * the operator: the operator does not load, the role still does.
 */
export function validateRoleBinding(
  slots: Readonly<Record<string, RoleSlot>> | undefined,
  binding: RoleBinding | undefined,
  options: ValidateBindingOptions = {},
): RoleBindingResult {
  const declared = slots ?? {}
  const errors: RoleBindingError[] = []
  const warnings: RoleBindingWarning[] = []
  const bound = new Set<string>()

  const check = (block: "bind" | "with", values: Readonly<Record<string, unknown>> | undefined) => {
    for (const [name, value] of Object.entries(values ?? {})) {
      const slot = Object.hasOwn(declared, name) ? declared[name] : undefined
      if (!slot || isScalarSlot(slot) !== (block === "with")) {
        errors.push({
          code: "role_slot_unknown",
          slot: name,
          message: slot
            ? `'${block}.${name}' names a ${isScalarSlot(slot) ? "scalar slot, filled through 'with'" : "ref or tool slot, filled through 'bind'"}`
            : `'${block}.${name}' names no slot of the role`,
        })
        continue
      }
      bound.add(name)
      if (!matches(slot, value)) {
        errors.push({
          code: "role_slot_type_mismatch",
          slot: name,
          message: `'${block}.${name}' expects ${describeSlot(slot)}`,
        })
      } else if (!isScalarSlot(slot) && options.refResolves && !options.refResolves(value, name)) {
        warnings.push({
          code: "role_slot_unresolvable",
          slot: name,
          message: `'${block}.${name}' is well typed but does not resolve`,
        })
      }
    }
  }
  check("bind", binding?.bind)
  check("with", binding?.with)

  for (const [name, slot] of Object.entries(declared)) {
    if (isRequired(slot) && !bound.has(name)) {
      errors.push({
        code: "role_slot_unbound",
        slot: name,
        message: `required slot '${name}' is not bound (${describeSlot(slot)})`,
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

const slotCommon = {
  description: z.string().min(1).max(280).optional(),
  optional: z.boolean().optional(),
}
const scalarValue = z.union([z.string(), z.number(), z.boolean()])

const slotSchema = z.union([
  z.object({ aip: z.number().int().min(1), ...slotCommon }).strict(),
  z.object({ collection: z.string().regex(/^[a-z][a-z0-9-]*$/), ...slotCommon }).strict(),
  z.object({ tool: z.enum(["mcp", "ref"]), ...slotCommon }).strict(),
  z
    .object({
      scalar: z.enum(["string", "number", "boolean"]),
      enum: z.array(scalarValue).min(1).optional(),
      default: scalarValue.optional(),
      ...slotCommon,
    })
    .strict(),
])

/** Zod schema of a ROLE `slots` map. A policy-typed slot is refused (AIP-47 §What a slot does not do). */
export const roleSlotsSchema = z
  .record(z.string().regex(SLOT_NAME, "slot names match ^[a-z][a-z0-9_]{0,63}$"), slotSchema)
  .superRefine((all, ctx) => {
    for (const [name, slot] of Object.entries(all)) {
      const isPolicy =
        ("aip" in slot && slot.aip === 38) ||
        ("collection" in slot && slot.collection === "policies")
      if (isPolicy) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `slot '${name}' is policy-typed: a slot never carries a policy (bind it on the operator)`,
        })
      }
      if (isScalarSlot(slot)) {
        const bad = [slot.default, ...(slot.enum ?? [])].find(
          (v) => v !== undefined && typeof v !== slot.scalar,
        )
        if (bad !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: `slot '${name}': default and enum values must be of type ${slot.scalar}`,
          })
        }
        if (slot.default !== undefined && slot.enum && !slot.enum.includes(slot.default)) {
          ctx.addIssue({
            code: "custom",
            path: [name, "default"],
            message: `slot '${name}': default is not one of enum`,
          })
        }
      }
    }
  })
