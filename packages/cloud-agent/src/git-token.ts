/**
 * Env var the box (and the cloud relay) sees the workspace git token under.
 * Shared by the sandbox and cloud spawn paths - one definition, imported by
 * `@agentproto/runtime` rather than duplicated there.
 */
export const GIT_TOKEN_ENV = "AGENTPROTO_GIT_TOKEN"
