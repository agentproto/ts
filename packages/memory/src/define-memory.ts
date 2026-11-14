import { createDoctype } from "@agentproto/doctype"
import { MemoryValidationError } from "./errors.js"
import type { MemoryDefinition, MemoryHandle } from "./types.js"
import { validateMemory } from "./validate.js"

const SLUG_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/

const constructMemory = createDoctype<MemoryDefinition, MemoryHandle>({
  aip: 72,
  name: "memory",
  readIdentity: (def) => def.slug as string,
  idPattern: SLUG_PATTERN,
  // `description` is optional and up to 4000 chars; the schema checks it.
  readDescription: false,
  build(def) {
    return deepFreeze({
      ...structuredClone(def),
      body: def.body ?? "",
      status: def.status ?? "active",
    }) as MemoryHandle
  },
})

/**
 * AIP-72 reference implementation of `defineMemory`: the writer path.
 *
 * Validates in canonical mode (rule 1: a writer sets `schema`, `slug`,
 * `kind`, `title`, `updated_at` on every item it creates) and throws a
 * `MemoryValidationError` whose `field` / `issues` name the offending
 * field paths. Only two values are filled in: `status` becomes `active`
 * when absent (section 3: a writer creates an item `active`), and an
 * absent `body` becomes `""`. Nothing else is defaulted; in particular
 * `tags` is not set to `[]`, since rule 4 omits an empty optional field.
 *
 * Built on `createDoctype` for the shared slug check and top-level
 * freeze; the handle is frozen deeply and does not alias the input.
 */
export function defineMemory(input: MemoryDefinition): MemoryHandle {
  const result = validateMemory(input, { canonical: true })
  if (!result.ok) {
    throw new MemoryValidationError("defineMemory (AIP-72)", result.errors)
  }
  return constructMemory(input)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}
