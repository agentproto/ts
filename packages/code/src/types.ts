/**
 * AIP-26 CodeDefinition + CodeHandle.
 *
 * `CodeDefinition` was generated from
 * `resources/aip-26/draft/CODE.schema.json` via json-schema-to-typescript.
 * `CodeHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Composable JSON Schema definitions for the `code` and `run` blocks reused across manifest formats. Other AIPs reference these by $ref into their own schemas.
 */
export interface CodeDefinition {}

export type CodeHandle = Readonly<CodeDefinition>
