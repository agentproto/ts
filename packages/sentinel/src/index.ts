/**
 * @agentproto/sentinel: the AIP-60 sentinel primitive.
 *
 * A sentinel watches a subject through a pluggable provider (local `gh`,
 * GitHub webhooks, agentpush, session lifecycle) and delivers matching
 * CloudEvents to a session inbox. Extracted from `@agentproto/runtime`;
 * the runtime depends on this package and re-exports the same public names.
 *
 * @see https://agentproto.sh/docs/aip-60
 */

export const SPEC_NAME = "sentinel/v1" as const

export {
  createSentinelStore,
  mintSentinelId,
  SENTINELS_FILE_PATH,
  sentinelsSecretsFileFor,
  WEBHOOK_SECRET_ROTATION_WINDOW_MS,
  DEFAULT_SENTINEL_TTL_MS,
  SentinelTargetNotImplementedError,
} from "./sentinel-store.js"
export type {
  Sentinel,
  SentinelStatus,
  SentinelCreateInput,
  SentinelUpdatePatch,
  SentinelWebhookSecret,
  SentinelSecretWriteResult,
  SentinelWebhookTargetAtRest,
  SentinelStore,
  SentinelStoreOptions,
} from "./sentinel-store.js"

export { createSentinelRuntime } from "./sentinel-runtime.js"
export type {
  SentinelRuntime,
  SentinelRuntimeOptions,
  SentinelRuntimeRegistry,
  SentinelSessionInfo,
} from "./sentinel-runtime.js"

export {
  BUILTIN_SENTINEL_PROVIDERS,
  BUILTIN_SENTINEL_SLUGS,
  configureSessionSentinelProvider,
  resolveSentinelProvider,
  discoverSentinelHandles,
} from "./sentinel-providers/registry.js"
export type {
  AdapterDiscoverer,
  ProviderProbe,
  SentinelCreds,
  SentinelProviderFactory,
  ResolveSentinelProviderOpts,
  DiscoverSentinelHandlesOpts,
} from "./sentinel-providers/registry.js"

export {
  SENTINEL_FAMILY,
  SENTINEL_CATALOG,
  makeSentinelCredsStore,
  makeSentinelResolver,
  makeSentinelLister,
  registerSentinelAdapterTools,
  toSentinelInfo,
} from "./sentinel-adapters.js"
export type { SentinelAdapterInfo, RegisterSentinelAdapterToolsOptions } from "./sentinel-adapters.js"

export {
  deliveryPreferenceFor,
  singleMatch,
  SentinelBackingExpiredError,
} from "./sentinel-providers/types.js"
export type {
  DeliveryPreference,
  SentinelCreateContext,
  SentinelEvent,
  SentinelHandle,
  SentinelMalformedItem,
  SentinelMatchClause,
  SentinelPollResult,
  SentinelProviderCapabilities,
  SentinelProviderHandle,
  SentinelProviderReadiness,
  SentinelSpec,
  SentinelTarget,
  SentinelUntil,
} from "./sentinel-providers/types.js"

export { LOCAL_GH_SLUG, localGhSentinelProvider } from "./sentinel-providers/local-gh.js"
export type { LocalGhProviderOptions } from "./sentinel-providers/local-gh.js"
export {
  AGENTPUSH_SLUG,
  AGENTPUSH_DEFAULT_BASE_URL,
  AGENTPUSH_MCP_ALIAS,
  AgentpushSetupError,
  AgentpushHttpError,
  agentpushSentinelProvider,
  computeSignatureV2,
  verifySignatureV2,
} from "./sentinel-providers/agentpush.js"
export type {
  AgentpushProviderOptions,
  SignatureV2Failure,
  VerifySignatureV2Result,
} from "./sentinel-providers/agentpush.js"
export {
  WEBHOOK_SLUG,
  WEBHOOK_ROUTE_PREFIX,
  WebhookSetupError,
  execGhWebhook,
  webhookSentinelProvider,
} from "./sentinel-providers/webhook.js"
export type { WebhookGhRunner, WebhookProviderOptions } from "./sentinel-providers/webhook.js"
export {
  SESSION_SLUG,
  SESSION_DEFAULT_TYPES,
  parseSessionSubject,
  sessionSentinelProvider,
} from "./sentinel-providers/session.js"
export type { SessionSentinelDeps, SessionSentinelLookup } from "./sentinel-providers/session.js"

export {
  createSentinelWatch,
  cancelSentinelWatch,
  registerSentinelTools,
  sentinelView,
  sentinelViewWithDelivery,
} from "./sentinel-tools.js"
export type {
  RegisterSentinelToolsOptions,
  SentinelRuntimeLike,
  SentinelTargetView,
  SentinelView,
  SentinelWatchDeps,
  SentinelWatchInput,
  SentinelWatchResult,
} from "./sentinel-tools.js"

export {
  makePublicUrlResolver,
  publicUrlFromEnv,
  resolveSentinelPublicUrl,
  setSentinelPublicUrlSource,
} from "./sentinel-public-url.js"
export type {
  PublicUrlTunnel,
  SentinelPublicUrl,
  SentinelPublicUrlResolver,
} from "./sentinel-public-url.js"

export { createSentinelAutoLinker } from "./sentinel-autolink.js"
export type {
  AutoLinkSession,
  SentinelAutoLinker,
  SentinelAutoLinkOptions,
} from "./sentinel-autolink.js"

export { GITHUB_DEFAULT_PR_TYPES, normalizeGithubEvent } from "./sentinel-github-normalize.js"
export type { GithubNormalizeInput, GithubNormalizeResult } from "./sentinel-github-normalize.js"

export { autoSelectProviderSlug } from "./sentinel-provider-select.js"
export type { AutoSelectDeps } from "./sentinel-provider-select.js"

export { handleSentinelInbound } from "./sentinel-inbound.js"
export type { SentinelInboundDeps, SentinelInboundResult } from "./sentinel-inbound.js"

export {
  createCancelTombstoneStore,
  defaultCancelTombstonePath,
} from "./sentinel-cancel-tombstones.js"
export type {
  CancelResult,
  CancelTombstone,
  CancelTombstoneOptions,
  CancelTombstoneStore,
} from "./sentinel-cancel-tombstones.js"

export {
  createSentinelWebhookOutbox,
  toWebhookEnvelope,
  webhookRequestId,
} from "./sentinel-webhook-outbox.js"
export type {
  PersistedOutboxRow,
  SentinelDeliveryStatus,
  SentinelWebhookOutbox,
  SentinelWebhookOutboxOptions,
  SentinelWebhookOutboxRow,
  SentinelWebhookOutboxStatus,
} from "./sentinel-webhook-outbox.js"

export {
  createSentinelQuarantine,
  defaultSentinelQuarantinePath,
} from "./sentinel-quarantine.js"
export type {
  SentinelQuarantine,
  SentinelQuarantineOptions,
  SentinelQuarantineRecord,
} from "./sentinel-quarantine.js"

export {
  configureSentinelPlatform,
  resetSentinelPlatform,
  sentinelPlatform,
  PrLookupError,
} from "./platform.js"
export type {
  DeliveryOutcome,
  DeliveryReplay,
  DeliveryState,
  DurableRowFile,
  DurableRowFileOptions,
  InboundSignatureProvider,
  McpEventEnvelope,
  SentinelDurablePort,
  SentinelGitHubPort,
  SentinelIdsPort,
  SentinelLifecyclePort,
  SentinelMcpImportsPort,
  SentinelMessagePort,
  SentinelPlatform,
  SentinelProviderDiscoveryPort,
  SentinelWebhookDeliveryPort,
  WriteFileDurableOptions,
} from "./platform.js"
export type {
  GhRunner,
  MessageKind,
  MessageRelation,
  MessageUrgency,
  PrStatusSnapshot,
  ReviewPrRef,
  SendMessageResult,
  SessionEvent,
  SessionEventBus,
  SessionMessage,
  SessionMessageFrom,
} from "./local-types.js"

export { createFakeSentinelProvider, makeFakeEvent } from "./sentinel-providers/fake.js"
export type {
  CreateFakeSentinelProviderOptions,
  FakeSentinelProvider,
} from "./sentinel-providers/fake.js"

export {
  WEBHOOK_HOOKS_FILE_PATH,
  createWebhookHookStore,
  getSharedWebhookHookStore,
} from "./sentinel-providers/webhook-hooks.js"
export type {
  WebhookHookRecord,
  WebhookHookStore,
  WebhookHookStoreOptions,
} from "./sentinel-providers/webhook-hooks.js"
