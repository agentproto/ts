/**
 * AIP-16 IoDefinition + IoHandle.
 *
 * `IoDefinition` was generated from
 * `resources/aip-16/draft/IO.schema.json` via json-schema-to-typescript.
 * `IoHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Composable JSON Schema definitions for the four input/output blocks reused across manifest formats: inputs, outputs, inputsFiles, outputsFiles. Other AIPs reference these by $ref into their own schemas.
 */
export interface IoDefinition {}

export type IoHandle = Readonly<IoDefinition>
