#!/usr/bin/env node
/**
 * `llm-endpoint` — bin entry. Boots the proxy gateway.
 * Port: LLM_ENDPOINT_PORT | PORT | 18090.
 *
 * Subcommand `print-waf-rule` prints a Cloudflare custom-rule expression that
 * enforces the same edge/WAF token gate the proxy checks in-process (see
 * buildWafRuleExpression/isEdgeAuthorized in ./index.js) and exits — it does
 * not boot the server.
 */
import { injectProviderKeysIntoEnv } from '@agentproto/providers-store';
import { start, parseAccessTokens, buildWafRuleExpression } from './index.js';

if (process.argv[2] === 'print-waf-rule') {
  const hostFlagIdx = process.argv.indexOf('--host');
  const host = hostFlagIdx !== -1 ? process.argv[hostFlagIdx + 1] : process.env.LLM_ENDPOINT_PUBLIC_HOST || undefined;

  const edgeTokens = [...parseAccessTokens(process.env.LLM_ENDPOINT_EDGE_TOKENS)];
  const accessTokensList = [...parseAccessTokens(process.env.LLM_ENDPOINT_ACCESS_TOKENS)];

  const useEdge = edgeTokens.length > 0;
  const tokens = useEdge ? edgeTokens : accessTokensList;
  const header = useEdge ? 'x-edge-auth' : 'authorization';

  if (tokens.length === 0) {
    console.error(
      '[llm-endpoint] print-waf-rule: no tokens found. Set LLM_ENDPOINT_EDGE_TOKENS or LLM_ENDPOINT_ACCESS_TOKENS first.'
    );
    process.exit(1);
  }

  console.log(buildWafRuleExpression({ host, tokens, header }));
  process.exit(0);
}

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
