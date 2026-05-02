#!/usr/bin/env node
/**
 * scaffold-aip — generate a package skeleton for an AIP.
 *
 * Reads spec metadata from `../agentproto/specs/aip-<N>.mdx` (sibling
 * layout — same convention as `agentproto/site/scripts/sync-content.mjs`)
 * and emits a `packages/<slug>/` skeleton wired up to:
 *
 *   - @agentproto/define-doctype (the meta-factory)
 *   - tsup + tsconfig matching the existing tool/ + driver/core layout
 *   - vitest with a smoke test
 *   - manifest subpath (parseXManifest + xFromManifest)
 *
 * Usage:
 *   node scripts/scaffold-aip.mjs --aip 9 --slug operator --doctype OPERATOR
 *
 *   --aip      AIP number (required) — used to read frontmatter
 *   --slug     package slug (required) — package becomes @agentproto/<slug>
 *              and lives under packages/<slug>/
 *   --doctype  doctype name in UPPER (required) — used in file names like
 *              OPERATOR.md and as the type / interface stem (Operator,
 *              defineOperator, OperatorHandle).
 *
 * The skeleton is a starting point — the per-AIP build()/validate()
 * bodies and the type fields are TODOs marked in the generated files.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import matter from "gray-matter"

const HERE = dirname(fileURLToPath(import.meta.url))
const TS_ROOT = resolve(HERE, "..")
const SPEC_DIR = resolve(TS_ROOT, "../agentproto/specs")

// ── arg parsing ──────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2))
if (!args.aip || !args.slug || !args.doctype) {
  console.error(
    "Usage: scaffold-aip --aip <N> --slug <slug> --doctype <DOCTYPE>",
  )
  process.exit(1)
}

const AIP = Number(args.aip)
const SLUG = args.slug
const DOCTYPE = args.doctype.toUpperCase()
const PASCAL = capitalize(SLUG)
const DEFINE_FN = `define${PASCAL}`
const PKG_NAME = `@agentproto/${SLUG}`
const PKG_DIR = resolve(TS_ROOT, "packages", SLUG)

// ── read spec metadata ───────────────────────────────────────────────
const specPath = resolve(SPEC_DIR, `aip-${AIP}.mdx`)
if (!existsSync(specPath)) {
  console.error(`spec not found at ${specPath}`)
  process.exit(1)
}
const fm = matter(readFileSync(specPath, "utf8")).data

const title = String(fm.title ?? `AIP-${AIP}: ${DOCTYPE}.md`)
const description = String(
  fm.description ??
    `AIP-${AIP} reference implementation — ${DOCTYPE}.md doctype.`,
)
const layer = String(fm.layer ?? "")

// ── refuse to overwrite an existing package ──────────────────────────
if (existsSync(PKG_DIR)) {
  console.error(`package ${PKG_DIR} already exists — refusing to overwrite`)
  process.exit(1)
}

// ── write the skeleton ───────────────────────────────────────────────
mkdirSync(join(PKG_DIR, "src", "manifest"), { recursive: true })
mkdirSync(join(PKG_DIR, "src", "__tests__"), { recursive: true })

write(
  "package.json",
  JSON.stringify(
    {
      name: PKG_NAME,
      version: "0.1.0-alpha.0",
      description: `${PKG_NAME} — AIP-${AIP} ${DOCTYPE}.md reference implementation. ${description}`,
      keywords: [
        "agentproto",
        `aip-${AIP}`,
        SLUG,
        DEFINE_FN,
        "open-standard",
        "agentic",
      ],
      homepage: `https://agentproto.sh/docs/aip-${AIP}`,
      repository: {
        type: "git",
        url: "https://github.com/agentproto/ts",
        directory: `packages/${SLUG}`,
      },
      bugs: { url: "https://github.com/agentproto/ts/issues" },
      license: "MIT",
      type: "module",
      main: "dist/index.mjs",
      module: "dist/index.mjs",
      types: "dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.mjs",
          default: "./dist/index.mjs",
        },
        "./manifest": {
          types: "./dist/manifest/index.d.ts",
          import: "./dist/manifest/index.mjs",
          default: "./dist/manifest/index.mjs",
        },
        "./package.json": "./package.json",
      },
      files: ["dist", "README.md", "LICENSE"],
      publishConfig: { access: "public" },
      scripts: {
        dev: "tsup --watch",
        build: "tsup",
        clean: "rm -rf dist",
        "check-types": "tsc --noEmit",
        test: "vitest run --passWithNoTests",
        "test:watch": "vitest",
        prepublishOnly: "pnpm build",
      },
      dependencies: {
        "@agentproto/define-doctype": "workspace:*",
        "gray-matter": "^4.0.3",
        zod: "^4.3.6",
      },
      devDependencies: {
        "@agentproto/tooling": "workspace:*",
        "@types/node": "^25.1.0",
        tsup: "^8.5.1",
        typescript: "^5.9.3",
        vitest: "^3.2.4",
      },
    },
    null,
    2,
  ) + "\n",
)

write(
  "tsconfig.json",
  JSON.stringify(
    {
      extends: "@agentproto/tooling/typescript/bundler.json",
      compilerOptions: {
        skipLibCheck: true,
        declaration: false,
        declarationMap: false,
        lib: ["ES2022"],
      },
      include: ["src/**/*"],
      exclude: ["dist", "node_modules"],
    },
    null,
    2,
  ) + "\n",
)

write(
  "tsup.config.ts",
  `import { createTsupConfig } from "@agentproto/tooling/tsup/base"

export default createTsupConfig({
  banner: \`/**
 * ${PKG_NAME} v0.1.0-alpha
 * AIP-${AIP} ${DOCTYPE}.md \\\`${DEFINE_FN}\\\` reference implementation.
 */\`,
  entry: {
    index: "src/index.ts",
    "manifest/index": "src/manifest/index.ts",
  },
  format: ["esm"],
  splitting: true,
  dts: true,
  external: ["zod", "gray-matter", "@agentproto/define-doctype"],
  noExternal: [],
})
`,
)

write(
  "src/index.ts",
  `/**
 * ${PKG_NAME} — AIP-${AIP} ${DOCTYPE}.md \`${DEFINE_FN}\` reference impl.
 *
 * ${description}
 *
 * Spec: https://agentproto.sh/docs/aip-${AIP}
 *
 * Authoring paths:
 *   - TS:  \`${DEFINE_FN}({...})\` → \`${PASCAL}Handle\`
 *   - MD:  \`parse${PASCAL}Manifest(src) → ${SLUG}FromManifest({...})\` → \`${PASCAL}Handle\`
 */

export const SPEC_NAME = "agent${SLUG}/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { ${DEFINE_FN} } from "./define-${SLUG}.js"
export type { ${PASCAL}Definition, ${PASCAL}Handle } from "./types.js"
`,
)

write(
  "src/types.ts",
  `/**
 * AIP-${AIP} ${PASCAL}Definition + ${PASCAL}Handle.
 *
 * TODO: fill in fields from the AIP-${AIP} ${DOCTYPE}.md frontmatter.
 * The two universals (id + description) are the cross-AIP invariants
 * \`createDoctype\` enforces; everything else is spec-${AIP}-specific.
 */

export interface ${PASCAL}Definition {
  id: string
  description: string
  // TODO: add spec-${AIP} fields here.
}

export interface ${PASCAL}Handle {
  readonly id: string
  readonly description: string
  // TODO: add the frozen handle shape here, mirroring ${PASCAL}Definition
  // with sensible defaults applied.
}
`,
)

write(
  `src/define-${SLUG}.ts`,
  `import { createDoctype } from "@agentproto/define-doctype"
import type { ${PASCAL}Definition, ${PASCAL}Handle } from "./types.js"

/**
 * AIP-${AIP} reference implementation of \`${DEFINE_FN}\`.
 *
 * Built on \`createDoctype\` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "${DEFINE_FN} (AIP-${AIP}): …"
 * error prefix) run uniformly with every other AIP defineX. Spec-${AIP}-
 * specific validation goes in \`validate(def)\`; defaulting and nested
 * freezing in \`build(def)\`.
 */
export const ${DEFINE_FN} = createDoctype<${PASCAL}Definition, ${PASCAL}Handle>({
  aip: ${AIP},
  name: "${SLUG}",
  validate(_def) {
    // TODO: spec-${AIP}-specific checks.
  },
  build(def) {
    return {
      id: def.id,
      description: def.description,
      // TODO: defaulting + nested freezing.
    }
  },
})
`,
)

write(
  "src/manifest/index.ts",
  `/**
 * AIP-${AIP} ${DOCTYPE}.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of \`@agentproto/tool/manifest\` and \`@agentproto/driver/manifest\`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in \`${DEFINE_FN}\` so the cross-AIP
 * invariants run uniformly.
 *
 * TODO: tighten the frontmatter schema once the AIP-${AIP} fields are
 * decided. The skeleton accepts arbitrary extra keys via \`.loose()\`.
 */

import matter from "gray-matter"
import { z } from "zod"
import { ${DEFINE_FN} } from "../define-${SLUG}.js"
import type { ${PASCAL}Handle } from "../types.js"

export const ${SLUG}ManifestFrontmatterSchema = z
  .object({
    schema: z.literal("agent${SLUG}/v1").optional(),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
    description: z.string().min(1).max(2000),
    // TODO: spec-${AIP} fields.
  })
  .loose()

export type ${PASCAL}ManifestFrontmatter = z.infer<
  typeof ${SLUG}ManifestFrontmatterSchema
>

export interface ${PASCAL}Manifest {
  frontmatter: ${PASCAL}ManifestFrontmatter
  body: string
}

export function parse${PASCAL}Manifest(source: string): ${PASCAL}Manifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parse${PASCAL}Manifest: missing or empty frontmatter")
  }
  const result = ${SLUG}ManifestFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      \`parse${PASCAL}Manifest: invalid frontmatter — \${result.error.issues
        .map((i) => \`\${i.path.join(".")}: \${i.message}\`)
        .join("; ")}\`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function ${SLUG}FromManifest(manifest: ${PASCAL}Manifest): ${PASCAL}Handle {
  const fm = manifest.frontmatter
  return ${DEFINE_FN}({
    id: fm.id,
    description: fm.description,
    // TODO: project the rest of the frontmatter.
  })
}
`,
)

write(
  `src/__tests__/define-${SLUG}.test.ts`,
  `import { describe, it, expect } from "vitest"
import { ${DEFINE_FN} } from "../define-${SLUG}.js"

describe("${DEFINE_FN} (AIP-${AIP})", () => {
  it("produces a frozen handle with defaults applied", () => {
    const handle = ${DEFINE_FN}({
      id: "smoke",
      description: "Smoke-test ${SLUG}.",
    })
    expect(handle.id).toBe("smoke")
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("rejects invalid id (uppercase)", () => {
    expect(() =>
      ${DEFINE_FN}({ id: "BadCaps", description: "x" }),
    ).toThrow(/${DEFINE_FN} \\(AIP-${AIP}\\): invalid id 'BadCaps'/)
  })

  it("rejects empty description", () => {
    expect(() =>
      ${DEFINE_FN}({ id: "ok", description: "" }),
    ).toThrow(/description must be 1–2000 chars/)
  })

  // TODO: spec-${AIP}-specific tests for build()/validate() once those land.
})
`,
)

write(
  "README.md",
  `# ${PKG_NAME}

AIP-${AIP} \`${DOCTYPE}.md\` reference implementation. ${description}

> **Status: 0.1.0-alpha.** Generated by \`scripts/scaffold-aip.mjs\` — \`build()\` and \`validate()\` bodies are TODOs.

Spec: <https://agentproto.sh/docs/aip-${AIP}>

## Usage

\`\`\`ts
import { ${DEFINE_FN} } from "${PKG_NAME}"

const x = ${DEFINE_FN}({
  id: "my-${SLUG}",
  description: "Short purpose.",
  // ...
})
\`\`\`

## License

MIT — see [LICENSE](./LICENSE).
`,
)

// LICENSE — symlink-style copy from a sibling package, but easier to just
// emit the standard MIT text. The scaffold target is owned by the same
// project; if a different copyright holder is needed, edit by hand.
write(
  "LICENSE",
  `MIT License

Copyright (c) ${new Date().getFullYear()} agentproto contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
)

console.log(`✓ scaffolded ${PKG_NAME} at packages/${SLUG}/`)
console.log(`  layer: ${layer || "(unset)"} · spec: ${title}`)
console.log(`  next: pnpm install && pnpm --filter=${PKG_NAME} build`)

// ── helpers ──────────────────────────────────────────────────────────

function write(rel, content) {
  const path = join(PKG_DIR, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  console.log(`  wrote ${rel}`)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
