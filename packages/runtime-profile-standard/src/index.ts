/**
 * @agentproto/runtime-profile-standard
 *
 * Exports the profile manifest and the absolute path to the files
 * tree, so the cli install handler can resolve and copy without
 * filesystem guessing.
 */

import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
// Source layout: <pkg>/dist/index.mjs at build time; the files/
// dir + profile.json live at <pkg>/files/ and <pkg>/profile.json.
const pkgRoot = resolve(here, "..")

export const FILES_DIR = resolve(pkgRoot, "files")
export const PROFILE_PATH = resolve(pkgRoot, "profile.json")

export type RuntimeProfileFile = {
  readonly src: string
  readonly dest: string
  readonly strategy: "overwrite" | "preserve" | "merge-json-deep" | "append"
  readonly executable?: boolean
}

export type RuntimeProfileManifest = {
  readonly schema: "agentproto/runtime-profile/v1"
  readonly slug: string
  readonly version: string
  readonly name: string
  readonly description: string
  readonly files: readonly RuntimeProfileFile[]
}

export async function loadProfileManifest(): Promise<RuntimeProfileManifest> {
  const raw = await readFile(PROFILE_PATH, "utf8")
  return JSON.parse(raw) as RuntimeProfileManifest
}
