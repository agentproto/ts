#!/usr/bin/env node
/**
 * `llm-endpoint` — bin entry. Boots the proxy gateway.
 * Port: LLM_ENDPOINT_PORT | PORT | 18090.
 */
import { injectProviderKeysIntoEnv } from '@agentproto/providers-store';
import { start } from './index.js';

// Load any keys stored via `agentproto auth provider set` into this
// process's env BEFORE the gateway boots, so resolveSecretKeys() (which only
// reads process.env) picks them up for free. Explicit env always wins (a
// pre-set FOO_API_KEY is never overwritten). Best-effort — a missing/unreadable
// store (the normal case for a fresh install) is non-fatal.
try {
  const injected = await injectProviderKeysIntoEnv(process.env);
  if (injected.length > 0) {
    console.error(`[llm-endpoint] loaded ${injected.length} provider key(s) from store: ${injected.join(', ')}`);
  }
} catch {
  // providers.json missing / unreadable — env-only operation is fine.
}

start();
