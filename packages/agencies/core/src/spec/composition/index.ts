/**
 * agentagencies/v1 composition resolver.
 *
 * Resolves operations doctype references across the four supported patterns
 * (mirroring skills.sh resolution):
 *
 *   1. Embedded — operations doctypes inside the company package
 *      (e.g., `services/<slug>/SERVICE.md`)
 *
 *   2. External package — `OPERATIONS.md` root + `includes[]` from
 *      `AGENCY.md` / `COMPANY.md`
 *
 *   3. Per-agent — operations attached to a specific `AGENTS.md`
 *      (e.g., `agents/<agent>/services/<slug>/SERVICE.md`)
 *
 *   4. Registry-resolved — `agencies.sh` shortname (`design-project-retainer-v2`)
 *      → fetched + pinned to commit at install time
 *
 * Resolution order: local → included → registry. Same as skills.sh.
 *
 * v1 implementation covers patterns 1 + 3 fully. Patterns 2 and 4 require
 * filesystem walks across includes[] / registry network calls — surfaces
 * defined here, full implementation in runtime/.
 */

import * as path from "node:path"

export type DoctypeKind =
  | "service"
  | "procedure"
  | "pricing-model"
  | "counterparty"
  | "engagement"
  | "agreement"
  | "deliverable"
  | "invoice"
  | "routine"
  | "capacity"

const DOCTYPE_DIRNAME: Record<DoctypeKind, string> = {
  service: "services",
  procedure: "procedures",
  "pricing-model": "pricing-models",
  counterparty: "counterparties",
  engagement: "engagements",
  agreement: "agreements",
  deliverable: "deliverables",
  invoice: "invoices",
  routine: "routines",
  capacity: "capacity",
}

const DOCTYPE_FILENAME: Record<DoctypeKind, string> = {
  service: "SERVICE.md",
  procedure: "PROCEDURE.md",
  "pricing-model": "PRICING-MODEL.md",
  counterparty: "COUNTERPARTY.md",
  engagement: "ENGAGEMENT.md",
  agreement: "AGREEMENT.md",
  deliverable: "DELIVERABLE.md",
  invoice: "INVOICE.md",
  routine: "ROUTINE.md",
  capacity: "CAPACITY.md",
}

export interface ResolveContext {
  /** Workspace root (absolute path). */
  workspaceRoot: string
  /** Package roots (workspace itself + any external operations packages via includes[]). */
  includedPackageRoots?: string[]
  /** Per-agent operations search paths (e.g., agents/<agent>/). */
  agentRoots?: string[]
  /** Optional registry resolver (agencies.sh shortname → cached path). */
  resolveFromRegistry?: (
    shortname: string,
    kind: DoctypeKind
  ) => Promise<string | null>
}

export type ResolvedReference =
  | { ok: true; absolutePath: string; resolvedFrom: ResolveSource }
  | { ok: false; tried: string[]; message: string }

export type ResolveSource = "local" | "agent" | "included" | "registry"

/**
 * Resolve a doctype reference (slug) to an absolute filesystem path.
 *
 * Order:
 *   1. Local — `<workspaceRoot>/<dir>/<slug>/<FILENAME>`
 *   2. Per-agent — `<agentRoot>/<dir>/<slug>/<FILENAME>` for each agent root
 *   3. Included — `<includedPackageRoot>/<dir>/<slug>/<FILENAME>`
 *   4. Registry — via `resolveFromRegistry` callback (if provided)
 *
 * Returns the first match.
 */
export async function resolveDoctypeRef(
  kind: DoctypeKind,
  slug: string,
  ctx: ResolveContext,
  fileExists: (absPath: string) => Promise<boolean>
): Promise<ResolvedReference> {
  const dir = DOCTYPE_DIRNAME[kind]
  const file = DOCTYPE_FILENAME[kind]
  const tried: string[] = []

  // 1. Local
  const localPath = path.join(ctx.workspaceRoot, dir, slug, file)
  tried.push(localPath)
  if (await fileExists(localPath)) {
    return { ok: true, absolutePath: localPath, resolvedFrom: "local" }
  }

  // 2. Per-agent
  for (const agentRoot of ctx.agentRoots ?? []) {
    const agentPath = path.join(agentRoot, dir, slug, file)
    tried.push(agentPath)
    if (await fileExists(agentPath)) {
      return { ok: true, absolutePath: agentPath, resolvedFrom: "agent" }
    }
  }

  // 3. Included external packages
  for (const pkgRoot of ctx.includedPackageRoots ?? []) {
    const includedPath = path.join(pkgRoot, dir, slug, file)
    tried.push(includedPath)
    if (await fileExists(includedPath)) {
      return { ok: true, absolutePath: includedPath, resolvedFrom: "included" }
    }
  }

  // 4. Registry
  if (ctx.resolveFromRegistry) {
    const registryPath = await ctx.resolveFromRegistry(slug, kind)
    if (registryPath && (await fileExists(registryPath))) {
      tried.push(registryPath)
      return { ok: true, absolutePath: registryPath, resolvedFrom: "registry" }
    }
  }

  return {
    ok: false,
    tried,
    message: `Could not resolve ${kind}:${slug} (tried ${tried.length} paths)`,
  }
}

/** Helper: build the conventional dir + filename for a doctype. */
export function doctypePath(kind: DoctypeKind, slug: string): string {
  return `${DOCTYPE_DIRNAME[kind]}/${slug}/${DOCTYPE_FILENAME[kind]}`
}
