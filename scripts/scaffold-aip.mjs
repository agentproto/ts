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
 * If `resources/aip-<N>/draft/<DOCTYPE>.schema.json` exists, the
 * scaffolder consumes it via `json-schema-to-typescript` (for the
 * `<Pascal>Definition` interface) and `json-schema-to-zod` (for the
 * manifest zod schema). When the schema is absent, fields stay as
 * TODOs — same as before.
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
 * The generated `validate()` and `build()` bodies are still hand-tuned
 * — the schema gives us the field set + length/pattern/enum
 * constraints "for free", but cross-field rules (`if/then/allOf` in
 * JSON Schema) are too varied to generate cleanly and stay as TODOs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import matter from "gray-matter"
import { compile as compileJsonSchema } from "json-schema-to-typescript"
import { jsonSchemaToZod } from "json-schema-to-zod"

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

// ── optional: read JSON Schema for the doctype's frontmatter ─────────
const schemaPath = resolve(
  SPEC_DIR,
  `resources/aip-${AIP}/draft/${DOCTYPE}.schema.json`,
)
const hasSchema = existsSync(schemaPath)
const schema = hasSchema
  ? JSON.parse(readFileSync(schemaPath, "utf8"))
  : null

// ── refuse to overwrite an existing package ──────────────────────────
if (existsSync(PKG_DIR)) {
  console.error(`package ${PKG_DIR} already exists — refusing to overwrite`)
  process.exit(1)
}

// ── codegen from JSON Schema (when present) ──────────────────────────
// json-schema-to-typescript emits an `export interface <Pascal>Definition`
// declaration; json-schema-to-zod emits a zod expression we splice into
// the manifest module. Both fall back to TODO stubs when no schema ships.
let definitionInterface = `export interface ${PASCAL}Definition {
  id: string
  description: string
  // TODO: add spec-${AIP} fields here.
}`
let zodSchemaExpr = `z
  .object({
    schema: z.literal("agent${SLUG}/v1").optional(),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
    description: z.string().min(1).max(2000),
    // TODO: spec-${AIP} fields.
  })
  .loose()`
// Identity + description-equivalent field detection. Each AIP doctype
// uses its own conventions: tool/driver/operator/skill use `id`, policy
// uses `slug`, lesson uses `slug`, etc. Likewise the LLM-facing prose
// is `description` for some, `name` for others, `persona_summary` for
// AIP-9. Detect from the schema's `required` keys; user can override
// the generated createDoctype call afterwards if the heuristic is wrong.
let identityField = "id"
let descriptionField = "description"
if (hasSchema && Array.isArray(schema.required)) {
  const req = schema.required
  if (req.includes("id")) identityField = "id"
  else if (req.includes("slug")) identityField = "slug"
  else if (req.includes("name")) identityField = "name"

  if (req.includes("description")) descriptionField = "description"
  else if (req.includes("persona_summary")) descriptionField = "persona_summary"
  else if (req.includes("title")) descriptionField = "title"
  else if (req.includes("name") && identityField !== "name")
    descriptionField = "name"
  else descriptionField = "" // skip the description check
}

if (hasSchema) {
  // json-schema-to-typescript derives the top-level type name from the
  // schema's `title`. Mutate a clone so the emitted interface is
  // `<Pascal>Definition` instead of e.g. `LESSONMdFrontmatterAIP11`.
  // The clone is throw-away — we don't write it back to disk.
  const schemaForTs = JSON.parse(JSON.stringify(schema))
  schemaForTs.title = `${PASCAL}Definition`
  const compiled = await compileJsonSchema(schemaForTs, `${PASCAL}Definition`, {
    bannerComment: "",
    additionalProperties: false,
    style: { semi: false, singleQuote: false },
  })
  // The compiler emits multiple interfaces (sub-objects, $defs). Keep
  // them all — downstream code can reference SkillRef, ToolRef, etc.
  definitionInterface = compiled.trim()
  zodSchemaExpr = jsonSchemaToZod(schema, { module: "none" })
    .trim()
    .replace(/;$/, "")
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
 *${
   hasSchema
     ? `\n * \`${PASCAL}Definition\` was generated from\n * \`resources/aip-${AIP}/draft/${DOCTYPE}.schema.json\` via json-schema-to-typescript.\n * \`${PASCAL}Handle\` is the readonly view of the same shape; tighten it\n * by hand for fields that get defaults applied in build().`
     : `\n * TODO: fill in fields from the AIP-${AIP} ${DOCTYPE}.md frontmatter.\n * The two universals (id + description) are the cross-AIP invariants\n * \`createDoctype\` enforces; everything else is spec-${AIP}-specific.`
 }
 */

${definitionInterface}

export type ${PASCAL}Handle = Readonly<${PASCAL}Definition>
`,
)

const identityOverride =
  identityField !== "id"
    ? `\n  readIdentity: (def) => def.${identityField},`
    : ""
const descriptionOverride =
  descriptionField === ""
    ? `\n  readDescription: false,`
    : descriptionField !== "description"
      ? `\n  readDescription: (def) => def.${descriptionField},`
      : ""

// When the spec ships a JSON Schema, extract the zod schema to its own
// file so both authoring paths (defineX from TS, parseManifest from MD)
// can run it. Single source of truth — every field-level constraint
// (length, pattern, enum, default) flows from the JSON Schema.
if (hasSchema) {
  write(
    "src/schema.ts",
    `/**
 * AIP-${AIP} ${DOCTYPE}.md frontmatter zod schema.
 *
 * Generated from \`resources/aip-${AIP}/draft/${DOCTYPE}.schema.json\` via
 * json-schema-to-zod. Imported by both \`define-${SLUG}.ts\` (TS path
 * validation) and \`manifest/index.ts\` (.md path validation) so every
 * field-level constraint runs in both authoring paths from a single
 * source of truth — re-run scaffold-aip to refresh after spec changes.
 *
 * Cross-field rules (if/then/allOf in JSON Schema) don't translate
 * cleanly and live in \`define-${SLUG}.ts\`'s \`validate(def)\` instead.
 */

import { z } from "zod"

export const ${SLUG}FrontmatterSchema = ${zodSchemaExpr}

export type ${PASCAL}Frontmatter = z.infer<typeof ${SLUG}FrontmatterSchema>
`,
  )
}

const validateBody = hasSchema
  ? `    const result = ${SLUG}FrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        \`${DEFINE_FN} (AIP-${AIP}): \${result.error.issues
          .map((i) => \`\${i.path.join(".")}: \${i.message}\`)
          .join("; ")}\`,
      )
    }
    // TODO: spec-${AIP}-specific cross-field rules (if/then/allOf in
    // the JSON Schema) — those don't translate to zod cleanly and
    // belong here. See @agentproto/operator's autonomy=gated rule.`
  : `    // TODO: spec-${AIP}-specific checks.`

const validateImport = hasSchema
  ? `\nimport { ${SLUG}FrontmatterSchema } from "./schema.js"`
  : ""

const validateParam = hasSchema ? "def" : "_def"

write(
  `src/define-${SLUG}.ts`,
  `import { createDoctype } from "@agentproto/define-doctype"${validateImport}
import type { ${PASCAL}Definition, ${PASCAL}Handle } from "./types.js"

/**
 * AIP-${AIP} reference implementation of \`${DEFINE_FN}\`.
 *
 * Built on \`createDoctype\` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "${DEFINE_FN} (AIP-${AIP}): …"
 * error prefix) run uniformly with every other AIP defineX.${
   hasSchema
     ? `\n *\n * Field-level validation runs the schema-derived zod from\n * \`./schema.ts\` against the input. Same source of truth as the .md\n * path uses (\`parse${PASCAL}Manifest\`), so a malformed TS-authored\n * definition fails with the same diagnostic as a malformed manifest.\n * Cross-field rules go in \`validate(def)\` after the zod check.`
     : `\n *\n * Spec-${AIP}-specific validation goes in \`validate(def)\`; defaulting\n * and nested freezing in \`build(def)\`.`
 }${
   hasSchema && (identityField !== "id" || descriptionField !== "description")
     ? `\n *\n * Identity / description extractors detected from the JSON Schema:\n *   readIdentity: def.${identityField}${descriptionField ? `\n *   readDescription: def.${descriptionField}` : "\n *   readDescription: skipped (no string-y required field detected)"}.`
     : ""
 }
 */
export const ${DEFINE_FN} = createDoctype<${PASCAL}Definition, ${PASCAL}Handle>({
  aip: ${AIP},
  name: "${SLUG}",${identityOverride}${descriptionOverride}
  validate(${validateParam}) {
${validateBody}
  },
  build(def) {
    // Default build: spread the validated definition into a fresh object.
    // Hand-tune for nested freezing (Object.freeze on arrays/objects) and
    // for fields that need defaults applied — see @agentproto/operator
    // for a reference shape.
    return { ...def } as ${PASCAL}Handle
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
 *${
   hasSchema
     ? `\n * The frontmatter zod schema below was generated from\n * \`resources/aip-${AIP}/draft/${DOCTYPE}.schema.json\` via json-schema-to-zod.\n * Re-run scaffold-aip to refresh after spec changes (or hand-tune\n * any constraint the converter doesn't capture cleanly).`
     : `\n * TODO: tighten the frontmatter schema once the AIP-${AIP} fields are\n * decided. The skeleton accepts arbitrary extra keys via \\\`.loose()\\\`.`
 }
 */

import matter from "gray-matter"
${
  hasSchema
    ? `import { ${SLUG}FrontmatterSchema, type ${PASCAL}Frontmatter } from "../schema.js"`
    : `import { z } from "zod"`
}
import { ${DEFINE_FN} } from "../define-${SLUG}.js"
import type { ${PASCAL}Definition, ${PASCAL}Handle } from "../types.js"

${
  hasSchema
    ? `// Re-export so consumers can import the schema + inferred type either
// from "@${PKG_NAME}/manifest" or directly from "@${PKG_NAME}/schema".
export { ${SLUG}FrontmatterSchema, type ${PASCAL}Frontmatter }`
    : `export const ${SLUG}ManifestFrontmatterSchema = ${zodSchemaExpr}

export type ${PASCAL}ManifestFrontmatter = z.infer<
  typeof ${SLUG}ManifestFrontmatterSchema
>`
}

export interface ${PASCAL}Manifest {
  frontmatter: ${hasSchema ? `${PASCAL}Frontmatter` : `${PASCAL}ManifestFrontmatter`}
  body: string
}

export function parse${PASCAL}Manifest(source: string): ${PASCAL}Manifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parse${PASCAL}Manifest: missing or empty frontmatter")
  }
  const result = ${hasSchema ? `${SLUG}FrontmatterSchema` : `${SLUG}ManifestFrontmatterSchema`}.safeParse(parsed.data)
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
  // The zod-validated frontmatter is structurally compatible with
  // ${PASCAL}Definition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return ${DEFINE_FN}(manifest.frontmatter as unknown as ${PASCAL}Definition)
}
`,
)

// Smoke-test template: when we detected the doctype's universal fields
// match the createDoctype defaults (id + description), generate the
// usual three-assertion smoke. When the schema diverges (slug vs id,
// persona_summary vs description, …) the smoke would need every
// required field to construct a valid def — too much to template
// cleanly, so we emit a minimal "import works" test the author replaces.
const useStandardSmoke =
  identityField === "id" && descriptionField === "description"

write(
  `src/__tests__/define-${SLUG}.test.ts`,
  useStandardSmoke
    ? `import { describe, it, expect } from "vitest"
import { ${DEFINE_FN} } from "../define-${SLUG}.js"

describe("${DEFINE_FN} (AIP-${AIP})", () => {
  it("produces a frozen handle with defaults applied", () => {
    const handle = ${DEFINE_FN}({
      id: "smoke",
      description: "Smoke-test ${SLUG}.",
    } as never)
    expect(handle.id).toBe("smoke")
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("rejects invalid id (uppercase)", () => {
    expect(() =>
      ${DEFINE_FN}({ id: "BadCaps", description: "x" } as never),
    ).toThrow(/${DEFINE_FN} \\(AIP-${AIP}\\): invalid id 'BadCaps'/)
  })

  it("rejects empty description", () => {
    expect(() =>
      ${DEFINE_FN}({ id: "ok", description: "" } as never),
    ).toThrow(/description must be 1–2000 chars/)
  })

  // TODO: spec-${AIP}-specific tests for build()/validate() once those land.
})
`
    : `import { describe, it, expect } from "vitest"
import { ${DEFINE_FN} } from "../define-${SLUG}.js"

describe("${DEFINE_FN} (AIP-${AIP})", () => {
  // The AIP-${AIP} doctype uses '${identityField}'${
        descriptionField ? ` + '${descriptionField}'` : ""
      } instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof ${DEFINE_FN}).toBe("function")
  })

  // TODO: spec-${AIP} tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
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
