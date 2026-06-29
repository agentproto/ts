/**
 * Video catalog subpath.
 *
 * Re-exports the legacy `VIDEO_MODEL_CATALOG` shape verbatim. The richer
 * `VideoEntry` Zod schema (`@agstudio/model-catalog/schema`) is the
 * target normalized shape consumed by the registry/cost dispatcher; v1
 * preserves the legacy `VideoModelDefinition` so call sites are unchanged.
 */
export {
  VIDEO_MODEL_CATALOG,
  VIDEO_MODEL_IDS,
  AGENT_VIDEO_MODEL_IDS,
  generateVideoModelTable,
} from "./catalog.js"
export type { VideoModelDefinition } from "./catalog.js"
