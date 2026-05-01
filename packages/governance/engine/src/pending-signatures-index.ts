import * as path from "node:path"
import { getFilesystem, resolveFromRoot } from "./fs.js"
import { withPathLock } from "./path-lock.js"
import type { GovernanceConfig } from "./workspace-config.js"

/**
 * `_index/pending-signatures.json` — regeneratable index keyed by signer.
 *
 * Source of truth: artifact frontmatter / sidecar files declaring
 * `requiredSignatures`. This index is a cache for fast "what is awaiting
 * my signature" queries; it can be rebuilt at any time by walking the
 * workspace.
 *
 * Shape:
 * ```json
 * {
 *   "version": "1",
 *   "updatedAt": "2026-04-26T15:00:00.000Z",
 *   "bySigner": {
 *     "operator:founder": [
 *       {
 *         "artifactPath": "engagements/2026-acme/INVOICE.md",
 *         "deadline": "2026-05-15T17:00:00.000Z",
 *         "requestedAt": "2026-04-26T14:00:00.000Z"
 *       }
 *     ]
 *   }
 * }
 * ```
 */

export interface PendingSignatureEntry {
  artifactPath: string
  deadline?: string
  requestedAt: string
  /** Method preferred for this signer. */
  method?: string
  /** Optional weight (for weighted_threshold policies). */
  weight?: number
}

export interface PendingSignaturesIndex {
  version: "1"
  updatedAt: string
  bySigner: Record<string, PendingSignatureEntry[]>
}

const INDEX_PATH = "_index/pending-signatures.json"

export async function loadPendingSignaturesIndex(
  config: GovernanceConfig
): Promise<PendingSignaturesIndex> {
  const fs = getFilesystem(config)
  const abs = resolveFromRoot(config.workspaceRoot, INDEX_PATH)
  const content = await fs.readFile(abs)
  if (content == null) {
    return { version: "1", updatedAt: new Date(0).toISOString(), bySigner: {} }
  }
  try {
    const parsed = JSON.parse(content) as PendingSignaturesIndex
    return parsed
  } catch {
    // Corrupted index — return empty; caller can rebuild from filesystem walk.
    return { version: "1", updatedAt: new Date(0).toISOString(), bySigner: {} }
  }
}

async function writeIndex(
  config: GovernanceConfig,
  idx: PendingSignaturesIndex
): Promise<void> {
  const fs = getFilesystem(config)
  const abs = resolveFromRoot(config.workspaceRoot, INDEX_PATH)
  await fs.ensureDir(path.dirname(abs))
  await fs.writeFileAtomic(abs, JSON.stringify(idx, null, 2) + "\n")
}

export async function addPendingSignatures(
  config: GovernanceConfig,
  artifactPath: string,
  required: {
    signer: string
    method?: string
    weight?: number
    deadline?: string
  }[],
  requestedAt: string = new Date().toISOString()
): Promise<PendingSignaturesIndex> {
  const indexAbs = resolveFromRoot(config.workspaceRoot, INDEX_PATH)
  // Serialize the read-modify-write of the index file per workspace.
  return withPathLock(indexAbs, async () => {
    const idx = await loadPendingSignaturesIndex(config)
    for (const r of required) {
      const list = idx.bySigner[r.signer] ?? []
      // Avoid duplicate entries for the same artifact.
      const existing = list.findIndex(e => e.artifactPath === artifactPath)
      const entry: PendingSignatureEntry = {
        artifactPath,
        requestedAt,
        ...(r.deadline !== undefined ? { deadline: r.deadline } : {}),
        ...(r.method !== undefined ? { method: r.method } : {}),
        ...(r.weight !== undefined ? { weight: r.weight } : {}),
      }
      if (existing >= 0) list[existing] = entry
      else list.push(entry)
      idx.bySigner[r.signer] = list
    }
    idx.updatedAt = new Date().toISOString()
    await writeIndex(config, idx)
    return idx
  })
}

export async function removePendingSignature(
  config: GovernanceConfig,
  signer: string,
  artifactPath: string
): Promise<PendingSignaturesIndex> {
  const indexAbs = resolveFromRoot(config.workspaceRoot, INDEX_PATH)
  return withPathLock(indexAbs, async () => {
    const idx = await loadPendingSignaturesIndex(config)
    const list = idx.bySigner[signer]
    if (list) {
      idx.bySigner[signer] = list.filter(e => e.artifactPath !== artifactPath)
      if (idx.bySigner[signer]!.length === 0) delete idx.bySigner[signer]
    }
    idx.updatedAt = new Date().toISOString()
    await writeIndex(config, idx)
    return idx
  })
}

export async function listPendingSignatures(
  config: GovernanceConfig,
  signer: string
): Promise<PendingSignatureEntry[]> {
  const idx = await loadPendingSignaturesIndex(config)
  return idx.bySigner[signer] ?? []
}
