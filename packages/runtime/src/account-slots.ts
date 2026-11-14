/**
 * Account slots: a named indirection between a `profileRef` and a real auth
 * profile (AIP-46 access axis, `accountSlots` in `~/.agentproto/config.json`).
 *
 * Code and presets name a SLOT (`slot:claude-primary`), never a real account.
 * The slot map translates it to a profile id at the moment of use:
 *
 * ```json
 * "accountSlots": {
 *   "claude-primary": "anthropic-sub-hodl",
 *   "claude-secondary": "claude-subs-agentik"
 * }
 * ```
 *
 * Changing subscription is then one config write (or `agentproto accounts
 * swap claude`), not a commit. There is ONE resolution point,
 * {@link resolveProfileRef}: a `slot:<name>` ref becomes the real profile id,
 * any other ref passes through unchanged. An unknown slot, or a slot pointing
 * at a missing or disabled profile, is an explicit error at use time. There is
 * never a silent fallback to some other profile.
 *
 * Slot names carry no dot: `config_get` / `config_set` paths are dotted, so a
 * dotted slot name could not be addressed as `accountSlots.<name>`.
 */

import { getAuthProfile as defaultGetAuthProfile, type AuthProfile } from "@agentproto/auth"
import { loadConfig, saveConfig, type AgentprotoConfig } from "./config.js"

import { ACCOUNT_SLOT_NAME_RE, SLOT_REF_PREFIX } from "./account-slot-ref.js"

export { ACCOUNT_SLOT_NAME_RE, SLOT_REF_PREFIX }

/** The `accountSlots` map: slot name -> real auth-profile id. */
export type AccountSlots = Record<string, string>

export type AccountSlotErrorCode =
  | "account_slot_invalid"
  | "account_slot_unknown"
  | "account_slot_profile_missing"
  | "account_slot_profile_disabled"

/** A slot reference that cannot be resolved. Always surfaced to the caller,
 *  never swallowed into a fallback. */
export class AccountSlotError extends Error {
  readonly code: AccountSlotErrorCode
  readonly slot: string
  constructor(code: AccountSlotErrorCode, slot: string, message: string) {
    super(message)
    this.name = "AccountSlotError"
    this.code = code
    this.slot = slot
  }
}

/** True when `ref` is a `slot:<name>` reference. */
export function isSlotRef(ref: string | undefined | null): ref is string {
  return typeof ref === "string" && ref.startsWith(SLOT_REF_PREFIX)
}

/** The slot name of a `slot:<name>` ref, or undefined for a plain id. */
export function slotNameOf(ref: string | undefined | null): string | undefined {
  return isSlotRef(ref) ? ref.slice(SLOT_REF_PREFIX.length) : undefined
}

/** `slot:<name>` for a slot name. */
export function slotRef(name: string): string {
  return `${SLOT_REF_PREFIX}${name}`
}

/** Read the `accountSlots` map from config.json (empty when absent). */
export async function loadAccountSlots(path?: string): Promise<AccountSlots> {
  const cfg = await loadConfig(path)
  return accountSlotsOf(cfg)
}

/** The well-formed `accountSlots` entries of a config. A malformed value
 *  (not a string) is dropped here; resolving its slot then fails as unknown,
 *  loudly, rather than billing something unexpected. */
export function accountSlotsOf(cfg: AgentprotoConfig): AccountSlots {
  const raw = cfg.accountSlots
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: AccountSlots = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.length > 0) out[name] = value
  }
  return out
}

export interface ResolveProfileRefDeps {
  /** Slot map source. Defaults to config.json's `accountSlots`. */
  loadAccountSlots?: () => Promise<AccountSlots>
  /** Profile lookup. Defaults to `@agentproto/auth`'s store. */
  getAuthProfile?: (id: string) => Promise<Pick<AuthProfile, "disabled"> | undefined>
}

export interface ResolvedProfileRef {
  /** The real auth-profile id to bill. */
  profileRef: string
  /** The slot the caller named, when the ref was `slot:<name>`. */
  slot?: string
}

/**
 * THE resolution point for a `profileRef`. `slot:<name>` -> the real profile
 * id the slot points at now; a plain id is returned unchanged (its own
 * existence is checked by whichever caller already checks it).
 *
 * Throws {@link AccountSlotError} for a malformed slot name, an unknown slot,
 * a slot whose target is itself a slot, or a target profile that is missing
 * or disabled.
 */
export async function resolveProfileRef(
  ref: string,
  deps: ResolveProfileRefDeps = {},
): Promise<ResolvedProfileRef> {
  const name = slotNameOf(ref)
  if (name === undefined) return { profileRef: ref }
  if (!ACCOUNT_SLOT_NAME_RE.test(name)) {
    throw new AccountSlotError(
      "account_slot_invalid",
      name,
      `account slot "${name}" is not a valid slot name (letters, digits, "_" and "-", no dot).`,
    )
  }
  const slots = await (deps.loadAccountSlots ?? (() => loadAccountSlots()))()
  const target = slots[name]
  if (target === undefined) {
    const known = Object.keys(slots).sort()
    throw new AccountSlotError(
      "account_slot_unknown",
      name,
      `account slot "${name}" is not defined in config.json accountSlots` +
        (known.length > 0 ? ` (defined: ${known.join(", ")})` : " (no slot is defined)") +
        `. Set it with: agentproto config set accountSlots.${name} <profile-id>`,
    )
  }
  if (isSlotRef(target)) {
    throw new AccountSlotError(
      "account_slot_invalid",
      name,
      `account slot "${name}" points at "${target}": a slot must name a real auth profile, not another slot.`,
    )
  }
  const profile = await (deps.getAuthProfile ?? defaultGetAuthProfile)(target)
  if (!profile) {
    throw new AccountSlotError(
      "account_slot_profile_missing",
      name,
      `account slot "${name}" points at auth profile "${target}", which does not exist (see auth_profile_list).`,
    )
  }
  if (profile.disabled === true) {
    throw new AccountSlotError(
      "account_slot_profile_disabled",
      name,
      `account slot "${name}" points at auth profile "${target}", which is disabled. ` +
        "Re-enable it, or point the slot at another profile.",
    )
  }
  return { profileRef: target, slot: name }
}

/** The access shape the spawn path carries. */
export interface SlotAccess {
  profileRef?: string
  profileRefs?: string[]
  delegateProfileRefs?: string[]
}

export interface ResolvedSlotAccess<A extends SlotAccess> {
  /** The access with every slot ref replaced by its real profile id. */
  access: A
  /** Real profile id -> the slot it came from, for every slot ref resolved.
   *  Lets the caller record `accessSlot` once it knows which profile was
   *  actually billed (`profileRefs` picks the first eligible one later). */
  slotByProfile: Map<string, string>
}

/**
 * Resolve every slot ref in an `access` block (`profileRef`, `profileRefs`,
 * `delegateProfileRefs`) through {@link resolveProfileRef}. Plain ids are
 * untouched; an unresolvable slot throws {@link AccountSlotError}.
 */
export async function resolveAccessSlots<A extends SlotAccess>(
  access: A,
  deps: ResolveProfileRefDeps = {},
): Promise<ResolvedSlotAccess<A>> {
  const slotByProfile = new Map<string, string>()
  const one = async (ref: string): Promise<string> => {
    const resolved = await resolveProfileRef(ref, deps)
    if (resolved.slot !== undefined && !slotByProfile.has(resolved.profileRef)) {
      slotByProfile.set(resolved.profileRef, resolved.slot)
    }
    return resolved.profileRef
  }
  const many = async (refs: string[]): Promise<string[]> => {
    const out: string[] = []
    for (const ref of refs) out.push(await one(ref))
    return out
  }
  const next: A = { ...access }
  if (access.profileRef !== undefined) next.profileRef = await one(access.profileRef)
  if (access.profileRefs !== undefined) next.profileRefs = await many(access.profileRefs)
  if (access.delegateProfileRefs !== undefined) {
    next.delegateProfileRefs = await many(access.delegateProfileRefs)
  }
  return { access: next, slotByProfile }
}

/** True when an access block names at least one slot ref. */
export function accessNamesSlot(access: SlotAccess | undefined): boolean {
  if (!access) return false
  return (
    isSlotRef(access.profileRef) ||
    (access.profileRefs ?? []).some(isSlotRef) ||
    (access.delegateProfileRefs ?? []).some(isSlotRef)
  )
}

/**
 * The slot a session keeps across a restart that does not change its access:
 * its recorded `accessSlot` when that slot still points at the profile the
 * session bills, otherwise none (the slot moved on, the session did not).
 * Never throws: an unresolvable slot just means "no longer on that slot".
 */
export async function carriedAccessSlot(
  prev: { accessSlot?: string; accessProfile?: { profileRef: string } },
  deps: ResolveProfileRefDeps = {},
): Promise<string | undefined> {
  if (!prev.accessSlot || !prev.accessProfile?.profileRef) return undefined
  try {
    const resolved = await resolveProfileRef(slotRef(prev.accessSlot), deps)
    return resolved.profileRef === prev.accessProfile.profileRef ? prev.accessSlot : undefined
  } catch {
    return undefined
  }
}

// ── swap ──────────────────────────────────────────────────────────────────

/** A slot family: `<family>-primary` / `<family>-secondary`. */
export function familySlots(family: string): { primary: string; secondary: string } {
  return { primary: `${family}-primary`, secondary: `${family}-secondary` }
}

export interface AccountSlotSwapPlan {
  family: string
  primarySlot: string
  secondarySlot: string
  /** Profile the primary slot points at BEFORE the swap (the one that leaves). */
  departing: string
  /** Profile the primary slot points at AFTER the swap. */
  arriving: string
  before: AccountSlots
  after: AccountSlots
}

/** Compute a `<family>-primary` <-> `<family>-secondary` swap. Throws
 *  {@link AccountSlotError} when the family name is invalid or a slot of the
 *  pair is missing. Pure: nothing is written. */
export function planAccountSlotSwap(slots: AccountSlots, family: string): AccountSlotSwapPlan {
  if (!ACCOUNT_SLOT_NAME_RE.test(family)) {
    throw new AccountSlotError(
      "account_slot_invalid",
      family,
      `"${family}" is not a valid slot family (letters, digits, "_" and "-", no dot).`,
    )
  }
  const { primary, secondary } = familySlots(family)
  for (const name of [primary, secondary]) {
    if (slots[name] === undefined) {
      throw new AccountSlotError(
        "account_slot_unknown",
        name,
        `cannot swap "${family}": account slot "${name}" is not defined in config.json accountSlots.`,
      )
    }
  }
  const departing = slots[primary]!
  const arriving = slots[secondary]!
  return {
    family,
    primarySlot: primary,
    secondarySlot: secondary,
    departing,
    arriving,
    before: { ...slots },
    after: { ...slots, [primary]: arriving, [secondary]: departing },
  }
}

/** Write a swap plan to config.json, re-reading the file first so a
 *  concurrent edit of another key is kept. Refuses when the pair changed
 *  since the plan was computed. */
export async function applyAccountSlotSwap(plan: AccountSlotSwapPlan, path?: string): Promise<void> {
  const cfg = await loadConfig(path)
  const current = accountSlotsOf(cfg)
  if (current[plan.primarySlot] !== plan.departing || current[plan.secondarySlot] !== plan.arriving) {
    throw new AccountSlotError(
      "account_slot_invalid",
      plan.family,
      `account slots "${plan.primarySlot}" / "${plan.secondarySlot}" changed while the swap was being prepared; re-run it.`,
    )
  }
  const raw = (cfg.accountSlots && typeof cfg.accountSlots === "object" ? cfg.accountSlots : {}) as AccountSlots
  await saveConfig(
    {
      ...cfg,
      accountSlots: { ...raw, [plan.primarySlot]: plan.arriving, [plan.secondarySlot]: plan.departing },
    },
    path,
  )
}

/** Minimal session shape the slot views read. */
export interface SlotSessionLike {
  id: string
  kind?: string
  status?: string
  name?: string
  label?: string
  accessSlot?: string
  accessProfile?: { profileRef: string }
}

/** A session that can still be driven: running or starting. */
export function isAliveSession(s: Pick<SlotSessionLike, "status">): boolean {
  return s.status === "running" || s.status === "starting"
}

/**
 * The sessions `swap --move-alive` restarts: ALIVE agent sessions billing the
 * departing profile, whether they reached it through the primary slot
 * (`accessSlot`) or by naming the profile literally (the mixed migration
 * period). Dead sessions are never selected.
 */
export function sessionsToMoveOnSwap<S extends SlotSessionLike>(
  sessions: readonly S[],
  plan: Pick<AccountSlotSwapPlan, "primarySlot" | "departing">,
): S[] {
  return sessions.filter(
    s =>
      isAliveSession(s) &&
      (s.kind === undefined || s.kind === "agent-cli") &&
      s.accessProfile?.profileRef === plan.departing &&
      (s.accessSlot === undefined || s.accessSlot === plan.primarySlot),
  )
}

export interface AccountSlotRow {
  slot: string
  profileRef: string
  /** Missing / disabled status of the target profile, when not usable. */
  problem?: "missing" | "disabled"
  /** Alive sessions on this slot: `accessSlot` matches, or (no slot recorded)
   *  the session names the slot's profile literally. */
  aliveSessions: Array<{ id: string; label: string; via: "slot" | "profile" }>
}

/** The `accounts slots` view: each slot, its profile, and the alive sessions
 *  on it. */
export async function listAccountSlotRows(
  slots: AccountSlots,
  sessions: readonly SlotSessionLike[],
  deps: Pick<ResolveProfileRefDeps, "getAuthProfile"> = {},
): Promise<AccountSlotRow[]> {
  const getProfile = deps.getAuthProfile ?? defaultGetAuthProfile
  const alive = sessions.filter(isAliveSession)
  const rows: AccountSlotRow[] = []
  for (const slot of Object.keys(slots).sort()) {
    const profileRef = slots[slot]!
    const profile = await getProfile(profileRef).catch(() => undefined)
    const aliveSessions: AccountSlotRow["aliveSessions"] = []
    for (const s of alive) {
      const label = s.name || s.label || s.id
      if (s.accessSlot === slot) aliveSessions.push({ id: s.id, label, via: "slot" })
      else if (s.accessSlot === undefined && s.accessProfile?.profileRef === profileRef) {
        aliveSessions.push({ id: s.id, label, via: "profile" })
      }
    }
    rows.push({
      slot,
      profileRef,
      ...(!profile ? { problem: "missing" as const } : profile.disabled ? { problem: "disabled" as const } : {}),
      aliveSessions,
    })
  }
  return rows
}
