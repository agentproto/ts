/**
 * Version of the computer controller HTTP contract described by this
 * package. The controller routes live under this version prefix (for
 * example `POST /v1/computers`), and every payload schema here corresponds
 * to that version.
 *
 * Semver of the PACKAGE tracks this contract: a MAJOR bump of
 * `@agentproto/computer-api` is where this constant changes.
 */
export const COMPUTER_API_VERSION = "v1"
