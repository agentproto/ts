/**
 * `checkWorkspaceTree(rootDir)` — the first version of `agentproto
 * workspace check <dir>`.
 *
 * A single WORKSPACE.md can't see its neighbours, so everything that
 * needs the WHOLE tree (type↔TYPES.md nesting, includes↔exports
 * two-sided consent, secret grants, budget aggregation, report
 * freshness, no-literal-secrets) lives here — not in
 * `define-workspace-v2.ts`, which only ever sees one node at a time.
 *
 * Walks `rootDir`, collects every WORKSPACE.md (v1 and v2 both parse;
 * only v2 nodes get tree rules — a v1 node is reported but otherwise
 * left alone, matching v1's own "nested manifests are ignored by v1
 * hosts" posture), resolves each v2 node's implicit parent (nearest
 * ancestor directory that also has a WORKSPACE.md), and runs the
 * rules from AIP-34 §Specification (workspace/v2 — extended).
 */

import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import matter from "gray-matter"
import { parseWorkspaceV2Manifest, type WorkspaceV2Manifest } from "../manifest/v2.js"
import { parseTypesManifest, resolveTypeEntry, type TypesManifestFrontmatter } from "../types-registry.js"

const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", ".turbo-cache", ".turbo-shared-cache", "dist", ".next", ".pnpm-vstores"])
const WALL_ORDER = ["shared", "isolated", "sealed", "hard"] as const
const INCLUDE_MODE_ORDER = ["read", "append", "write"] as const

const SECRET_LEAK_KEYS = new Set(["value", "plaintext", "ciphertext", "secret", "data", "key", "token"])
const SECRET_LEAK_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /gho_[A-Za-z0-9]{30,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN[ A-Z]*PRIVATE KEY-----/,
  /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/,
]

export type CheckLevel = "error" | "warning" | "info"

export interface CheckFinding {
  level: CheckLevel
  nodeId?: string
  path: string
  message: string
}

export interface CheckedNode {
  id: string
  type: string
  schema: "workspace/v1" | "workspace/v2"
  dir: string
  parentId?: string
  wall?: string
  effectiveBudgetUsdPerMonth?: number
}

export interface CheckReport {
  ok: boolean
  root: string
  nodeCount: number
  nodes: CheckedNode[]
  findings: CheckFinding[]
}

export interface CheckOptions {
  /** RAPPORT.md (and similar `requires_files`) older than this is "stale". Default 48h. */
  maxReportAgeHours?: number
}

interface InternalNode {
  dir: string
  manifest: WorkspaceV2Manifest
  parentDir?: string
}

function walkForManifests(root: string): string[] {
  const found: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === "WORKSPACE.md" && entry.isFile()) {
        found.push(join(dir, entry.name))
        continue
      }
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".apps")) {
        stack.push(join(dir, entry.name))
      }
    }
  }
  return found
}

function walkAllFiles(root: string): string[] {
  const found: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full)
      } else if (entry.isFile()) {
        found.push(full)
      }
    }
  }
  return found
}

function scanForSecretLeakage(value: unknown, path: string, findings: CheckFinding[], filePath: string): void {
  if (value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForSecretLeakage(item, `${path}[${i}]`, findings, filePath))
    return
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_LEAK_KEYS.has(key)) {
      findings.push({
        level: "error",
        path: filePath,
        message: `SECRETS.md carries a forbidden key \`${path ? `${path}.` : ""}${key}\` — secret inventories declare slugs, never values (AIP-19).`,
      })
    }
    scanForSecretLeakage(val, path ? `${path}.${key}` : key, findings, filePath)
  }
}

function findLiteralSecrets(filePath: string, content: string, findings: CheckFinding[]): void {
  for (const pattern of SECRET_LEAK_PATTERNS) {
    if (pattern.test(content)) {
      findings.push({
        level: "error",
        path: filePath,
        message: `Possible literal secret value matching ${pattern} — no secret VALUE should ever be checked into the tree.`,
      })
    }
  }
}

function isDescendant(ancestorDir: string, dir: string): boolean {
  if (ancestorDir === dir) return true
  const rel = relative(ancestorDir, dir)
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`.${sep}..`)
}

export function checkWorkspaceTree(rootDir: string, opts: CheckOptions = {}): CheckReport {
  const findings: CheckFinding[] = []
  const nodes: CheckedNode[] = []
  const maxReportAgeHours = opts.maxReportAgeHours ?? 48

  const manifestPaths = walkForManifests(rootDir).sort((a, b) => a.length - b.length)
  const byDir = new Map<string, InternalNode>()
  const byId = new Map<string, InternalNode>()

  for (const manifestPath of manifestPaths) {
    const dir = dirname(manifestPath)
    const raw = readFileSync(manifestPath, "utf8")
    const peeked = matter(raw).data as { schema?: unknown }
    if (peeked.schema === "workspace/v1") {
      findings.push({
        level: "info",
        path: manifestPath,
        message: "workspace/v1 node — tree rules (type, wall, includes, budgets) don't apply; v1 hosts ignore nested manifests entirely.",
      })
      continue
    }
    if (peeked.schema !== "workspace/v2") {
      findings.push({
        level: "error",
        path: manifestPath,
        message: `unrecognised \`schema\` (${JSON.stringify(peeked.schema)}) — expected "workspace/v1" or "workspace/v2".`,
      })
      continue
    }
    let manifest: WorkspaceV2Manifest
    try {
      manifest = parseWorkspaceV2Manifest(raw)
    } catch (err) {
      findings.push({ level: "error", path: manifestPath, message: err instanceof Error ? err.message : String(err) })
      continue
    }
    const node: InternalNode = { dir, manifest }
    byDir.set(dir, node)
    byId.set(manifest.frontmatter.id, node)
  }

  // Resolve implicit parent: nearest ancestor directory that is ALSO a
  // collected v2 node (shorter manifestPaths were inserted first, so
  // byDir is already populated top-down by the time we reach a child).
  for (const [dir, node] of byDir) {
    let cursor = dirname(dir)
    while (cursor.length >= rootDir.length) {
      if (byDir.has(cursor)) {
        node.parentDir = cursor
        break
      }
      if (cursor === dirname(cursor)) break
      cursor = dirname(cursor)
    }
  }

  // TYPES.md — expected at rootDir. Absence disables type/wall/requires_files
  // checks (reported) but doesn't abort the rest of the walk.
  let types: TypesManifestFrontmatter | undefined
  const typesPath = join(rootDir, "TYPES.md")
  try {
    types = parseTypesManifest(readFileSync(typesPath, "utf8"))
  } catch (err) {
    findings.push({
      level: "warning",
      path: typesPath,
      message: `no usable TYPES.md at the tree root — type/wall/requires_files checks skipped (${
        err instanceof Error ? err.message : String(err)
      }).`,
    })
  }

  const countByType = new Map<string, number>()

  for (const [dir, node] of byDir) {
    const fm = node.manifest.frontmatter
    countByType.set(fm.type, (countByType.get(fm.type) ?? 0) + 1)

    const checked: CheckedNode = {
      id: fm.id,
      type: fm.type,
      schema: "workspace/v2",
      dir,
      wall: fm.wall,
    }
    if (node.parentDir) checked.parentId = byDir.get(node.parentDir)?.manifest.frontmatter.id
    nodes.push(checked)

    if (types) {
      const typeEntry = resolveTypeEntry(types.types, fm.type)
      if (!typeEntry) {
        findings.push({ level: "error", nodeId: fm.id, path: join(dir, "WORKSPACE.md"), message: `type "${fm.type}" is not declared in TYPES.md.` })
      } else {
        const parentType = node.parentDir ? byDir.get(node.parentDir)?.manifest.frontmatter.type : undefined
        if (typeEntry.parents && typeEntry.parents.length > 0) {
          const parentOk = parentType ? typeEntry.parents.includes(parentType) : false
          if (!parentOk) {
            findings.push({
              level: "error",
              nodeId: fm.id,
              path: join(dir, "WORKSPACE.md"),
              message: `type "${fm.type}" may only nest under [${typeEntry.parents.join(", ")}], but its parent is "${parentType ?? "(none — tree root)"}".`,
            })
          }
        }
        if (typeEntry.default_wall) {
          const floor = WALL_ORDER.indexOf(typeEntry.default_wall)
          const actual = WALL_ORDER.indexOf(fm.wall as typeof WALL_ORDER[number])
          if (actual < floor) {
            findings.push({
              level: "error",
              nodeId: fm.id,
              path: join(dir, "WORKSPACE.md"),
              message: `wall "${fm.wall}" is looser than the "${fm.type}" type's floor "${typeEntry.default_wall}".`,
            })
          }
        }
        for (const required of typeEntry.requires_files) {
          const p = join(dir, required)
          try {
            const st = statSync(p)
            const ageHours = (Date.now() - st.mtimeMs) / 3_600_000
            if (ageHours > maxReportAgeHours) {
              findings.push({
                level: "warning",
                nodeId: fm.id,
                path: p,
                message: `${required} is stale (${ageHours.toFixed(1)}h old, threshold ${maxReportAgeHours}h).`,
              })
            }
          } catch {
            findings.push({ level: "error", nodeId: fm.id, path: p, message: `required file ${required} is missing (type "${fm.type}").` })
          }
        }
      }
    }

    // Includes ↔ exports — two-sided consent.
    for (const include of fm.includes) {
      const m = include.ref.match(/^ws:\/\/workspaces\/(@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)(?:#(.+))?$/)
      const targetId = m?.[1]
      const target = targetId ? byId.get(targetId) : undefined
      if (!target) {
        findings.push({
          level: "warning",
          nodeId: fm.id,
          path: join(dir, "WORKSPACE.md"),
          message: `includes ${include.ref} — target workspace not found in this tree (outside this check's scope, or a typo).`,
        })
        continue
      }
      const grant = target.manifest.frontmatter.exports.find((exp) => {
        if (exp.to === "children") return isDescendant(target.dir, dir) && target.dir !== dir
        if (Array.isArray(exp.to)) return exp.to.includes(fm.id)
        return exp.to === fm.id
      })
      if (!grant) {
        findings.push({
          level: "error",
          nodeId: fm.id,
          path: join(dir, "WORKSPACE.md"),
          message: `includes ${include.ref} but ${targetId} exports nothing to ${fm.id} — door not accepted on the provider side.`,
        })
        continue
      }
      const wanted = INCLUDE_MODE_ORDER.indexOf(include.mode as typeof INCLUDE_MODE_ORDER[number])
      const granted = INCLUDE_MODE_ORDER.indexOf(grant.mode === "write" ? "write" : "read")
      if (wanted > granted) {
        findings.push({
          level: "warning",
          nodeId: fm.id,
          path: join(dir, "WORKSPACE.md"),
          message: `includes ${include.ref} as "${include.mode}" but ${targetId} only exports "${grant.mode}" — downgraded to "${grant.mode}".`,
        })
      }
    }

    // Secrets — never inherited; uses_secrets needs a matching grant.
    for (const used of fm.uses_secrets) {
      const provider = byId.get(used.from)
      const providerSecretsFile = provider?.manifest.frontmatter.secrets?.file
      if (!provider || !providerSecretsFile) {
        findings.push({
          level: "error",
          nodeId: fm.id,
          path: join(dir, "WORKSPACE.md"),
          message: `uses_secrets ${used.from}#${used.slug} — provider has no .secrets/SECRETS.md declared.`,
        })
        continue
      }
      const secretsPath = join(provider.dir, providerSecretsFile)
      let secretsDoc: { secrets?: Array<{ slug?: string; access?: Record<string, Array<Record<string, unknown>>> }> }
      try {
        secretsDoc = matter(readFileSync(secretsPath, "utf8")).data
      } catch (err) {
        findings.push({ level: "error", nodeId: fm.id, path: secretsPath, message: `cannot read ${secretsPath}: ${err instanceof Error ? err.message : String(err)}` })
        continue
      }
      const entry = secretsDoc.secrets?.find((s) => s.slug === used.slug)
      const op = used.mode === "reveal" ? "reveal" : "bind"
      const granted = entry?.access?.[op]?.some((g) => g.workspace === fm.id)
      if (!entry || !granted) {
        findings.push({
          level: "error",
          nodeId: fm.id,
          path: join(dir, "WORKSPACE.md"),
          message: `uses_secrets ${used.from}#${used.slug} (${op}) — no matching access.${op}[].workspace grant for ${fm.id} in ${secretsPath}.`,
        })
      }
    }
    if (fm.secrets) {
      const secretsPath = join(dir, fm.secrets.file)
      try {
        const doc = matter(readFileSync(secretsPath, "utf8")).data
        scanForSecretLeakage(doc, "", findings, secretsPath)
      } catch {
        findings.push({ level: "warning", nodeId: fm.id, path: secretsPath, message: `secrets.file declared but unreadable: ${secretsPath}` })
      }
    }

    // Budgets — effective ceiling = min(declared) walking up the chain.
    const own = fm.policy?.limits?.find((l) => l.kind === "budget-usd-per-month")
    if (own) {
      let effective = own.value
      let cursor = node.parentDir
      while (cursor) {
        const ancestor = byDir.get(cursor)
        const ancestorLimit = ancestor?.manifest.frontmatter.policy?.limits?.find((l) => l.kind === "budget-usd-per-month")
        if (ancestorLimit && ancestorLimit.value < effective) effective = ancestorLimit.value
        cursor = ancestor?.parentDir
      }
      checked.effectiveBudgetUsdPerMonth = effective
      if (effective < own.value) {
        findings.push({
          level: "warning",
          nodeId: fm.id,
          path: join(dir, "WORKSPACE.md"),
          message: `declared budget-usd-per-month ${own.value} exceeds the resolved ancestor ceiling — effective ceiling is ${effective} (most-restrictive-wins).`,
        })
      }
    }
  }

  for (const [type, entry] of types ? Object.entries(types.types) : []) {
    if (entry.max_per_tree && (countByType.get(type) ?? 0) > entry.max_per_tree) {
      findings.push({
        level: "error",
        path: rootDir,
        message: `type "${type}" has ${countByType.get(type)} node(s), exceeding max_per_tree ${entry.max_per_tree}.`,
      })
    }
  }

  // Tree-wide literal-secret heuristic — defense in depth over the
  // structural SECRETS.md schema check above.
  for (const file of walkAllFiles(rootDir)) {
    if (!file.endsWith(".md") && !file.endsWith(".lock") && !file.endsWith(".yaml") && !file.endsWith(".yml")) continue
    let content: string
    try {
      content = readFileSync(file, "utf8")
    } catch {
      continue
    }
    findLiteralSecrets(file, content, findings)
  }

  return {
    ok: !findings.some((f) => f.level === "error"),
    root: rootDir,
    nodeCount: nodes.length,
    nodes,
    findings,
  }
}
