import type { KitOption } from "./kit.js"

export interface NavItem {
  /** Route name; the link points at `#/<route>`. Omit for a "soon" placeholder. */
  route?: string
  label: string
  /** A number, or a key into the `counts` object given to `renderShell`. */
  count?: number | string
}

export interface ShellOptions {
  /** Brand name shown next to the logo. Required. */
  brand: string
  /** Short logo text (initials). Required. */
  logo: string
  /** Route the brand links to. Defaults to the root (`#/`). */
  home?: string
  navItems?: NavItem[]
  /** `aria-label` of the sidebar navigation. Default: "Main navigation". */
  navLabel?: string
  live?: boolean
  /** Sidebar footer when `live` is true. Default: empty. */
  liveCaption?: string
  /** Sidebar footer when `live` is false. Default: empty. */
  idleCaption?: string
}

export interface TopbarOptions {
  title: string
  /** Raw HTML, inserted as is. */
  badge?: string
  /** Raw HTML, inserted as is. */
  actor?: string
  /** Raw HTML, inserted as is. */
  actions?: string
  /** Text of the `.demo-label` chip; the chip is omitted when empty. */
  demoLabel?: string
  /** Visible label of the kit switcher. Default: "Kit". */
  kitLabel?: string
  /** `aria-label` of the kit switcher. Default: "Visual kit". */
  kitAriaLabel?: string
  /** Options of the kit switcher. Default: the built-in `KITS`. */
  kits?: KitOption[]
}

export function escapeHtml(value: unknown): string
export function navCount(
  count: number | string | undefined,
  counts?: Record<string, number | string | null | undefined>
): string
export function renderShell(
  activeRoute: string | undefined,
  counts: Record<string, number | string | null | undefined> | undefined,
  options: ShellOptions
): string
export function renderTopbar(options: TopbarOptions): string
