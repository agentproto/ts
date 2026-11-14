/**
 * @agentproto/memory: AIP-72 memory/v1 reference implementation.
 *
 * One small typed assertion (user, feedback, project, reference) about a
 * principal or its work, with a lifecycle, stored as a markdown file
 * with YAML frontmatter.
 *
 * Spec: https://agentproto.sh/docs/aip-72
 *
 * Authoring paths:
 *   - TS:  `defineMemory({...})` -> frozen `MemoryHandle` (writer, canonical)
 *   - MD:  `parseMemory(src)` -> `MemoryDocument`, then `validateMemory(doc)`
 *   - out: `renderMemory(doc)` -> MEMORY.md text
 *
 * Store (section 8): the `MemoryStore` port and `FilesMemoryStore`, the
 * reference layout (`items/<type>/<id>.md`, `proposals/<id>.md`).
 *
 * Node scope (section 10): `MemoryScope`, the `node:` and `operator:`
 * anchors, and the projection and write rules over a scope the host
 * computed (`isInNodeProjection`, `applyWriteScope`).
 */

export const SPEC_NAME = "memory/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineMemory } from "./define-memory.js"
export { validateMemory, type ValidateMemoryOptions } from "./validate.js"
export { parseMemory, renderMemory } from "./markdown.js"
export { isAllowedStatusTransition, isInForce, memoryStatus } from "./lifecycle.js"
export { MemoryParseError, MemoryValidationError } from "./errors.js"
export { memoryFrontmatterSchema } from "./schema.js"
export {
  applyWriteScope,
  assertRetagOnly,
  isInNodeProjection,
  isNodeOrOperatorTag,
  nodeAnchorIds,
  nodeTag,
  operatorAnchorIds,
  operatorTag,
  type NodeProjectionOptions,
  type WriteScopeOptions,
} from "./node-scope.js"
export {
  MemoryConflictError,
  MemoryNotFoundError,
  MemorySlugTakenError,
  MemoryStoreError,
  MemoryTransitionError,
  type IMemoryStore,
  type MemoryFilter,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchHit,
  type MemorySearchOptions,
  type MemoryStore,
  type MemoryStoreErrorCode,
  type MemoryWriteOptions,
} from "./store.js"
export {
  FilesMemoryStore,
  type FilesMemoryStoreOptions,
  type MemoryKnowledgeHit,
  type MemoryKnowledgeProvider,
} from "./files-store.js"
export {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type MemoryAnchor,
  type MemoryCapture,
  type MemoryDecidedBy,
  type MemoryDefinition,
  type MemoryDocument,
  type MemoryEvidence,
  type MemoryFrontmatter,
  type MemoryHandle,
  type MemoryIssue,
  type MemoryLifetime,
  type MemoryProvenance,
  type MemoryStatus,
  type MemoryType,
  type MemoryValidationResult,
} from "./types.js"
