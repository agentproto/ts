/**
 * Pure decision-making logic for the permission commands — NO vscode import,
 * so it's unit-testable under plain vitest (mirrors sessionStore.logic.ts /
 * permissionsTree.logic.ts).
 */

export interface PermissionOption {
  optionId: string
  name?: string
  kind?: string
}

export type ApprovalSelection =
  | { kind: "none" }
  | { kind: "single"; optionId: string }
  | { kind: "ambiguous"; candidates: PermissionOption[] }

/**
 * Picks the optionId an "Approve" decision should carry, mirroring
 * `autoAllowPermissionHandler` in packages/driver/agent-cli's acp-client.ts:
 * prefer an option whose `kind` starts with `allow_`. Unlike that
 * auto-handler this surfaces ambiguity instead of silently picking one —
 * when more than one candidate qualifies, the caller quick-picks among them.
 */
export function selectApprovalOption(
  options: readonly PermissionOption[] | undefined,
): ApprovalSelection {
  if (!options || options.length === 0) return { kind: "none" }
  const allow = options.filter(o => typeof o.kind === "string" && o.kind.startsWith("allow_"))
  if (allow.length === 1) return { kind: "single", optionId: allow[0]!.optionId }
  if (allow.length > 1) return { kind: "ambiguous", candidates: allow }
  // No kind-tagged allow option offered — fall back to the lone option if
  // that's all there is, else let the caller ask (unfamiliar vocabulary).
  if (options.length === 1) return { kind: "single", optionId: options[0]!.optionId }
  return { kind: "ambiguous", candidates: [...options] }
}

/**
 * Extracts a permission id from a command argument, which may be a
 * PermissionTreeItem (`{ permissionId: string }`), a toast button payload
 * (a bare string id), or undefined (caller falls back to a quick-pick).
 */
export function extractPermissionId(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg || undefined
  if (arg && typeof arg === "object") {
    const id = (arg as { permissionId?: unknown }).permissionId
    if (typeof id === "string" && id) return id
  }
  return undefined
}
