/**
 * `loadNodeTree(rootDir)`: reads every WORKSPACE.md under a tree root into the
 * `NodeTree` model of `../node-scope.ts` (AIP-34 rule 1: the parent of a node
 * is its nearest ancestor folder that also declares one).
 *
 * Unlike `checkWorkspaceTree`, which reports problems, this fails closed: a
 * WORKSPACE.md that does not parse, a duplicate id, or an unreadable TYPES.md
 * throws, because a host that skipped a declared node would compute the wrong
 * scope for sessions inside it.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { parseWorkspaceManifest } from "../manifest/index.js"
import { parseTypesManifest, resolveTypeEntry, type TypesManifestFrontmatter } from "../types-registry.js"
import { NodeScopeError, strictestWall, type NodeTree, type TreeNode } from "../node-scope.js"
import { walkForManifests } from "./check-tree.js"

function toTreePath(rootDir: string, dir: string): string {
  const rel = relative(rootDir, dir)
  return rel === "" ? "" : rel.split(sep).join("/")
}

export function loadNodeTree(rootDir: string): NodeTree {
  const realRoot = realpathSync(rootDir)

  let types: TypesManifestFrontmatter | undefined
  const typesPath = join(realRoot, "TYPES.md")
  if (existsSync(typesPath)) {
    try {
      types = parseTypesManifest(readFileSync(typesPath, "utf8"))
    } catch (err) {
      throw new NodeScopeError(`${typesPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const parsed = new Map<string, ReturnType<typeof parseWorkspaceManifest>>()
  for (const manifestPath of walkForManifests(realRoot)) {
    try {
      parsed.set(dirname(manifestPath), parseWorkspaceManifest(readFileSync(manifestPath, "utf8")))
    } catch (err) {
      throw new NodeScopeError(`${manifestPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const idByDir = new Map<string, string>()
  for (const [dir, manifest] of parsed) {
    const id = manifest.frontmatter.id
    for (const other of idByDir.values()) {
      if (other === id) throw new NodeScopeError(`node id ${id} is declared more than once in ${realRoot}`)
    }
    idByDir.set(dir, id)
  }

  const nodes: TreeNode[] = []
  for (const [dir, manifest] of parsed) {
    const fm = manifest.frontmatter
    let parentId: string | undefined
    for (let cursor = dirname(dir); ; cursor = dirname(cursor)) {
      const rel = relative(realRoot, cursor)
      if (rel.startsWith("..") || isAbsolute(rel)) break
      const id = idByDir.get(cursor)
      if (id) {
        parentId = id
        break
      }
      if (cursor === dirname(cursor)) break
    }
    // AIP-34 rule 7 floors a wall against the node's type only, not its parent.
    const floor = types ? resolveTypeEntry(types.types, fm.type)?.default_wall : undefined
    nodes.push({
      id: fm.id,
      path: toTreePath(realRoot, dir),
      type: fm.type,
      declaredWall: fm.wall,
      wall: floor ? strictestWall(fm.wall, floor) : fm.wall,
      ...(parentId ? { parentId } : {}),
      ...(fm.policy !== undefined ? { policy: fm.policy } : {}),
    })
  }
  nodes.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))
  return { rootDir: realRoot, nodes }
}

/**
 * Canonical form of a path ground: the realpath of its deepest existing
 * ancestor plus the rest, so a symlink inside the tree cannot make a ground
 * look like it lies in a node it does not. Refs and non-absolute grounds are
 * returned unchanged.
 */
export function canonicalizeGround(ground: string): string {
  if (!isAbsolute(ground)) return ground
  const abs = resolve(ground)
  const rest: string[] = []
  let cursor = abs
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) return abs
    rest.unshift(cursor.slice(parent.length).replace(/^[\\/]/, ""))
    cursor = parent
  }
  return join(realpathSync(cursor), ...rest)
}
