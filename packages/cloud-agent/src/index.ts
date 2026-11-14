/**
 * @agentproto/cloud-agent: the AIP-66 managed cloud agent host surface.
 *
 * The vendor registry and pure spawn resolver, the `meta.cloud` mapping
 * helpers, the relay's session-meta side file and watch, the resume-side
 * vendor id fallback, and the declared-remote spawn env. The vendor adapter
 * itself (`claude-code-cloud`) stays in `adapters/`.
 *
 * @see https://agentproto.sh/docs/aip-66
 */

export const SPEC_NAME = "cloud-agent/v1" as const

export { GIT_TOKEN_ENV } from "./git-token.js"
export {
  CLOUD_ADAPTER_PLACEHOLDER,
  CLOUD_REFUSED_SPAWN_FIELDS,
  CLOUD_REPO_BRANCH_ENV,
  CLOUD_REPO_DIR_ENV,
  CLOUD_REPO_URL_ENV,
  CLOUD_SESSION_META_FILE,
  CLOUD_SESSION_META_FILE_ENV,
  CLOUD_VENDORS,
  CloudSpawnError,
  cloudHarnessFor,
  cloudMetaOf,
  cloudRepoCheckoutDir,
  cloudRepoSpawnEnv,
  cloudSessionIdOf,
  cloudSessionMetaFilePath,
  decodeCloudSessionMeta,
  encodeCloudSessionMeta,
  readCloudSessionMetaFile,
  resolveCloudResumeId,
  resolveCloudSpawn,
  watchCloudSessionMeta,
} from "./cloud-vendors.js"
export type {
  CloudRefusedSpawnField,
  CloudRemotePort,
  CloudSessionMeta,
  CloudSpawnInput,
  CloudVendor,
  CloudWorkspaceRemote,
  ResolvedCloudSpawn,
} from "./cloud-vendors.js"
