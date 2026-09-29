import { createDoctype } from "@agentproto/define-doctype"
import { browserManifestSchema } from "./provider.js"
import type { BrowserDefinition, BrowserProvider } from "./provider.js"

/** Parse the manifest half of a definition, or throw one readable error. */
function parseManifest(def: BrowserDefinition) {
  const { launch: _launch, check: _check, ...manifest } = def
  const parsed = browserManifestSchema.safeParse(manifest)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
    throw new Error(`defineBrowser: id='${String(def.id)}' invalid manifest: ${issues}`)
  }
  return parsed.data
}

/**
 * Define a browser provider: a validated manifest plus an idempotent
 * `launch`. Built on `createDoctype` like `defineDriver`; pure construction,
 * no I/O at definition time.
 */
export const defineBrowser = createDoctype<BrowserDefinition, BrowserProvider>({
  aip: 63,
  name: "browser",
  validate(def) {
    parseManifest(def)
    if (typeof def.launch !== "function") {
      throw new Error(`defineBrowser: id='${def.id}' must provide a launch() function`)
    }
    if (def.check !== undefined && typeof def.check !== "function") {
      throw new Error(`defineBrowser: id='${def.id}' check must be a function`)
    }
  },
  build(def) {
    const m = parseManifest(def)
    return {
      ...m,
      capabilities: Object.freeze(m.capabilities),
      install: Object.freeze(m.install.map((i) => Object.freeze(i))),
      requires: Object.freeze(m.requires),
      options: Object.freeze(m.options.map((o) => Object.freeze(o))),
      config: Object.freeze(m.config.map((c) => Object.freeze(c))),
      launch: def.launch,
      ...(def.check ? { check: def.check } : {}),
    } as BrowserProvider
  },
})
