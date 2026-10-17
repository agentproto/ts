/**
 * `agentproto workspace <subcommand>`
 *
 * Subcommands:
 *   add <path> [--slug <slug>] [--label <text>]   register a folder
 *   list                                          show registered + active
 *   remove <slug>                                 drop an entry
 *   use <slug>                                    set the active workspace
 *   remote set <slug> --url <https-url> [--branch <b>] [--credential-ref <ref>] [--token-stdin]
 *   remote show <slug> [--json]                   print the workspace's git remote
 *   remote unset <slug>                           drop the git remote
 *   check <dir> [--json] [--max-report-age-hours <n>]   AIP-34 workspace/v2 tree verifier
 *
 * `add`/`list`/`remove`/`use`/`remote` read/write `~/.agentproto/workspaces.json`
 * via @agentproto/runtime — the daemon's OWN workspace registry (a folder the
 * daemon can spawn agent-cli sessions against). `check` is unrelated state: it
 * validates an AIP-34 `workspace/v2` TREE on disk (WORKSPACE.md nodes, TYPES.md,
 * includes/exports, secrets, budgets) via @agentproto/workspace. Same noun,
 * two different "workspace" concepts that are expected to converge once the
 * daemon's registry buckets become tree nodes (see the AIP-34 v2 spec).
 */
import { parseArgs } from "node:util"
import { resolve, basename } from "node:path"
import { existsSync } from "node:fs"
import { KeychainStore } from "@agentproto/auth"
import {
  loadWorkspacesConfig,
  saveWorkspacesConfig,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  setWorkspaceRemote,
  unsetWorkspaceRemote,
  findWorkspace,
  sanitizeSlug,
  DEFAULT_CONFIG_PATH,
  DEFAULT_REMOTE_BRANCH,
  type WorkspaceEntry,
  type WorkspaceRemote,
} from "@agentproto/runtime/workspaces-config"
import { checkWorkspaceTree, type CheckLevel } from "@agentproto/workspace/checker"
import { readSecretFromStdin } from "./auth.js"

const USAGE = `agentproto workspace — manage local workspaces

Usage:
  agentproto workspace add <path> [--slug <slug>] [--label <text>]
  agentproto workspace list  [--json]
  agentproto workspace remove <slug>
  agentproto workspace use <slug>
  agentproto workspace remote set <slug> --url <https-url> [--branch <branch>]
                                 [--credential-ref <ref> | --token-stdin]
  agentproto workspace remote show <slug> [--json]
  agentproto workspace remote unset <slug>
  agentproto workspace check <dir> [--json] [--max-report-age-hours <n>]
                                 verify an AIP-34 workspace/v2 tree:
                                 node types vs TYPES.md, wall floors,
                                 includes/exports consent, secret grants,
                                 budget aggregation, report freshness,
                                 no literal secret values, effective
                                 status (paused/archived inheritance).
  agentproto workspace --help

A workspace "remote" is the off-machine clone source a sandbox spawn
(agent_start sandbox + workspaceSlug) checks out into the box. The git token
is never a flag: pipe it on stdin with --token-stdin (stored in the OS keychain
as agentproto.git.<slug>) or name an existing keychain slot with --credential-ref.
The box gets that token as AGENTPROTO_GIT_TOKEN (git credential helper) and
GH_TOKEN, so the agent can "git push" and "gh pr create" when the token has
Contents + Pull requests write on the repository.

Config file: ${DEFAULT_CONFIG_PATH()}
`

export async function runWorkspace(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "add":
      return runAdd(rest)
    case "list":
    case "ls":
      return runList(rest)
    case "remove":
    case "rm":
      return runRemove(rest)
    case "use":
      return runUse(rest)
    case "remote":
      return runRemote(rest)
    case "check":
      return runCheck(rest)
    default:
      process.stderr.write(
        `agentproto workspace: unknown subcommand '${sub}'\n\n${USAGE}`
      )
      return 2
  }
}

const LEVEL_MARKER: Record<CheckLevel, string> = { error: "✗", warning: "!", info: "·" }

async function runCheck(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      "max-report-age-hours": { type: "string" },
    },
  })
  const rawDir = positionals[0]
  if (!rawDir) {
    process.stderr.write("agentproto workspace check: missing <dir>. Try: agentproto workspace check ~/agentproto\n")
    return 2
  }
  const dir = resolve(rawDir.replace(/^~/, process.env.HOME ?? "~"))
  if (!existsSync(dir)) {
    process.stderr.write(`agentproto workspace check: "${dir}" doesn't exist.\n`)
    return 2
  }
  let maxReportAgeHours: number | undefined
  if (values["max-report-age-hours"] !== undefined) {
    maxReportAgeHours = Number(values["max-report-age-hours"])
    if (!Number.isFinite(maxReportAgeHours) || maxReportAgeHours <= 0) {
      process.stderr.write(
        `agentproto workspace check: --max-report-age-hours must be a positive number, got "${values["max-report-age-hours"]}".\n`,
      )
      return 2
    }
  }
  const report = checkWorkspaceTree(dir, maxReportAgeHours !== undefined ? { maxReportAgeHours } : {})
  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
    return report.ok ? 0 : 1
  }
  process.stdout.write(`${report.ok ? "✓" : "✗"} ${report.root}  (${report.nodeCount} node${report.nodeCount === 1 ? "" : "s"})\n\n`)
  for (const node of report.nodes) {
    const budget = node.effectiveBudgetUsdPerMonth !== undefined ? `  budget≤$${node.effectiveBudgetUsdPerMonth}/mo` : ""
    const status =
      node.effectiveStatus === "active"
        ? ""
        : `, ${node.effectiveStatus}${node.statusInheritedFrom ? ` (inherited from ${node.statusInheritedFrom})` : ""}`
    process.stdout.write(`  ${node.id}  [${node.type}, wall:${node.wall}${status}]${node.parentId ? `  ← ${node.parentId}` : ""}${budget}\n`)
  }
  if (report.findings.length > 0) {
    process.stdout.write("\n")
    for (const f of report.findings) {
      process.stdout.write(`${LEVEL_MARKER[f.level]} [${f.level}] ${f.nodeId ? `${f.nodeId}: ` : ""}${f.message}\n    ${f.path}\n`)
    }
  }
  const errors = report.findings.filter((f) => f.level === "error").length
  const warnings = report.findings.filter((f) => f.level === "warning").length
  process.stdout.write(`\n${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}\n`)
  return report.ok ? 0 : 1
}

async function runAdd(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      slug: { type: "string" },
      label: { type: "string" },
    },
  })
  const rawPath = positionals[0]
  if (!rawPath) {
    process.stderr.write(
      "agentproto workspace add: missing <path>. Try: agentproto workspace add ~/code/my-project\n"
    )
    return 2
  }
  const absPath = resolve(rawPath.replace(/^~/, process.env.HOME ?? "~"))
  if (!existsSync(absPath)) {
    process.stderr.write(
      `agentproto workspace add: "${absPath}" doesn't exist. Create the directory first or pass an existing one.\n`
    )
    return 2
  }
  const slug = sanitizeSlug(values.slug ?? basename(absPath))
  const config = await loadWorkspacesConfig()
  const next = addWorkspace(config, {
    slug,
    path: absPath,
    ...(values.label ? { label: values.label } : {}),
  })
  await saveWorkspacesConfig(next)
  const wasActive = config.active === slug
  const becameActive = next.active === slug && !wasActive
  process.stdout.write(
    `✓ ${slug} → ${absPath}` +
      (becameActive ? "  (set as active — first registered workspace)" : "") +
      "\n"
  )
  return 0
}

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const config = await loadWorkspacesConfig()
  if (values.json) {
    process.stdout.write(JSON.stringify(config, null, 2) + "\n")
    return 0
  }
  if (config.workspaces.length === 0) {
    process.stdout.write(
      "No workspaces registered.\n" +
        "Add one with: agentproto workspace add <path>\n"
    )
    return 0
  }
  // Compact two-column layout — slug left, path right, with an
  // active marker. Sorted by updatedAt desc so the most recently
  // touched workspace is at the top.
  const sorted = [...config.workspaces].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )
  const slugCol = Math.max(...sorted.map(w => w.slug.length), 6)
  for (const w of sorted) {
    const marker = w.slug === config.active ? "●" : " "
    const slugCell = w.slug.padEnd(slugCol)
    const labelSuffix = w.label ? `  (${w.label})` : ""
    process.stdout.write(
      `${marker} ${slugCell}  ${w.path}${labelSuffix}\n`
    )
  }
  process.stdout.write(
    `\n${sorted.length} workspace${sorted.length === 1 ? "" : "s"}` +
      (config.active ? `, active: ${config.active}` : ", no active") +
      "\n"
  )
  return 0
}

async function runRemove(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {},
  })
  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto workspace remove: missing <slug>.\n"
    )
    return 2
  }
  const config = await loadWorkspacesConfig()
  const sanitised = sanitizeSlug(slug)
  const existed = config.workspaces.some(w => w.slug === sanitised)
  if (!existed) {
    process.stderr.write(
      `agentproto workspace remove: no workspace named "${sanitised}".\n`
    )
    return 2
  }
  const next = removeWorkspace(config, sanitised)
  await saveWorkspacesConfig(next)
  process.stdout.write(`✗ removed ${sanitised}\n`)
  if (next.active && next.active !== config.active) {
    process.stdout.write(`  active reassigned to: ${next.active}\n`)
  } else if (!next.active && config.active) {
    process.stdout.write(`  no workspaces left — active cleared\n`)
  }
  return 0
}

async function runUse(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {},
  })
  const slug = positionals[0]
  if (!slug) {
    process.stderr.write("agentproto workspace use: missing <slug>.\n")
    return 2
  }
  const config = await loadWorkspacesConfig()
  try {
    const next = setActiveWorkspace(config, slug)
    await saveWorkspacesConfig(next)
    const w = next.workspaces.find(x => x.slug === next.active) as
      | WorkspaceEntry
      | undefined
    process.stdout.write(`● active: ${next.active}  (${w?.path ?? "?"})\n`)
    return 0
  } catch (err) {
    process.stderr.write(
      `agentproto workspace use: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    )
    return 2
  }
}

/** Keychain slot a `--token-stdin` PAT is stored under for `slug`. */
export function gitTokenCredentialRef(slug: string): string {
  return `agentproto.git.${slug}`
}

async function runRemote(args: readonly string[]): Promise<number> {
  const action = args[0]
  const rest = args.slice(1)
  switch (action) {
    case "set":
      return runRemoteSet(rest)
    case "show":
      return runRemoteShow(rest)
    case "unset":
      return runRemoteUnset(rest)
    default:
      process.stderr.write(
        `agentproto workspace remote: ${
          action ? `unknown action '${action}'` : "missing action (set | show | unset)"
        }\n\n${USAGE}`
      )
      return 2
  }
}

async function runRemoteSet(args: readonly string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        url: { type: "string" },
        branch: { type: "string" },
        "credential-ref": { type: "string" },
        "token-stdin": { type: "boolean" },
      },
    })
  } catch (err) {
    // `--token <value>` (or any unknown flag) lands here: a secret on argv is
    // refused outright, never half-processed.
    process.stderr.write(
      `agentproto workspace remote set: ${
        err instanceof Error ? err.message : String(err)
      }\n  The git token is never a flag — pipe it with --token-stdin.\n`
    )
    return 2
  }
  const { values, positionals } = parsed
  const rawSlug = positionals[0]
  if (!rawSlug || positionals.length > 1) {
    process.stderr.write(
      "agentproto workspace remote set: expected exactly one <slug>. " +
        "Try: agentproto workspace remote set my-repo --url https://github.com/acme/repo.git --token-stdin\n"
    )
    return 2
  }
  if (!values.url) {
    process.stderr.write("agentproto workspace remote set: missing --url <https-url>.\n")
    return 2
  }
  if (values["token-stdin"] && values["credential-ref"]) {
    process.stderr.write(
      "agentproto workspace remote set: --token-stdin and --credential-ref are mutually exclusive.\n"
    )
    return 2
  }
  const slug = sanitizeSlug(rawSlug)
  const config = await loadWorkspacesConfig()
  const existing = findWorkspace(config, slug)
  if (!existing) {
    process.stderr.write(
      `agentproto workspace remote set: no workspace named "${slug}". ` +
        `Register it first: agentproto workspace add <path> --slug ${slug}\n`
    )
    return 2
  }
  const credentialRef = values["token-stdin"]
    ? gitTokenCredentialRef(slug)
    : (values["credential-ref"] ?? existing.remote?.credentialRef)
  const defaultBranch = values.branch ?? existing.remote?.defaultBranch
  const remote: WorkspaceRemote = {
    url: values.url,
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ...(credentialRef !== undefined ? { credentialRef } : {}),
  }
  let next
  try {
    // Validate (and fail) BEFORE touching the keychain, so a bad URL never
    // leaves an orphaned token behind.
    next = setWorkspaceRemote(config, slug, remote)
  } catch (err) {
    process.stderr.write(
      `agentproto workspace remote set: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return 2
  }
  if (values["token-stdin"]) {
    let token: string
    try {
      token = await readSecretFromStdin("Paste the git token")
    } catch (err) {
      process.stderr.write(
        `agentproto workspace remote set: could not read the token — ${
          err instanceof Error ? err.message : String(err)
        }\n`
      )
      return 2
    }
    if (!token) {
      process.stderr.write("agentproto workspace remote set: the token on stdin was empty.\n")
      return 2
    }
    await new KeychainStore().write({ path: gitTokenCredentialRef(slug) }, { value: token, kind: "pat" })
  }
  await saveWorkspacesConfig(next)
  const saved = findWorkspace(next, slug)?.remote
  process.stdout.write(
    `✓ ${slug} remote → ${saved?.url ?? remote.url}` +
      `  (branch ${saved?.defaultBranch ?? DEFAULT_REMOTE_BRANCH}` +
      (saved?.credentialRef ? `, credential ${saved.credentialRef}` : ", no credential") +
      ")\n"
  )
  return 0
}

async function runRemoteShow(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const rawSlug = positionals[0]
  if (!rawSlug) {
    process.stderr.write("agentproto workspace remote show: missing <slug>.\n")
    return 2
  }
  const config = await loadWorkspacesConfig()
  const ws = findWorkspace(config, rawSlug)
  if (!ws) {
    process.stderr.write(`agentproto workspace remote show: no workspace named "${sanitizeSlug(rawSlug)}".\n`)
    return 2
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(ws.remote ?? null, null, 2) + "\n")
    return ws.remote ? 0 : 1
  }
  if (!ws.remote) {
    process.stdout.write(`${ws.slug}: no remote set.\n`)
    return 1
  }
  process.stdout.write(
    `${ws.slug}\n` +
      `  url         ${ws.remote.url}\n` +
      `  branch      ${ws.remote.defaultBranch ?? `${DEFAULT_REMOTE_BRANCH} (default)`}\n` +
      `  credential  ${ws.remote.credentialRef ?? "(none)"}\n`
  )
  return 0
}

async function runRemoteUnset(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {},
  })
  const rawSlug = positionals[0]
  if (!rawSlug) {
    process.stderr.write("agentproto workspace remote unset: missing <slug>.\n")
    return 2
  }
  const config = await loadWorkspacesConfig()
  try {
    const had = findWorkspace(config, rawSlug)?.remote !== undefined
    await saveWorkspacesConfig(unsetWorkspaceRemote(config, rawSlug))
    process.stdout.write(
      had
        ? `✗ removed remote from ${sanitizeSlug(rawSlug)}  (keychain token, if any, left in place)\n`
        : `${sanitizeSlug(rawSlug)}: no remote set.\n`
    )
    return 0
  } catch (err) {
    process.stderr.write(
      `agentproto workspace remote unset: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return 2
  }
}
