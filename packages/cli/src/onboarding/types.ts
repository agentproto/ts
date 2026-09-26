/**
 * Onboarding step framework — the shared model behind `agentproto doctor`
 * (and, later, the `agentproto setup` wizard).
 *
 * A step is one area of a working install (preflight, workspace, daemon, …).
 * `detect` inspects the machine and returns one {@link StepCheck} per thing it
 * looked at. Detection is strictly READ-ONLY: it never writes a file, never
 * starts a process that mutates state, never prompts. Every external effect
 * goes through the injected {@link StepContext}, so tests run on fakes.
 */

import type { AgentprotoConfig } from "@agentproto/runtime/config"
import type { WorkspacesConfig } from "@agentproto/runtime/workspaces-config"
import type { DiscoveredCredential } from "@agentproto/runtime/credential-discovery"
import type { AuthProfile } from "@agentproto/auth"
import type { AgentCliHandle } from "@agentproto/driver-agent-cli"
import type { AgentDetection, InstallState } from "../commands/install-mcp.js"
import type { SkillFanOutTarget } from "../commands/install-skill.js"

export type StepStatus = "ok" | "warn" | "missing" | "broken" | "skipped"

export interface StepCheck {
  /** Stable id, e.g. "daemon.health". */
  id: string
  /** Human label. */
  title: string
  status: StepStatus
  /** One line, shown after the label. */
  detail?: string
  /** Exact command the user can run, e.g. "agentproto daemon install". */
  fix?: string
  /** Machine details for `--json`. Never carries a secret. */
  data?: Record<string, unknown>
}

export interface OnboardingStep {
  /** "preflight" | "workspace" | "daemon" | "agents" | "auth" | "clients" | "skills" */
  id: string
  title: string
  /** Required for the core path: a `missing`/`broken` check here fails the run. */
  required: boolean
  /** Override of the runner's per-step timeout, for steps that fan out
   *  several slow local probes. */
  timeoutMs?: number
  detect(ctx: StepContext): Promise<StepCheck[]>
  /**
   * From `detect()` output, what the `setup` wizard proposes. Empty = nothing
   * to do. `previous` holds the latest checks of the steps that already ran
   * this wizard pass, keyed by step id. Never called by `doctor`.
   */
  plan?(checks: StepCheck[], ctx: StepContext, previous: ReadonlyMap<string, StepCheck[]>): Promise<SetupAction[]>
  /** A reason the wizard cannot continue past this step (e.g. Node too old),
   *  or `null`. */
  stopIf?(checks: StepCheck[]): string | null
  /** Extra lines the wizard prints after this step's verify. */
  report?(io: SetupIO): Promise<string[]>
}

// ── setup (the wizard's side: these DO change things) ─────────────────────

export interface SetupChoice {
  value: string
  label: string
  hint?: string
  /** Pre-selected in the prompt / applied under --yes. */
  default?: boolean
}

export interface ApplyResult {
  ok: boolean
  /** One line shown after the action. */
  detail?: string
  /** Printed together at the end of the wizard (e.g. Claude Code `/plugin` steps). */
  notes?: string[]
}

export interface SetupAction {
  /** e.g. "daemon.install" */
  id: string
  /** e.g. "Install the daemon as a login service" */
  title: string
  /** Pre-selected in the prompt / applied under --yes. For a `choices`
   *  action, applied under --yes with the default choices. */
  default: boolean
  /** Multiselect action: `apply` receives the selected values. */
  choices?: SetupChoice[]
  /** Needs a secret typed by the user: never applied under --yes. */
  needsSecret?: boolean
  /** Runs an interactive verb or streams its own output: the wizard shows
   *  no spinner around it and never captures its output. */
  streamsOutput?: boolean
  apply(io: SetupIO, selected?: string[]): Promise<ApplyResult>
}

/** Prompts; each resolves `null` when the user cancels. */
export interface SetupPrompts {
  confirm(message: string, initial: boolean): Promise<boolean | null>
  multiselect(message: string, choices: readonly SetupChoice[], initial: readonly string[]): Promise<string[] | null>
  select(message: string, choices: readonly SetupChoice[]): Promise<string | null>
  text(message: string, initial: string): Promise<string | null>
  password(message: string): Promise<string | null>
}

export interface SetupLog {
  info(message: string): void
  success(message: string): void
  warn(message: string): void
  error(message: string): void
  step(message: string): void
  message(message: string): void
}

/** Summary of runnable models for one installed harness (`agentproto models`). */
export interface ModelsSummaryRow {
  slug: string
  runnable: number
  total: number
}

export interface FirstRunResult {
  ok: boolean
  error?: string
}

/**
 * The existing verbs/helpers the wizard's actions call. Each real entry is
 * the verb's own entrypoint (`runWorkspace`, `runDaemon`, `runInstall`, …),
 * so the wizard never re-implements a change; tests inject fakes.
 */
export interface SetupVerbs {
  workspace(args: readonly string[]): Promise<number>
  daemon(args: readonly string[]): Promise<number>
  /** `install-mcp`'s start-or-spawn-`serve` fallback; the port or `null`. */
  ensureDaemon(): Promise<number | null>
  install(args: readonly string[]): Promise<number>
  auth(args: readonly string[]): Promise<number>
  installMcp(args: readonly string[]): Promise<number>
  installSkill(slug: string, args: readonly string[]): Promise<number>
  /** `npm i -g @agentproto/cli@latest`. */
  updateCli(): Promise<number>
  modelsSummary(): Promise<ModelsSummaryRow[]>
  /** Spawn `slug` on the daemon, run one prompt, stream its text lines,
   *  then stop the session. */
  firstRun(slug: string, prompt: string, onLine: (line: string) => void): Promise<FirstRunResult>
  /** Is an app with this id installed (`~/.agentproto/apps.json`)? */
  appInstalled(appId: string): boolean
}

export interface SetupIO {
  /** A human can answer prompts (TTY and not --yes). */
  interactive: boolean
  prompts: SetupPrompts
  log: SetupLog
  verbs: SetupVerbs
}

export interface StepReport {
  id: string
  title: string
  required: boolean
  checks: StepCheck[]
  durationMs: number
}

// ── injected dependencies ────────────────────────────────────────────────

/** The read-only slice of `fs/promises` a step may use. There is deliberately
 *  no write method here. */
export interface StepFs {
  readFile(path: string): Promise<string>
  /** Rejects when `path` is absent or lacks `mode` (an `fs.constants` mask). */
  access(path: string, mode?: number): Promise<void>
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>
  readdir(path: string): Promise<string[]>
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a read-only probe command. Must resolve (never reject): a spawn
 *  failure is `code: 127`, a timeout is `code: 124`. */
export type ExecFn = (
  cmd: string,
  args: readonly string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>

/**
 * Existing CLI/runtime helpers a step reuses, behind one seam so tests can
 * fake them. Each default is the real helper the corresponding verb uses
 * (see `createStepContext`); all are read-only.
 */
export interface StepSources {
  /** `~/.agentproto/config.json` (`loadConfig`). */
  loadConfig(): Promise<AgentprotoConfig>
  /** `~/.agentproto/workspaces.json` (what `workspace list` reads). */
  loadWorkspaces(): Promise<WorkspacesConfig>
  /** Latest published `@agentproto/cli`, `null` when offline/slow. */
  latestCliVersion(): Promise<string | null>
  /** Login-shell PATH probe used by the daemon PATH self-heal; `null` on failure. */
  loginShellPath(): Promise<string | null>
  /** Resolve an adapter's AIP-45 handle (`resolveAdapter`); throws when the
   *  package isn't resolvable. */
  resolveAdapterHandle(slug: string): Promise<Pick<AgentCliHandle, "version_check" | "bin" | "bin_args">>
  /** Named auth profiles (what `auth profile list` reads). */
  listAuthProfiles(): Promise<AuthProfile[]>
  /** Local credentials found on this host (what `auth discover` runs). */
  discoverCredentials(): Promise<DiscoveredCredential[]>
  /** Coding clients installed on this host (`install-mcp`'s detection). */
  detectClients(): Promise<AgentDetection[]>
  /** `~/.agentproto/install-state.json` (what `install-mcp` recorded). */
  loadMcpInstallState(): Promise<InstallState>
  /** Adapters declaring a skills fan-out target (`install skill/…`'s resolution). */
  skillTargets(): Promise<SkillFanOutTarget[]>
  /** The agentproto skill pack resolvable WITHOUT a network fetch, or `null`. */
  resolveSkillPackDir(): Promise<string | null>
  /** Latest published skill pack version, `null` when offline/slow. */
  latestSkillPackVersion(): Promise<string | null>
}

export interface StepContext {
  fs: StepFs
  exec: ExecFn
  fetch: typeof fetch
  env: Readonly<Record<string, string | undefined>>
  homedir: string
  cwd: string
  platform: NodeJS.Platform
  arch: string
  /** `process.version` shape, e.g. "v22.1.0". */
  nodeVersion: string
  /** `process.getuid()`, `null` where unsupported. */
  uid: number | null
  /** Version of the running `agentproto` CLI. */
  cliVersion: string
  now(): number
  sources: StepSources
}
