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
 * A slot can also be an ordered list of accounts:
 *
 * ```json
 * "accountSlots": {
 *   "opencode-go": ["opencode-ws01", "opencode-developerws003", "opencode-hodl-ws01"],
 *   "claude-primary": "anthropic-sub-hodl"
 * }
 * ```
 *
 * `slot:opencode-go` resolves to the FIRST account of the slot that exists, is
 * enabled, may run the requested model, and is not `exhausted` in the account
 * health file (`account-health.ts`). A string is a slot with one account. When every
 * account of a multi-account slot is exhausted the resolution throws
 * {@link AccountSlotExhaustedError} with the nearest return time; it never
 * hands out a spent account.
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
import { profileAllowsModelId } from "./auth-profile-model-allowlist.js"
import { createAccountHealthStore, type AccountHealthStore, type AccountHealthView } from "./account-health.js"

import { ACCOUNT_SLOT_NAME_RE, SLOT_REF_PREFIX } from "./account-slot-ref.js"

export { ACCOUNT_SLOT_NAME_RE, SLOT_REF_PREFIX }

/** What a slot points at: one real auth-profile id (a slot with one account), or an
 *  ORDERED list of them (a multi-account slot: first healthy, eligible account wins). */
export type AccountSlotTarget = string | string[]

/** The `accountSlots` map: slot name -> real auth-profile id, or an ordered
 *  slot of them. */
export type AccountSlots = Record<string, AccountSlotTarget>

/** The accounts of a slot target, in order. */
export function slotMembers(target: AccountSlotTarget): string[] {
  return typeof target === "string" ? [target] : [...target]
}

export type AccountSlotErrorCode =
  | "account_slot_invalid"
  | "account_slot_unknown"
  | "account_slot_profile_missing"
  | "account_slot_profile_disabled"
  | "account_slot_profile_ineligible"
  | "account_slot_exhausted"

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

/** Every account of a multi-account slot is `exhausted`: nothing may be started on it until
 *  the nearest `until`. Carries the data a caller needs to say "back at ...". */
export class AccountSlotExhaustedError extends AccountSlotError {
  /** ISO time the first account of the slot returns. */
  readonly retryAfter: string
  readonly accounts: Array<{ profileRef: string; until: string; untilBasis: string; reason: string }>
  constructor(slot: string, accounts: AccountHealthView[]) {
    const nearest = [...accounts].sort((a, b) => Date.parse(a.until) - Date.parse(b.until))[0]!
    super(
      "account_slot_exhausted",
      slot,
      `account slot "${slot}": ${accounts.length === 1 ? "its account is" : "every account of the slot is"} ` +
        `exhausted (${accounts.map(a => `${a.profileRef} until ${a.until}`).join(", ")}). ` +
        `Nearest return: ${nearest.until}. Clear one with: agentproto accounts health --clear <profile>`,
    )
    this.name = "AccountSlotExhaustedError"
    this.retryAfter = nearest.until
    this.accounts = accounts.map(a => ({
      profileRef: a.profileRef,
      until: a.until,
      untilBasis: a.untilBasis,
      reason: a.reason,
    }))
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

/** The well-formed `accountSlots` entries of a config: a non-empty string, or a
 *  non-empty list of non-empty strings. A malformed value is dropped here;
 *  resolving its slot then fails as unknown, loudly, rather than billing
 *  something unexpected. */
export function accountSlotsOf(cfg: AgentprotoConfig): AccountSlots {
  const raw = cfg.accountSlots as Record<string, unknown> | undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: AccountSlots = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.length > 0) out[name] = value
    else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(v => typeof v === "string" && v.length > 0)
    ) {
      out[name] = [...(value as string[])]
    }
  }
  return out
}

export interface ResolveProfileRefDeps {
  /** Slot map source. Defaults to config.json's `accountSlots`. */
  loadAccountSlots?: () => Promise<AccountSlots>
  /** Profile lookup. Defaults to `@agentproto/auth`'s store. */
  getAuthProfile?: (id: string) => Promise<Pick<AuthProfile, "disabled" | "models"> | undefined>
  /** The model the caller is about to run. A multi-account slot skips an account whose
   *  per-profile model allow-list refuses it. */
  model?: string
  /** Account health source. Defaults to `~/.agentproto/account-health.json`. */
  accountHealth?: Pick<AccountHealthStore, "get">
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
  const members = slotMembers(target)
  for (const member of members) {
    if (isSlotRef(member)) {
      throw new AccountSlotError(
        "account_slot_invalid",
        name,
        `account slot "${name}" points at "${member}": a slot must name a real auth profile, not another slot.`,
      )
    }
  }
  const getProfile = deps.getAuthProfile ?? defaultGetAuthProfile
  const health = deps.accountHealth ?? createAccountHealthStore()
  const single = members.length === 1
  const closed: AccountHealthView[] = []
  const problems: string[] = []
  const refusedForModel: string[] = []
  let firstMissing: AccountSlotError | undefined
  let firstDisabled: AccountSlotError | undefined
  let firstEnabled: string | undefined
  for (const member of members) {
    const profile = await getProfile(member)
    if (!profile) {
      problems.push(`${member}: missing`)
      firstMissing ??= new AccountSlotError(
        "account_slot_profile_missing",
        name,
        `account slot "${name}" points at auth profile "${member}", which does not exist (see auth_profile_list).`,
      )
      continue
    }
    if (profile.disabled === true) {
      problems.push(`${member}: disabled`)
      firstDisabled ??= new AccountSlotError(
        "account_slot_profile_disabled",
        name,
        `account slot "${name}" points at auth profile "${member}", which is disabled. ` +
          "Re-enable it, or point the slot at another profile.",
      )
      continue
    }
    firstEnabled ??= member
    if (deps.model !== undefined && !profileAllowsModelId(profile, deps.model)) {
      refusedForModel.push(member)
      continue
    }
    const view = await health.get(member).catch(() => undefined)
    if (view !== undefined && view.state === "exhausted") {
      closed.push(view)
      continue
    }
    return { profileRef: member, slot: name }
  }
  // Nothing usable. A multi-account slot whose reachable accounts are all spent says so, with
  // the nearest return time; it never falls through to a spent account.
  if (closed.length > 0) throw new AccountSlotExhaustedError(name, closed)
  if (single) {
    if (firstMissing) throw firstMissing
    if (firstDisabled) throw firstDisabled
    // The one account exists but its allow-list refuses the model: hand it back
    // so the spawn reports its own precise `access_profile_ineligible`.
    return { profileRef: members[0]!, slot: name }
  }
  if (firstEnabled !== undefined && refusedForModel.length > 0) {
    throw new AccountSlotError(
      "account_slot_profile_ineligible",
      name,
      `account slot "${name}": no account of the slot [${members.join(", ")}] may run ` +
        `"${deps.model}" (${[...refusedForModel.map(m => `${m}: model not allowed`), ...problems].join("; ")}).`,
    )
  }
  if (firstDisabled && !firstMissing) throw firstDisabled
  if (firstMissing && !firstDisabled) throw firstMissing
  throw new AccountSlotError(
    "account_slot_profile_missing",
    name,
    `account slot "${name}": no account of the slot is usable (${problems.join("; ")}).`,
  )
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
 * its recorded `accessSlot` while that slot still LISTS the profile the
 * session bills (a multi-account slot may have moved its head since, but the session is
 * still inside it), otherwise none (the slot moved on, the session did not).
 * Never throws: an unresolvable slot just means "no longer on that slot".
 */
export async function carriedAccessSlot(
  prev: { accessSlot?: string; accessProfile?: { profileRef: string } },
  deps: ResolveProfileRefDeps = {},
): Promise<string | undefined> {
  if (!prev.accessSlot || !prev.accessProfile?.profileRef) return undefined
  try {
    const slots = await (deps.loadAccountSlots ?? (() => loadAccountSlots()))()
    const target = slots[prev.accessSlot]
    if (target === undefined) return undefined
    return slotMembers(target).includes(prev.accessProfile.profileRef) ? prev.accessSlot : undefined
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
  if (typeof departing !== "string" || typeof arriving !== "string") {
    throw new AccountSlotError(
      "account_slot_invalid",
      family,
      `cannot swap "${family}": "${primary}" / "${secondary}" must each name ONE account, not a multi-account slot. ` +
        "Reorder a multi-account slot with: agentproto accounts prefer <slot> <profile>",
    )
  }
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

export interface AccountSlotAccountRow {
  profileRef: string
  /** Missing / disabled status of the profile, when not usable. */
  problem?: "missing" | "disabled"
  /** Health when the account is not `ok`: exhausted (closed) or probing. */
  health?: Pick<AccountHealthView, "state" | "until" | "untilBasis" | "reason" | "strikes">
}

export interface AccountSlotRow {
  slot: string
  /** The account a spawn on this slot lands on now: the first usable, open
   *  account of the slot, else its first member. For a single-account slot,
   *  that account. */
  profileRef: string
  /** Missing / disabled status of `profileRef`, when not usable. */
  problem?: "missing" | "disabled"
  /** Health of `profileRef` when it is not `ok` (single-account slot). */
  health?: AccountSlotAccountRow["health"]
  /** A multi-account slot's accounts in order, each with its health. Absent for a
   *  single-account slot. */
  accounts?: AccountSlotAccountRow[]
  /** Alive sessions on this slot: `accessSlot` matches, or (no slot recorded)
   *  the session names one of the slot's profiles literally. */
  aliveSessions: Array<{ id: string; label: string; via: "slot" | "profile" }>
}

/** The `accounts slots` view: each slot, its accounts with their health, and
 *  the alive sessions on it. */
export async function listAccountSlotRows(
  slots: AccountSlots,
  sessions: readonly SlotSessionLike[],
  deps: Pick<ResolveProfileRefDeps, "getAuthProfile" | "accountHealth"> = {},
): Promise<AccountSlotRow[]> {
  const getProfile = deps.getAuthProfile ?? defaultGetAuthProfile
  const health = deps.accountHealth ?? createAccountHealthStore()
  const alive = sessions.filter(isAliveSession)
  const rows: AccountSlotRow[] = []
  for (const slot of Object.keys(slots).sort()) {
    const members = slotMembers(slots[slot]!)
    const accounts: AccountSlotAccountRow[] = []
    for (const profileRef of members) {
      const profile = await getProfile(profileRef).catch(() => undefined)
      const view = await health.get(profileRef).catch(() => undefined)
      accounts.push({
        profileRef,
        ...(!profile ? { problem: "missing" as const } : profile.disabled ? { problem: "disabled" as const } : {}),
        ...(view
          ? {
              health: {
                state: view.state,
                until: view.until,
                untilBasis: view.untilBasis,
                reason: view.reason,
                strikes: view.strikes,
              },
            }
          : {}),
      })
    }
    const head = accounts.find(a => a.problem === undefined && a.health?.state !== "exhausted") ?? accounts[0]!
    const aliveSessions: AccountSlotRow["aliveSessions"] = []
    for (const s of alive) {
      const label = s.name || s.label || s.id
      if (s.accessSlot === slot) aliveSessions.push({ id: s.id, label, via: "slot" })
      else if (s.accessSlot === undefined && s.accessProfile && members.includes(s.accessProfile.profileRef)) {
        aliveSessions.push({ id: s.id, label, via: "profile" })
      }
    }
    rows.push({
      slot,
      profileRef: head.profileRef,
      ...(head.problem ? { problem: head.problem } : {}),
      ...(members.length > 1 ? { accounts } : head.health ? { health: head.health } : {}),
      aliveSessions,
    })
  }
  return rows
}

// ── prefer ────────────────────────────────────────────────────────────────

export interface AccountSlotPreferPlan {
  slot: string
  /** The account at the head of the slot BEFORE the move. */
  departing: string
  /** The account at the head of the slot AFTER the move. */
  arriving: string
  before: AccountSlots
  after: AccountSlots
}

/** Put `profile` at the head of the slot `slot` (the rest keep their order).
 *  A profile that is not in the slot is added at the head. Pure: nothing is
 *  written. */
export function planAccountSlotPrefer(slots: AccountSlots, slot: string, profile: string): AccountSlotPreferPlan {
  if (!ACCOUNT_SLOT_NAME_RE.test(slot)) {
    throw new AccountSlotError(
      "account_slot_invalid",
      slot,
      `"${slot}" is not a valid slot name (letters, digits, "_" and "-", no dot).`,
    )
  }
  if (isSlotRef(profile)) {
    throw new AccountSlotError(
      "account_slot_invalid",
      slot,
      `"${profile}" is a slot ref: a slot lists real auth profiles only.`,
    )
  }
  const current = slots[slot]
  if (current === undefined) {
    throw new AccountSlotError(
      "account_slot_unknown",
      slot,
      `cannot prefer on "${slot}": account slot "${slot}" is not defined in config.json accountSlots.`,
    )
  }
  const members = slotMembers(current)
  const reordered = [profile, ...members.filter(m => m !== profile)]
  return {
    slot,
    departing: members[0]!,
    arriving: profile,
    before: { ...slots },
    // A slot that stays one account stays a string: only a real slot becomes a list.
    after: { ...slots, [slot]: reordered.length === 1 ? reordered[0]! : reordered },
  }
}

/** Write a prefer plan to config.json, re-reading the file first. Refuses when
 *  the slot changed since the plan was computed. */
export async function applyAccountSlotPrefer(plan: AccountSlotPreferPlan, path?: string): Promise<void> {
  const cfg = await loadConfig(path)
  const current = accountSlotsOf(cfg)[plan.slot]
  const before = plan.before[plan.slot]
  if (current === undefined || JSON.stringify(current) !== JSON.stringify(before)) {
    throw new AccountSlotError(
      "account_slot_invalid",
      plan.slot,
      `account slot "${plan.slot}" changed while the move was being prepared; re-run it.`,
    )
  }
  const raw = (cfg.accountSlots && typeof cfg.accountSlots === "object" ? cfg.accountSlots : {}) as AccountSlots
  await saveConfig({ ...cfg, accountSlots: { ...raw, [plan.slot]: plan.after[plan.slot]! } }, path)
}

/** The sessions `prefer --move-alive` restarts: ALIVE agent sessions on the
 *  slot (recorded `accessSlot`, or literally on a member) whose account is not
 *  the new head. */
export function sessionsToMoveOnPrefer<S extends SlotSessionLike>(
  sessions: readonly S[],
  plan: Pick<AccountSlotPreferPlan, "slot" | "arriving" | "after">,
): S[] {
  const members = slotMembers(plan.after[plan.slot]!)
  return sessions.filter(
    s =>
      isAliveSession(s) &&
      (s.kind === undefined || s.kind === "agent-cli") &&
      s.accessProfile !== undefined &&
      s.accessProfile.profileRef !== plan.arriving &&
      (s.accessSlot === plan.slot || (s.accessSlot === undefined && members.includes(s.accessProfile.profileRef))),
  )
}
