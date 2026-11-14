/**
 * Installs the runtime's concrete implementations of the sentinel platform
 * ports.
 *
 * Every runtime module that creates or drives sentinel objects imports this
 * module for its side effect (http-server, mcp-events, retirement-cleanup,
 * index), so the platform is configured no matter which entry is loaded.
 * Sentinel has no production defaults of its own: a port that is not
 * installed here throws `sentinel platform not configured: <port>`.
 */

import { configureSentinelPlatform } from "@agentproto/sentinel"
import { execGh, fetchPrStatus, prRef, parsePrUrl, PrLookupError } from "./review-pr.js"
import { sharedAdapterDiscovery, sharedProviderProbe } from "./provider-probes.js"
import { loadImportedMcps } from "./mcp-imports.js"
import { writeFileDurable, writeFileDurableSync, appendLineDurableSync } from "./durable-file.js"
import { createDurableRowFile, oldestTerminalKey } from "./durable-row-file.js"
import { deliverEventEnvelope, serializeEnvelope, callbackHost, redactUrls } from "./webhook-egress/delivery.js"
import { verifyInboundSignature } from "./inbound-adapters.js"
import { createSessionMessage, MAX_MESSAGE_DATA_BYTES, MESSAGE_URGENCIES } from "./session-message.js"
import { SessionNotAliveError } from "./sessions.js"
import { ulid } from "./app-state.js"
import { isRetired } from "./session-retirement.js"
import { DELIBERATE_END_REASONS } from "./session-end-reason.js"
import { normalizeExpiresAt, isExpiresAtReached } from "./expires-at.js"

configureSentinelPlatform({
  github: { execGh, fetchPrStatus, prRef, parsePrUrl, PrLookupError },
  discovery: {
    discover: () => sharedAdapterDiscovery.discover(),
    probe: specifier => sharedProviderProbe.probe(specifier),
  },
  mcpImports: { loadImportedMcps: () => loadImportedMcps() },
  webhookDelivery: { deliverEventEnvelope, serializeEnvelope, callbackHost, redactUrls, verifyInboundSignature },
  durable: { writeFileDurable, writeFileDurableSync, appendLineDurableSync, createDurableRowFile, oldestTerminalKey },
  messages: {
    createSessionMessage,
    maxMessageDataBytes: MAX_MESSAGE_DATA_BYTES,
    isSessionNotAlive: err => err instanceof SessionNotAliveError,
    urgencies: MESSAGE_URGENCIES,
  },
  ids: { ulid },
  lifecycle: { isRetired, DELIBERATE_END_REASONS, normalizeExpiresAt, isExpiresAtReached },
})
