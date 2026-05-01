import { createHash } from "node:crypto"
import * as path from "node:path"

import {
  defaultGovernanceFilesystem,
  type IGovernanceFilesystem,
} from "./filesystem.js"
import type { GovernanceConfig } from "./workspace-config.js"

/**
 * Pure helpers (no FS) + thin adapter shims.
 *
 * The FS-bound legacy exports (`ensureDir`, `readFileIfExists`, `atomicWrite`,
 * `appendLine`) are kept as thin wrappers over the default Node filesystem so
 * external consumers continue to work; new code should prefer
 * `getFilesystem(config)` from `./filesystem.js` and call the adapter directly.
 */

/** Resolve the filesystem adapter from a GovernanceConfig (default = Node fs). */
export function getFilesystem(config: GovernanceConfig): IGovernanceFilesystem {
  return config.filesystem ?? defaultGovernanceFilesystem()
}

/** Compute SHA-256 of UTF-8 string content, hex lowercase. */
export function sha256Hex(content: string | Uint8Array): string {
  const hash = createHash("sha256")
  if (typeof content === "string") hash.update(content, "utf8")
  else hash.update(content)
  return hash.digest("hex")
}

/**
 * Resolve a path against a root directory, rejecting paths that escape the
 * root. The "root" is any base directory string — workspace, engagement
 * subdir, external mount, etc. — not coupled to the workspace entity notion.
 */
export function resolveFromRoot(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath)
  const rootAbs = path.resolve(root)
  if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) {
    throw new Error(
      `Path escape detected: '${relPath}' resolves outside root '${root}'`
    )
  }
  return abs
}

/** Inverse of `resolveFromRoot`: forward-slash relative path, no leading "./". */
export function toRelativePath(root: string, absPath: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(absPath))
  return rel.split(path.sep).join("/")
}

// ─── Legacy Node-fs shims (kept for backward compatibility) ────────────
//
// These delegate to the default Node filesystem adapter. New runtime code
// should call `getFilesystem(config).ensureDir(...)` etc. directly so it
// honors a consumer-supplied SupabaseFilesystem (or other backend).

export async function ensureDir(dirPath: string): Promise<void> {
  return defaultGovernanceFilesystem().ensureDir(dirPath)
}

export async function readFileIfExists(
  filePath: string
): Promise<string | null> {
  return defaultGovernanceFilesystem().readFile(filePath)
}

export async function atomicWrite(
  filePath: string,
  content: string
): Promise<void> {
  return defaultGovernanceFilesystem().writeFileAtomic(filePath, content)
}

export async function appendLine(
  filePath: string,
  line: string
): Promise<void> {
  return defaultGovernanceFilesystem().appendLine(filePath, line)
}
