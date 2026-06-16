/**
 * CLI version — derived from the package's own package.json at runtime,
 * so it never drifts from the published version on a release bump.
 *
 * `import.meta.url` resolves to dist/cli.mjs in the published bundle and
 * to src/version.ts under tsx/vitest; in both, package.json sits one
 * directory up. A defensive fallback keeps --version from ever throwing.
 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8")
    ) as { version?: string }
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

export const VERSION: string = readVersion()
