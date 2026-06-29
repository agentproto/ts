/**
 * Image catalog subpath.
 *
 * Re-exports the legacy `IMAGE_MODEL_CATALOG` shape verbatim. The richer
 * `ImageEntry` Zod schema (`@agstudio/model-catalog/schema`) is the
 * target normalized shape consumed by the registry/cost dispatcher; v1
 * preserves the legacy `ImageModelDefinition` so call sites are unchanged.
 */
export {
  IMAGE_MODEL_CATALOG,
  IMAGE_MODEL_IDS,
  AGENT_IMAGE_MODEL_IDS,
  AGENT_GENERATIVE_MODEL_IDS,
  AGENT_EDITABLE_MODEL_IDS,
  generateImageModelTable,
} from "./catalog.js"
export type { ImageModelDefinition } from "./catalog.js"
