/**
 * Regenerate `fixtures/canonical-session.jsonl` from the single source of
 * truth, `CANONICAL_SESSION_RECORDS`.
 *
 * Run after `pnpm build` (it loads the built `dist/index.mjs`):
 *   pnpm --filter @agentproto/transcript-fixtures generate:fixtures
 *
 * The committed file is verified against the array by the test suite, so if
 * you change the records but forget to re-run this, the test will fail.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { CANONICAL_SESSION_JSONL } from "../dist/index.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(here, "..", "fixtures", "canonical-session.jsonl")

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, CANONICAL_SESSION_JSONL)
console.log(`wrote ${outPath}`)