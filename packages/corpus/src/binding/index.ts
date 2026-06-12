/**
 * Attachment binding plane — typed Dimensions × Selectors × one matcher.
 *
 * Asset-kind-agnostic: playbook overlays use it today; knowledge packs
 * and skills ride the same selector. Vendor-neutral: axes are AIP
 * concepts only — hosts register their own extra axes.
 */

export {
  ANY_REF,
  WELL_KNOWN_AXES,
  createAxisRegistry,
  identityAxis,
  roleAxis,
  positionAxis,
  capabilityAxis,
  prefixedRefNormalizer,
} from "./axes.js"
export type { AxisDefinition, AxisRegistry } from "./axes.js"

export {
  EMPTY_SELECTOR,
  isEmptySelector,
  matchesSelector,
} from "./selector.js"
export type {
  Dimensions,
  MatchOptions,
  Selector,
  SelectorTerm,
} from "./selector.js"

export { parseSelectorFrontmatter } from "./parse.js"
export { compileLegacyPlaybookBinding } from "./legacy.js"

export { matchAttachments, matchAttachmentRefs } from "./attachment.js"
export type {
  AttachmentAsset,
  AttachmentDeclaration,
  MatchAttachmentsOptions,
} from "./attachment.js"
