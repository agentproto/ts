/**
 * AIP-17 RunnerDefinition + RunnerHandle.
 *
 * `RunnerDefinition` was generated from
 * `resources/aip-17/draft/RUNNER.schema.json` via json-schema-to-typescript.
 * `RunnerHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Composable JSON Schema definition for the `runner` block — process boundary, optional container image, declarative dependency needs, and resource limits. Other AIPs reference this by $ref into their own schemas.
 */
export interface RunnerDefinition {}

export type RunnerHandle = Readonly<RunnerDefinition>
