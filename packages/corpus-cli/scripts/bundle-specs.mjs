/**
 * Bundle the AgentProto spec schemas into the published package.
 *
 * Runs after `tsup` in the build script. Copies the repo's canonical
 * `specs/resources` tree into `dist/specs/resources` so the published
 * binary can find its AIP schemas without the monorepo around it.
 * `dist` is in package.json `files`, so the copy ships to npm.
 *
 * Path-resolved from this file's own location, not cwd, so it works
 * regardless of where the build is invoked.
 */
import { cpSync, existsSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, "../../../specs/resources") // ts/packages/corpus-cli/scripts -> ts/specs/resources
const dest = resolve(here, "../dist/specs/resources")

if (!existsSync(src)) {
  console.error(`bundle-specs: source not found at ${src}`)
  process.exit(1)
}

// Clean first so stale AIP directories (moved or renamed) don't linger in dist.
rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, { recursive: true })
console.log(`bundle-specs: copied specs/resources -> dist/specs/resources`)
