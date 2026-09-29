#!/usr/bin/env node
/**
 * scaffold-aip — generate a package skeleton for an AIP.
 *
 * Reads the doctype's JSON-Schema draft from the VENDORED
 * `specs/resources/aip-<N>/draft/<DOCTYPE>.schema.json` (synced from
 * canonical agentproto/agentproto by `scripts/sync-specs.mjs` — #1207:
 * never a sibling `../agentproto` checkout) and emits a
 * `packages/<slug>/` skeleton wired up to:
 *
 *   - @agentproto/define-doctype (the meta-factory)
 *   - tsup + tsconfig matching the existing tool/ + driver/core layout
 *   - vitest with a smoke test
 *   - manifest subpath (parseXManifest + xFromManifest)
 *
 * The scaffolder consumes the draft via `json-schema-to-typescript`
 * (for the `<Pascal>Definition` interface) and `json-schema-to-zod`
 * (for the manifest zod schema). A missing draft is a hard error.
 *
 * Usage:
 *   node scripts/scaffold-aip.mjs --aip 9 --slug operator --doctype OPERATOR
 *
 *   --aip      AIP number (required) — locates the vendored JSON draft
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
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { compile as compileJsonSchema } from "json-schema-to-typescript"
import { jsonSchemaToZod } from "json-schema-to-zod"

const HERE = dirname(fileURLToPath(import.meta.url))
const TS_ROOT = resolve(HERE, "..")

// Specs come from the VENDORED tree (`specs/resources`), synced from
// canonical agentproto/agentproto by scripts/sync-specs.mjs (#1207: never
// a sibling `../agentproto` checkout). Override with --resources-dir.
let RESOURCES_DIR = resolve(TS_ROOT, "specs", "resources")

// ── arg parsing ──────────────────────────────────────────────────────
const KNOWN_FLAGS = new Set([
  "aip",
  "slug",
  "doctype",
  "schema-only",
  "inline-refs",
  "resources-dir",
])
const args = parseArgs(process.argv.slice(2))
for (const k of Object.keys(args)) {
  if (!KNOWN_FLAGS.has(k)) {
    console.error(`scaffold-aip: unknown flag --${k}`)
    process.exit(2)
  }
}
if (args["resources-dir"] !== undefined)
  RESOURCES_DIR = resolve(String(args["resources-dir"]))
if (!existsSync(RESOURCES_DIR)) {
  console.error(
    `scaffold-aip: specs/resources not found at ${RESOURCES_DIR} (vendored tree missing? run scripts/sync-specs.mjs)`,
  )
  process.exit(2)
}
if (!args.aip || !args.slug || !args.doctype) {
  console.error(
    "Usage: scaffold-aip --aip <N> --slug <slug> --doctype <DOCTYPE> [--schema-only] [--inline-refs] [--resources-dir <dir>]",
  )
  process.exit(2)
}
// --schema-only: emit ONLY the schema.ts content to stdout (no package
// scaffold, no writes). Used to re-cut schemas for already-existing
// packages when the JSON Schema or this generator's logic changes.
const SCHEMA_ONLY = Boolean(args["schema-only"])
const INLINE_REFS = Boolean(args["inline-refs"])

const AIP = Number(args.aip)
const SLUG = args.slug
const DOCTYPE = args.doctype.toUpperCase()
const PASCAL = capitalize(SLUG)
// CAMEL is for places that need a JS identifier — e.g.
// `${CAMEL}FrontmatterSchema`, `${CAMEL}FromManifest`. Slugs without
// separators (`operator`) collapse to the same lowercase string;
// hyphenated slugs (`agency-v2`) become `agencyV2`.
const CAMEL =
  PASCAL.length > 0 ? PASCAL.charAt(0).toLowerCase() + PASCAL.slice(1) : ""
const DEFINE_FN = `define${PASCAL}`
const PKG_NAME = `@agentproto/${SLUG}`
const PKG_DIR = resolve(TS_ROOT, "packages", SLUG)

// ── read the JSON-Schema draft (title/description come from it too) ──
const schemaPath = resolve(RESOURCES_DIR, `aip-${AIP}/draft/${DOCTYPE}.schema.json`)
if (!existsSync(schemaPath)) {
  console.error(`--schema-only: no JSON Schema at ${relative(TS_ROOT, schemaPath)}`)
  process.exit(1)
}
const schema = JSON.parse(readFileSync(schemaPath, "utf8"))

const title = String(schema.title ?? `AIP-${AIP}: ${DOCTYPE}.md`)
const description = String(
  schema.description ??
    `AIP-${AIP} reference implementation — ${DOCTYPE}.md doctype.`,
)

// ── refuse to overwrite an existing package ──────────────────────────
// `--schema-only` bypasses this guard — it emits to stdout, never to
// the package directory, so an existing package is fine (in fact, the
// usual case: regenerating the schema for a published package).
if (!SCHEMA_ONLY && existsSync(PKG_DIR)) {
  console.error(`package ${PKG_DIR} already exists — refusing to overwrite`)
  process.exit(1)
}

// ── codegen from JSON Schema ─────────────────────────────────────────
// json-schema-to-typescript emits an `export interface <Pascal>Definition`
// declaration; json-schema-to-zod emits a zod expression we splice into
// the manifest module.
let definitionInterface
let zodSchemaExpr
// Identity + description-equivalent field detection. Each AIP doctype
// uses its own conventions: tool/driver/operator/skill use `id`, policy
// uses `slug`, lesson uses `slug`, etc. Likewise the LLM-facing prose
// is `description` for some, `name` for others, `persona_summary` for
// AIP-9. Detect from the schema's `required` keys; user can override
// the generated createDoctype call afterwards if the heuristic is wrong.
let identityField = "id"
let descriptionField = "description"
if (Array.isArray(schema.required)) {
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

// Inline cross-AIP $refs (e.g. AIP-15 WORKFLOW.schema.json references
// https://agentproto.dev/schemas/aip-16/IO.schema.json). Both
// json-schema-to-typescript and json-schema-to-zod try HTTP-resolve
// these by default and fail offline. Walk the schema, load referenced
// files from `<RESOURCES_DIR>/aip-N/draft/`, attach to `$defs`, rewrite refs
// to local `#/$defs/<key>` form. Idempotent across nested refs.
inlineExternalRefs(schema, RESOURCES_DIR)

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
definitionInterface = relaxMixedIndexSignatures(compiled.trim())
  // json-schema-to-zod@2.6.x collapses a top-level `oneOf` of `$ref`s
  // (the discriminator pattern AIP-6 + AIP-10 use) into a broken
  // `z.any().superRefine` block that always fails the exactly-one
  // check. Detect that case and emit `z.discriminatedUnion(...)`
  // ourselves before falling back to the generic codegen.
  // json-schema-to-zod cannot follow `$ref` (it emits `z.any()`, a silent
  // validation hole). `--inline-refs` hands it a copy with every local
  // `#/$defs/<key>` ref inlined (opt-in: it tightens every ref'd field from
  // `z.any()` to its real shape, which an existing package must adopt
  // deliberately). The TS interface above still uses the ref'd original.
  const zodSchema = INLINE_REFS ? inlineLocalRefs(schema, schema.$defs ?? {}) : schema
  const discriminatedUnionExpr = tryDiscriminatedUnion(zodSchema)
  // json-schema-to-zod emits the zod v3 `.refine(pred, "msg")` shape;
  // zod v4 takes `.refine(pred, { message: "msg" })`. Walk the output
  // and rewrite — paren-aware (a regex would break on the nested
  // commas inside the predicate's arrow function args).
  let zodSrc = upgradeRefineToV4(
    (discriminatedUnionExpr ??
      jsonSchemaToZod(zodSchema, { module: "none", parserOverride: oneOfOverride }))
      .trim()
      .replace(/;$/, ""),
  )
  // zod 4 + strict + nested defaults: `.strict().default({})` fails TS
  // typecheck because the strict object's input shape requires fields
  // whose own defaults TS can't see at the call site. Cast empty
  // literal defaults so the schema typechecks; runtime behaviour is
  // unchanged (zod still applies the inner defaults at parse time).
  zodSrc = zodSrc
    .replace(/\.default\(\{\}\)/g, ".default({} as never)")
    .replace(/\.default\(\[\]\)/g, ".default([] as never)")
zodSchemaExpr = zodSrc

// ── --schema-only short-circuit ──────────────────────────────────────
// Emit just the schema.ts content to stdout and exit before any writes
// hit the package directory. Lets callers refresh schemas in published
// packages without dragging the rest of the skeleton along.
if (SCHEMA_ONLY) {
  process.stdout.write(
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

export const ${CAMEL}FrontmatterSchema = ${zodSchemaExpr}

export type ${PASCAL}Frontmatter = z.infer<typeof ${CAMEL}FrontmatterSchema>
`,
  )
  process.exit(0)
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
 *   - MD:  \`parse${PASCAL}Manifest(src) → ${CAMEL}FromManifest({...})\` → \`${PASCAL}Handle\`
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
 * \`${PASCAL}Definition\` was generated from
 * \`resources/aip-${AIP}/draft/${DOCTYPE}.schema.json\` via json-schema-to-typescript.
 * \`${PASCAL}Handle\` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
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

// Extract the zod schema to its own file so both authoring paths
// (defineX from TS, parseManifest from MD) can run it. Single source of
// truth — every field-level constraint (length, pattern, enum, default)
// flows from the JSON Schema.
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

export const ${CAMEL}FrontmatterSchema = ${zodSchemaExpr}

export type ${PASCAL}Frontmatter = z.infer<typeof ${CAMEL}FrontmatterSchema>
`,
)

const validateBody = `    const result = ${CAMEL}FrontmatterSchema.safeParse(def)
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

const validateImport = `\nimport { ${CAMEL}FrontmatterSchema } from "./schema.js"`

const validateParam = "def"

write(
  `src/define-${SLUG}.ts`,
  `import { createDoctype } from "@agentproto/define-doctype"${validateImport}
import type { ${PASCAL}Definition, ${PASCAL}Handle } from "./types.js"

/**
 * AIP-${AIP} reference implementation of \`${DEFINE_FN}\`.
 *
 * Built on \`createDoctype\` so the cross-AIP invariants (id pattern,
 * description length, top-level freeze, "${DEFINE_FN} (AIP-${AIP}): …"
 * error prefix) run uniformly with every other AIP defineX.
 *
 * Field-level validation runs the schema-derived zod from
 * \`./schema.ts\` against the input. Same source of truth as the .md
 * path uses (\`parse${PASCAL}Manifest\`), so a malformed TS-authored
 * definition fails with the same diagnostic as a malformed manifest.
 * Cross-field rules go in \`validate(def)\` after the zod check.${
   identityField !== "id" || descriptionField !== "description"
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
 * The frontmatter zod schema below was generated from
 * \`resources/aip-${AIP}/draft/${DOCTYPE}.schema.json\` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { ${CAMEL}FrontmatterSchema, type ${PASCAL}Frontmatter } from "../schema.js"
import { ${DEFINE_FN} } from "../define-${SLUG}.js"
import type { ${PASCAL}Definition, ${PASCAL}Handle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@${PKG_NAME}/manifest" or directly from "@${PKG_NAME}/schema".
export { ${CAMEL}FrontmatterSchema, type ${PASCAL}Frontmatter }

export interface ${PASCAL}Manifest {
  frontmatter: ${PASCAL}Frontmatter
  body: string
}

export function parse${PASCAL}Manifest(source: string): ${PASCAL}Manifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parse${PASCAL}Manifest: missing or empty frontmatter")
  }
  const result = ${CAMEL}FrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      \`parse${PASCAL}Manifest: invalid frontmatter — \${result.error.issues
        .map((i) => \`\${i.path.join(".")}: \${i.message}\`)
        .join("; ")}\`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function ${CAMEL}FromManifest(manifest: ${PASCAL}Manifest): ${PASCAL}Handle {
  // The zod-validated frontmatter is structurally compatible with
  // ${PASCAL}Definition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return ${DEFINE_FN}(manifest.frontmatter as unknown as ${PASCAL}Definition)
}
`,
)

// Smoke-test template: even if the heuristic picked id + description
// for identity/desc, the schema almost always requires MORE fields
// (name, version, profile, …) — constructing a valid `{id, description}`
// smoke fails the schema's safeParse at runtime. Generate the minimal
// "import works" test; the author writes a real smoke once they know
// the full required-set.

write(
  `src/__tests__/define-${SLUG}.test.ts`,
  `import { describe, it, expect } from "vitest"
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
console.log(`  spec: ${title}`)
console.log(`  next: pnpm install && pnpm --filter=${PKG_NAME} build`)

// ── helpers ──────────────────────────────────────────────────────────

function write(rel, content) {
  const path = join(PKG_DIR, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  console.log(`  wrote ${rel}`)
}

function parseArgs(argv) {
  const BOOLEAN_FLAGS = new Set(["schema-only", "inline-refs"])
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (BOOLEAN_FLAGS.has(key)) {
      out[key] = true
    } else if (next && !next.startsWith("--")) {
      out[key] = next
      i++
    } else {
      console.error(`scaffold-aip: flag --${key} requires a value`)
      process.exit(2)
    }
  }
  return out
}

function capitalize(s) {
  // PascalCase: split on `-` or `_`, uppercase each segment's first char.
  // Slug `agency-v2` → `AgencyV2` (TS-identifier-safe). Slugs without
  // separators are unchanged (`operator` → `Operator`).
  return s
    .split(/[-_]/)
    .map((seg) => (seg.length > 0 ? seg.charAt(0).toUpperCase() + seg.slice(1) : seg))
    .join("")
}

/**
 * Relax mismatched index signatures emitted by json-schema-to-typescript.
 *
 * When a JSON Schema has both `properties` (with optional members) and
 * `additionalProperties: { type: T }`, JSTT emits an interface like:
 *
 *     interface ColorTokens {
 *       background: string
 *       surface?: string                // optional → string | undefined
 *       [k: string]: string             // index says string (no undefined)
 *     }
 *
 * TS rejects the optional vs index mismatch. Walk line-by-line tracking
 * interface boundaries (carefully — JSDoc comments may contain braces
 * like "{colors.<name>}", so brace counting must skip comment lines).
 * For each interface body that has both an optional property and an
 * index signature, append ` | undefined` to the index's value type.
 * Runtime is unaffected.
 */
function relaxMixedIndexSignatures(tsSrc) {
  const lines = tsSrc.split("\n")
  let inInterface = false
  let depth = 0
  let hasOptional = false
  let indexLineIdx = -1
  let indexValueType = ""

  const flush = () => {
    if (
      hasOptional &&
      indexLineIdx >= 0 &&
      indexValueType &&
      !indexValueType.includes("undefined") &&
      indexValueType !== "unknown"
    ) {
      lines[indexLineIdx] = lines[indexLineIdx].replace(
        /(\[k:\s*string\]\s*:\s*)([^\n|]+)$/,
        (_m, prefix, value) => `${prefix}${value.trim()} | undefined`,
      )
    }
    inInterface = false
    depth = 0
    hasOptional = false
    indexLineIdx = -1
    indexValueType = ""
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!inInterface) {
      if (/^export interface\s+\w+\s*\{/.test(line)) {
        inInterface = true
        depth = 1
      }
      continue
    }
    // Brace counting — skip JSDoc comment lines (they may contain
    // `{...}` literals as documentation, not type structure).
    const trimmed = line.trimStart()
    const isCommentLine =
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("//")
    if (!isCommentLine) {
      for (const c of line) {
        if (c === "{") depth++
        else if (c === "}") {
          depth--
          if (depth === 0) {
            flush()
            break
          }
        }
      }
      if (!inInterface) continue
    }
    // Detect optional property at the top level of the body.
    if (/^\s*"?[\w$-]+"?\s*\?\s*:/.test(line)) {
      hasOptional = true
    }
    // Detect index signature line.
    const im = line.match(/^\s*\[k:\s*string\]\s*:\s*(.+)$/)
    if (im) {
      indexLineIdx = i
      indexValueType = im[1].trim()
    }
  }
  return lines.join("\n")
}

/**
 * Replace every local `{ "$ref": "#/$defs/<key>", ...siblings }` with the
 * referenced definition merged with its siblings (siblings win, as in
 * 2020-12). A ref that would recurse into itself is left in place. `$defs`
 * itself is passed through untouched. Returns a new tree.
 */
function inlineLocalRefs(node, defs, stack = []) {
  if (Array.isArray(node)) return node.map((n) => inlineLocalRefs(n, defs, stack))
  if (!node || typeof node !== "object") return node
  if (typeof node.$ref === "string") {
    const m = node.$ref.match(/^#\/\$defs\/([^/]+)$/)
    if (m && defs[m[1]] && !stack.includes(m[1])) {
      const { $ref: _ref, ...siblings } = node
      return {
        ...inlineLocalRefs(defs[m[1]], defs, [...stack, m[1]]),
        ...inlineLocalRefs(siblings, defs, stack),
      }
    }
  }
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    out[k] = k === "$defs" ? v : inlineLocalRefs(v, defs, stack)
  }
  return out
}

function renderZod(schema) {
  return jsonSchemaToZod(schema, { module: "none", parserOverride: oneOfOverride }).trim().replace(/;$/, "")
}

/**
 * json-schema-to-zod renders every `oneOf` as an "exactly one branch
 * passes" `superRefine`, whose only diagnostic is a count. When the branches
 * are provably disjoint that check is redundant and only hides the real
 * issue, so emit a plain zod union instead:
 *   - every branch is an object sharing a property whose `const` values are
 *     pairwise distinct  →  `z.discriminatedUnion`;
 *   - branch kinds (`const` → typeof, else `type`) are pairwise distinct
 *     →  `z.union`.
 * Anything else falls through to the library's default. Also restores
 * `propertyNames` on record schemas.
 */
function oneOfOverride(schema, refs) {
  // json-schema-to-zod drops `propertyNames`; a map whose keys are
  // constrained (e.g. binding ids) must keep that constraint.
  if (
    schema.type === "object" &&
    !schema.properties &&
    schema.propertyNames &&
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    const rec = `z.record(${renderZod(schema.propertyNames)}, ${renderZod(schema.additionalProperties)})`
    return (
      rec +
      (schema.description ? `.describe(${JSON.stringify(schema.description)})` : "")
    )
  }
  const branches = schema.oneOf
  if (!Array.isArray(branches) || branches.length < 2) return
  if (!branches.every((b) => b && typeof b === "object")) return

  const tail =
    (schema.description ? `.describe(${JSON.stringify(schema.description)})` : "") +
    (schema.default !== undefined ? `.default(${JSON.stringify(schema.default)})` : "")
  const render = renderZod

  if (branches.every((b) => b.type === "object" && b.properties)) {
    const shared = Object.keys(branches[0].properties).filter((k) =>
      branches.every((b) => k in b.properties),
    )
    for (const k of shared) {
      const literals = branches.map((b) => b.properties[k]?.const)
      if (
        literals.every((v) => typeof v === "string" || typeof v === "number") &&
        new Set(literals).size === literals.length
      ) {
        return `z.discriminatedUnion(${JSON.stringify(k)}, [${branches.map(render).join(", ")}])${tail}`
      }
    }
  }

  const kinds = branches.map((b) =>
    b.const !== undefined ? `const:${typeof b.const}` : typeof b.type === "string" ? b.type : undefined,
  )
  if (kinds.every((k) => k !== undefined) && new Set(kinds).size === kinds.length) {
    return `z.union([${branches.map(render).join(", ")}])${tail}`
  }
}

/**
 * Detect a top-level `oneOf` whose branches share a literal-`const`
 * discriminator field, and emit `z.discriminatedUnion(...)` directly.
 *
 * Returns the generated zod expression as a string when the pattern
 * matches, or `null` otherwise (so the caller falls back to the
 * generic json-schema-to-zod path).
 *
 * Pattern detected:
 *
 *   {
 *     "type": "object",
 *     "properties": { <shared top-level props> },
 *     "oneOf": [ { "$ref": "#/$defs/A" }, { "$ref": "#/$defs/B" }, … ],
 *     "$defs": {
 *       "A": { "type": "object", "properties": { "doctype": { "const": "a" }, … } },
 *       "B": { "type": "object", "properties": { "doctype": { "const": "b" }, … } },
 *       …
 *     }
 *   }
 *
 * Branches may also reference the discriminator via the same literal
 * `const` under any required field — we scan all branches' `const`
 * properties for a field whose values are all distinct literals
 * across branches.
 *
 * Each branch's merged JSON Schema is shared-top-level + branch
 * properties (branch wins on conflicts). json-schema-to-zod runs on
 * each merged branch on its own — which it handles fine, since the
 * inner shape no longer contains the unresolvable `oneOf`.
 */
function tryDiscriminatedUnion(schema) {
  if (!schema || typeof schema !== "object") return null
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) return null

  // Resolve each branch ref to its $def. Bail if any branch is not a
  // local $defs ref to a plain object schema with `properties`.
  const defs = schema.$defs ?? schema.definitions ?? {}
  const branches = []
  for (const branch of schema.oneOf) {
    if (!branch || typeof branch !== "object") return null
    let resolved = branch
    if (typeof branch.$ref === "string") {
      const m = branch.$ref.match(/^#\/\$defs\/([^/]+)$/)
      if (!m) return null
      const def = defs[m[1]]
      if (!def || typeof def !== "object") return null
      resolved = def
    }
    if (resolved.type !== "object" || !resolved.properties) return null
    branches.push(resolved)
  }

  // Find a discriminator: a property name present on every branch
  // whose value declares a literal `const`, and whose `const` values
  // are pairwise distinct across branches.
  const candidates = new Set(Object.keys(branches[0].properties))
  for (const b of branches.slice(1)) {
    for (const k of [...candidates]) {
      if (!(k in b.properties)) candidates.delete(k)
    }
  }
  let discriminator = null
  for (const k of candidates) {
    const literals = branches.map(b => b.properties[k]?.const)
    if (literals.some(v => v === undefined)) continue
    if (literals.every(v => typeof v === "string" || typeof v === "number")) {
      const distinct = new Set(literals)
      if (distinct.size === literals.length) {
        discriminator = k
        break
      }
    }
  }
  if (!discriminator) return null

  // Build a merged JSON Schema per branch: shared top-level
  // properties first, branch's properties on top (so the branch's
  // narrower `const` discriminator + required set win). Drop the
  // `oneOf` and `$defs` from each merged branch so json-schema-to-zod
  // doesn't try to follow them again.
  const sharedProps = schema.properties ?? {}
  const sharedRequired = Array.isArray(schema.required) ? schema.required : []
  const branchZodExprs = []
  for (const branch of branches) {
    const merged = {
      type: "object",
      additionalProperties:
        branch.additionalProperties ?? schema.additionalProperties ?? true,
      properties: { ...sharedProps, ...branch.properties },
      required: Array.from(
        new Set([
          ...sharedRequired,
          ...(Array.isArray(branch.required) ? branch.required : []),
        ]),
      ),
      $defs: defs,
    }
    if (branch.description) merged.description = branch.description
    // Strip oneOf / allOf if the branch carried any (it shouldn't, but
    // guard against unusual shapes).
    delete merged.oneOf
    delete merged.allOf
    const expr = jsonSchemaToZod(merged, { module: "none", parserOverride: oneOfOverride })
      .trim()
      .replace(/;$/, "")
    branchZodExprs.push(expr)
  }

  const describe = schema.description
    ? `.describe(${JSON.stringify(schema.description)})`
    : ""
  return `z.discriminatedUnion(${JSON.stringify(discriminator)}, [\n  ${branchZodExprs.join(",\n  ")},\n])${describe}`
}

/**
 * Rewrite `.refine(<predicate>, "<message>")` (zod v3) →
 * `.refine(<predicate>, { message: "<message>" })` (zod v4).
 *
 * Walks the source, finds each `.refine(`, tracks paren/string depth
 * to locate the matching close paren, then checks whether the second
 * arg is a bare string literal — if so, wraps it. Already-objected
 * args pass through untouched.
 */
function upgradeRefineToV4(src) {
  const NEEDLE = ".refine("
  let out = ""
  let i = 0
  while (i < src.length) {
    const idx = src.indexOf(NEEDLE, i)
    if (idx < 0) {
      out += src.slice(i)
      break
    }
    out += src.slice(i, idx + NEEDLE.length)
    let cursor = idx + NEEDLE.length
    let depth = 1
    let topComma = -1
    let inString = false
    let stringQuote = ""
    while (cursor < src.length && depth > 0) {
      const c = src[cursor]
      if (inString) {
        if (c === "\\") {
          cursor += 2
          continue
        }
        if (c === stringQuote) inString = false
      } else if (c === '"' || c === "'" || c === "`") {
        inString = true
        stringQuote = c
      } else if (c === "(") {
        depth++
      } else if (c === ")") {
        depth--
        if (depth === 0) break
      } else if (c === "," && depth === 1 && topComma < 0) {
        topComma = cursor
      }
      cursor++
    }
    const closeIdx = cursor
    if (topComma < 0) {
      out += src.slice(idx + NEEDLE.length, closeIdx + 1)
    } else {
      const predicate = src.slice(idx + NEEDLE.length, topComma)
      const second = src.slice(topComma + 1, closeIdx).trim()
      const stringLiteral = second.match(/^"((?:[^"\\]|\\.)*)"$/)
      if (stringLiteral) {
        out += `${predicate}, { message: ${second} })`
      } else {
        out += src.slice(idx + NEEDLE.length, closeIdx + 1)
      }
    }
    i = closeIdx + 1
  }
  return out
}

/**
 * Walk a JSON Schema and replace external `$ref` URLs that point to
 * sibling AIP schemas (e.g.
 * `https://agentproto.dev/schemas/aip-16/IO.schema.json`) with local
 * `#/$defs/<key>` references whose definitions live in the host
 * schema's `$defs`. Loads referenced files from
 * `<resourcesRoot>/aip-N/draft/<DOCTYPE>.schema.json`.
 *
 * Two non-trivial bits:
 *  - When a schema is inlined as `$defs/<key>`, its OWN internal refs
 *    (`#/$defs/foo`) need rewriting to `#/$defs/<key>/$defs/foo` so
 *    they still resolve. Done via `relocateInternalRefs`.
 *  - Some specs reference doctypes with broken filenames
 *    (e.g. AIP-15 → `aip-17/RUNTIME.schema.json` while the file is
 *    `RUNNER.schema.json`). When the target file doesn't exist, log a
 *    warning and stub with `{}` instead of throwing.
 */
function inlineExternalRefs(schema, resourcesRoot) {
  schema.$defs ??= {}
  const queue = [schema]

  while (queue.length > 0) {
    const current = queue.shift()
    walkExternal(current, schema, resourcesRoot, queue)
  }
}

function walkExternal(node, host, resourcesRoot, queue) {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) walkExternal(item, host, resourcesRoot, queue)
    return
  }
  if (typeof node.$ref === "string") {
    const m = node.$ref.match(
      /^https?:\/\/agentproto\.(?:dev|sh)\/schemas\/aip-(\d+)\/([A-Z][A-Z0-9_-]*)\.schema\.json(#[^"]*)?$/,
    )
    if (m) {
      const [, aipN, doctype, fragment] = m
      const defKey = `${doctype}_${aipN}`
      const filePath = `${resourcesRoot}/aip-${aipN}/draft/${doctype}.schema.json`
      if (existsSync(filePath)) {
        if (!(defKey in host.$defs)) {
          const referenced = JSON.parse(readFileSync(filePath, "utf8"))
          relocateInternalRefs(referenced, defKey)
          host.$defs[defKey] = referenced
          queue.push(referenced) // walk for further external refs
        }
        const innerPath = fragment ? fragment.replace(/^#/, "") : ""
        node.$ref = `#/$defs/${defKey}${innerPath}`
      } else {
        throw new Error(
          `scaffold-aip: broken external ref ${node.$ref} — ${filePath} not found in the vendored specs. Fix the ref in agentproto/agentproto and re-sync (scripts/sync-specs.mjs).`,
        )
      }
      return
    }
  }
  for (const key of Object.keys(node)) {
    walkExternal(node[key], host, resourcesRoot, queue)
  }
}

/**
 * After inlining a schema X under `$defs/<defKey>`, every `#/<path>`
 * inside X needs to become `#/$defs/<defKey>/<path>` so it resolves
 * to the same target relative to the new outer document.
 */
function relocateInternalRefs(node, defKey) {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) relocateInternalRefs(item, defKey)
    return
  }
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    node.$ref = `#/$defs/${defKey}${node.$ref.slice(1)}`
    return
  }
  for (const key of Object.keys(node)) {
    relocateInternalRefs(node[key], defKey)
  }
}
