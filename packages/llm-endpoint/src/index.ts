import { createServer, IncomingMessage, ServerResponse } from 'http';
import { request, RequestOptions } from 'https';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import {
  ModelPack,
  ModelRoute,
  PACK_REGISTRY,
  resolvePack,
  buildMappingFromPack,
  listPackIds,
  matchesPattern,
  DEFAULT_PACK_ID,
  parseTransparentModel,
  KNOWN_TRANSPARENT_PROVIDERS,
  toAnthropicStyle,
  validateLocalPacks,
  isRecord,
} from './packs.js';
import {
  validateResponsesRequest,
  responsesToChatCompletionsRequest,
  chatCompletionsJsonToResponses,
  OpenAIChatToResponsesStreamConverter,
} from './responses.js';
import { getAuthProfile, KeychainStore } from '@agentproto/auth';

// Port local du proxy — surchargeable via env (LLM_ENDPOINT_PORT | PORT).
// NOTE: evaluated once at module-load time. Set the env variable *before*
// importing this module if you need a non-default port without passing it
// explicitly to start(port).
const PORT = Number(process.env.LLM_ENDPOINT_PORT ?? process.env.PORT ?? 18090);

// Helper: merged pack IDs (official + local). Cached after first call — the
// list is effectively static once getLocalPacks() has populated its cache.
let _mergedPackIdsCache: string[] | null = null;
function getMergedPackIds(): string[] {
  if (_mergedPackIdsCache !== null) return _mergedPackIdsCache;
  _mergedPackIdsCache = [...new Set([...listPackIds(), ...Object.keys(getLocalPacks())])];
  return _mergedPackIdsCache;
}

function resolvePackMerged(packId: string | null | undefined): ModelPack {
  if (!packId) packId = DEFAULT_PACK_ID;
  const local = getLocalPacks()[packId];
  if (local) return local;
  // resolvePack throws RangeError on unknown IDs; callers validate first via getMergedPackIds().
  return resolvePack(packId);
}

let _localPacksCache: Record<string, ModelPack> | null = null;

/** Outcome of reading packs.local.json from disk: the validated local packs,
 *  any field-scoped validation errors, and which candidate file was used. */
interface LocalPacksLoad {
  packs: Record<string, ModelPack>;
  errors: string[];
  path: string | null;
}

// Read + validate local pack overrides from gitignored JSON (ESM-safe; uses
// fileURLToPath). Searches: CWD/packs.local.json, then src/packs.local.json
// (dev), then the directory of this module file. Returns the FIRST candidate
// carrying a `{ packs: {...} }` envelope, validated against the ModelPack shape;
// `errors` names each offending pack/field. Does NOT touch the cache — callers
// decide fail-soft (load time) vs hard-fail (the reload endpoint).
function readLocalPacksFromDisk(): LocalPacksLoad {
  const moduleDir = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    resolvePath(process.cwd(), 'packs.local.json'),
    resolvePath(process.cwd(), 'src', 'packs.local.json'),
    resolvePath(moduleDir, 'packs.local.json'),
  ];
  for (const localPath of candidates) {
    let raw: string;
    try {
      raw = readFileSync(localPath, 'utf-8');
    } catch {
      // file doesn't exist — try next candidate
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { packs: {}, errors: [`${localPath}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`], path: localPath };
    }
    // A file without a truthy `packs` envelope isn't a local-packs source —
    // ignore it and try the next candidate (unchanged from prior behaviour).
    if (!isRecord(parsed) || !('packs' in parsed) || !parsed.packs) {
      continue;
    }
    const result = validateLocalPacks(parsed);
    if (!result.ok) {
      return { packs: {}, errors: result.errors.map((e) => `${localPath}: ${e}`), path: localPath };
    }
    return { packs: result.packs, errors: [], path: localPath };
  }
  return { packs: {}, errors: [], path: null };
}

// Load (and cache) local pack overrides. Fail-soft at load time: an invalid
// packs.local.json is skipped so the proxy keeps serving the built-in registry,
// but every offending pack/field is named in the warning — the reload endpoint
// turns the same errors into a hard 400.
function getLocalPacks(): Record<string, ModelPack> {
  if (_localPacksCache !== null) return _localPacksCache;
  const { packs, errors } = readLocalPacksFromDisk();
  for (const e of errors) {
    console.warn(`[llm-endpoint] Skipping invalid packs.local.json — ${e}`);
  }
  _localPacksCache = packs;
  return _localPacksCache;
}

/**
 * Drop the cached local packs (and the derived merged-id cache) so the next
 * getLocalPacks()/getMergedPackIds() re-reads packs.local.json from disk. The
 * clear lives here rather than in the reload handler so the handler never
 * reaches into the module cache vars directly.
 */
function resetLocalPacksCache(): void {
  _localPacksCache = null;
  _mergedPackIdsCache = null;
}

// Limite max d'outils par provider (au-delà, Groq renvoie 400 "maximum number of items is 128").
// Les providers non listés sont illimités. Le CLI `claude` charge sa config MCP globale
// (~/.claude + .mcp.json + skills) → dépasse souvent 128 outils → on tronque côté proxy.
const PROVIDER_MAX_TOOLS: Record<string, number> = {
  groq: 128,
  xai: 200
};

// Providers routables — sert d'allow-list pour l'override `?p=` et les préfixes
// transparents `provider/model`. Un `?p=<inconnu>` laisserait sinon hostname
// vide et échouerait plus loin avec une erreur opaque.
const KNOWN_PROVIDERS = new Set([...KNOWN_TRANSPARENT_PROVIDERS]);

// Options bag for trimTools — avoids tracking 7 ordered positional arguments.
export interface ToolTrimOptions {
  provider: string;
  queryTools: string | null;
  queryNoTools: string | null;
  headerTools: string | null;
  headerNoTools: string | null;
  headerExcludeTools: string | null;
}

// Trimme/strip les outils du payload selon :
//  - queryTools ("a,b,c") : allow-list explicite (garde uniquement ces outils, par nom).
//  - queryNoTools ("1") : strip TOUS les outils (+ tool_choice) → mode "lean".
//  - headers X-Proxy-Tools (allow-list) et X-Proxy-No-Tools (strip total)
//  - sinon : tronque au cap du provider si dépassé.
// `toolName` extrait le nom d'un outil quelle que soit sa forme (Anthropic: .name ;
// OpenAI function: .function.name). Doit tourner AVANT la transformation de forme
// propre à chaque provider (ZAI/Groq mappent input_schema → function.parameters).
export function trimTools(payload: any, opts: ToolTrimOptions): void {
  const { provider, queryTools, queryNoTools, headerTools, headerNoTools, headerExcludeTools } = opts;
  if (!payload || !Array.isArray(payload.tools) || payload.tools.length === 0) return;

  // 1. Strip total demandé explicite (?notools=1 ou ?tools=none ou header X-Proxy-No-Tools: 1)
  if (queryNoTools === '1' || queryTools === 'none' || headerNoTools === '1') {
    console.log(`[Proxy][tools] strip total (${payload.tools.length} outils supprimés)`);
    delete payload.tools;
    delete payload.tool_choice;
    return;
  }

  // 2. Allow-list explicite (?tools=Bash,Read,Write ou header X-Proxy-Tools: Bash,Read,Write)
  //    Supporte les wildcards : "agentproto_*" garde tous les outils dont le nom commence par "agentproto_".
  const allowList = headerTools || queryTools;
  if (allowList) {
    const patterns = allowList.split(',').map(s => s.trim()).filter(Boolean);
    const before = payload.tools.length;
    payload.tools = payload.tools.filter((t: any) => {
      const name = (t && (t.name || (t.function && t.function.name))) || '';
      return patterns.some(p => matchesPattern(name, p));
    });
    console.log(`[Proxy][tools] allow-list {${patterns.join(',')}} → ${before}→${payload.tools.length}`);
    if (payload.tools.length === 0) { delete payload.tools; delete payload.tool_choice; }
    return;
  }

  // 2b. Exclude-list via header X-Proxy-Exclude-Tools (strip certains outils, garde le reste)
  if (headerExcludeTools) {
    const patterns = headerExcludeTools.split(',').map((s: string) => s.trim()).filter(Boolean);
    const before = payload.tools.length;
    payload.tools = payload.tools.filter((t: any) => {
      const name = (t && (t.name || (t.function && t.function.name))) || '';
      return !patterns.some((p: string) => matchesPattern(name, p));
    });
    console.log(`[Proxy][tools] exclude-list {${patterns.join(',')}} → ${before}→${payload.tools.length}`);
    if (payload.tools.length === 0) { delete payload.tools; delete payload.tool_choice; }
    return;
  }

  // 3. Troncation au cap du provider (?tools absent)
  const cap = PROVIDER_MAX_TOOLS[provider];
  if (cap && payload.tools.length > cap) {
    const before = payload.tools.length;
    payload.tools = payload.tools.slice(0, cap);
    console.log(`[Proxy][tools] troncation cap ${cap} pour ${provider} → ${before}→${payload.tools.length}`);
  }
}

// Clés API par provider — forme fixe (accès `.openrouter` etc. typé `string`,
// pas soumis à noUncheckedIndexedAccess comme le serait un Record indexé).
interface ProviderKeys {
  anthropic: string;
  moonshot: string;
  openrouter: string;
  requesty: string;
  zai: string;
  groq: string;
  xai: string;
  openai: string;
}

// Résolution des clés API d'hôtes depuis les variables d'environnement.
// Place un fichier .env à la racine du workspace ou exporte les variables
// d'environnement avant de démarrer le serveur.
function resolveSecretKeys(): ProviderKeys {
  return {
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    moonshot: process.env.MOONSHOT_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
    requesty: process.env.REQUESTY_API_KEY || '',
    zai: process.env.ZHIPUAI_API_KEY || process.env.ZAI_API_KEY || '',
    groq: process.env.GROQ_API_KEY || '',
    xai: process.env.XAI_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
  };
}

function getResolvedKeys(): ProviderKeys {
  return resolveSecretKeys();
}

// OpenAI-compatible chat/completions endpoint for the OpenAI surface and the
// Responses API facade. Returns null for providers that only speak the
// Anthropic Messages shape (anthropic itself has no /chat/completions
// endpoint) so callers can fail loud with a 400 instead of misrouting.
function getChatCompletionsEndpoint(provider: string): { hostname: string; path: string } | null {
  switch (provider) {
    case 'anthropic':
      return null;
    case 'openrouter':
      return { hostname: 'openrouter.ai', path: '/api/v1/chat/completions' };
    case 'requesty':
      return { hostname: 'router.requesty.ai', path: '/v1/chat/completions' };
    case 'zai':
      return { hostname: 'open.bigmodel.cn', path: '/api/paas/v4/chat/completions' };
    case 'groq':
      return { hostname: 'api.groq.com', path: '/openai/v1/chat/completions' };
    case 'xai':
      return { hostname: 'api.x.ai', path: '/v1/chat/completions' };
    case 'openai':
      return { hostname: 'api.openai.com', path: '/v1/chat/completions' };
    case 'moonshot':
    default:
      return { hostname: 'api.moonshot.ai', path: '/v1/chat/completions' };
  }
}

export interface ModelRouteContext {
  activePack: ModelPack;
  queryModelCode: string | null;
  queryProvider: string | null;
  forcedAliasCode: string | null;
  /**
   * When true, the Messages path is allowed to match local-pack
   * `equivalentClaudeName` aliases. The OpenAI chat/completions and Responses
   * surfaces are always transparent and never resolve default alias packs.
   */
  allowAliases: boolean;
  /**
   * When true, the active pack has been run through {@link toAnthropicStyle}
   * for this request, so its `equivalentClaudeName` aliases are resolvable even
   * though it is an official (non-local) pack.
   */
  anthropicFormat?: boolean;
}

function applyProviderOverride(
  target: { provider: string; model: string; equivalentClaudeName?: string },
  providerOverride: string | null
): { provider: string; model: string } {
  const route = { provider: target.provider, model: target.model };
  if (!providerOverride) return route;
  if (!KNOWN_PROVIDERS.has(providerOverride)) {
    throw new Error(`Unknown provider "${providerOverride}" in ?p= (allowed: ${[...KNOWN_PROVIDERS].join(', ')})`);
  }
  return { provider: providerOverride, model: route.model };
}

/**
 * Resolves the upstream provider/model for a request.
 *
 * Messages path (`allowAliases: true`):
 *   - X-Proxy-Model-Alias header / PROXY_MODEL_ALIAS env forces a pack code.
 *   - Explicit ?m=<code> selects a pack code.
 *   - Local packs may define `equivalentClaudeName` aliases.
 *   - Public pack codes match transparent model IDs.
 *   - `provider/model` references are parsed transparently.
 *   - `?p=<provider>` with a bare model id routes to that provider.
 *
 * Chat/Responses paths (`allowAliases: false`):
 *   - Only `provider/model` references or `?p=<provider>` with a bare model id.
 *   - Pack aliases and regex fallbacks are intentionally not used.
 *
 * Throws a plain Error for unknown explicit codes/providers.
 */
export function resolveModelRoute(
  payload: { model?: string },
  ctx: ModelRouteContext,
  localPacks: Record<string, ModelPack> = getLocalPacks()
): { provider: string; model: string } {
  const mapping = buildMappingFromPack(ctx.activePack);
  const isLocalPack = Boolean(localPacks[ctx.activePack.id]);
  // Alias-bearing when the pack is local OR has been transformed to Anthropic
  // style for this request. Either way its equivalentClaudeName ids resolve.
  const isAliasPack = isLocalPack || Boolean(ctx.anthropicFormat);

  if (ctx.forcedAliasCode) {
    const forcedCode = ctx.forcedAliasCode.toLowerCase();
    const target = Object.entries(mapping).find(([code]) => code.toLowerCase() === forcedCode)?.[1];
    if (!target) {
      throw new Error(`Unknown model alias "${ctx.forcedAliasCode}" in active pack "${ctx.activePack.id}"`);
    }
    console.log(`[Proxy] Forced model alias "${ctx.forcedAliasCode}" -> ${target.provider}:${target.model}`);
    return applyProviderOverride(target, ctx.queryProvider);
  }

  if (ctx.queryModelCode) {
    const queryCode = ctx.queryModelCode.toLowerCase();
    const target = Object.entries(mapping).find(([code]) => code.toLowerCase() === queryCode)?.[1];
    if (!target) {
      throw new Error(`Unknown model code "${ctx.queryModelCode}" in active pack "${ctx.activePack.id}"`);
    }
    console.log(`[Proxy] Detected URL model parameter code "${ctx.queryModelCode}" -> ${target.provider}:${target.model}`);
    return applyProviderOverride(target, ctx.queryProvider);
  }

  const incomingModel = (payload.model || '').trim();
  if (!incomingModel) {
    throw new Error('Missing "model" field in request body');
  }
  const incomingLower = incomingModel.toLowerCase();

  if (ctx.allowAliases && isAliasPack) {
    const aliasEntry = Object.entries(mapping).find(
      ([code, target]) =>
        target.equivalentClaudeName?.toLowerCase() === incomingLower ||
        code.toLowerCase() === incomingLower
    );
    if (aliasEntry) {
      const target = aliasEntry[1];
      console.log(`[Proxy] Matched alias "${incomingModel}" -> ${target.provider}:${target.model}`);
      return applyProviderOverride(target, ctx.queryProvider);
    }
  }

  if (ctx.allowAliases) {
    const codeEntry = Object.entries(mapping).find(([code]) => code.toLowerCase() === incomingLower);
    if (codeEntry) {
      const target = codeEntry[1];
      console.log(`[Proxy] Matched pack code "${incomingModel}" -> ${target.provider}:${target.model}`);
      return applyProviderOverride(target, ctx.queryProvider);
    }
  }

  const transparent = parseTransparentModel(incomingModel);
  if (transparent) {
    console.log(`[Proxy] Transparent model reference "${incomingModel}" -> ${transparent.provider}:${transparent.model}`);
    return applyProviderOverride(transparent, ctx.queryProvider);
  }

  if (ctx.queryProvider) {
    return applyProviderOverride({ provider: ctx.queryProvider, model: incomingModel }, ctx.queryProvider);
  }

  throw new Error(
    `Unable to resolve model "${incomingModel}". Use a transparent "provider/model" reference (e.g. "moonshot/kimi-k2.7-code"), select a pack, or provide ?p=<provider>.`
  );
}

function readQueryAndToolOptions(parsedUrl: URL, req: IncomingMessage) {
  const queryProvider = parsedUrl.searchParams.get('p');
  const queryModelCode = parsedUrl.searchParams.get('m');
  const queryTools = parsedUrl.searchParams.get('tools');
  const queryNoTools = parsedUrl.searchParams.get('notools');

  const rawHeaderTools = req.headers['x-proxy-tools'];
  const headerTools: string | null = (Array.isArray(rawHeaderTools) ? rawHeaderTools[0] : rawHeaderTools) || null;
  const rawHeaderNoTools = req.headers['x-proxy-no-tools'];
  const headerNoTools: string | null = (Array.isArray(rawHeaderNoTools) ? rawHeaderNoTools[0] : rawHeaderNoTools) || null;
  const rawHeaderExcludeTools = req.headers['x-proxy-exclude-tools'];
  const headerExcludeTools: string | null = (Array.isArray(rawHeaderExcludeTools) ? rawHeaderExcludeTools[0] : rawHeaderExcludeTools) || null;

  const rawHeaderAlias = req.headers['x-proxy-model-alias'];
  const headerAlias = (Array.isArray(rawHeaderAlias) ? rawHeaderAlias[0] : rawHeaderAlias)?.toLowerCase().trim();
  const envAlias = process.env.PROXY_MODEL_ALIAS?.toLowerCase().trim();
  const forcedAliasCode = headerAlias || envAlias || null;

  // Anthropic-style format toggle — relabels the active pack's routes with
  // opaque `claude-<family>-<sha>` ids (see toAnthropicStyle). Header
  // `X-Proxy-Format: anthropic` or `?format=anthropic`.
  const rawHeaderFormat = req.headers['x-proxy-format'];
  const headerFormat = (Array.isArray(rawHeaderFormat) ? rawHeaderFormat[0] : rawHeaderFormat)?.toLowerCase().trim();
  const queryFormat = parsedUrl.searchParams.get('format')?.toLowerCase().trim();
  const anthropicFormat = headerFormat === 'anthropic' || queryFormat === 'anthropic';

  return {
    queryProvider,
    queryModelCode,
    queryTools,
    queryNoTools,
    headerTools,
    headerNoTools,
    headerExcludeTools,
    forcedAliasCode,
    anthropicFormat,
  };
}

function getApiKey(provider: string): string {
  return getResolvedKeys()[provider as keyof ProviderKeys] || '';
}

// ── Named-auth-profile credential resolution ──────────────────────────────
// An upstream can be authenticated from a NAMED auth-profile
// (`@agentproto/auth`) instead of only per-provider env vars. Map a provider
// to a profile id via `LLM_ENDPOINT_PROFILE_<PROVIDER_UPPER>`
// (e.g. LLM_ENDPOINT_PROFILE_ANTHROPIC=claude-subs-agentik). Absent → the
// existing env-key path is used, byte-identical to before.

// Anthropic OAuth wire constants — re-declared locally as string literals
// (mirrors remaining-quota.ts:179-181) so this package never imports
// @agentproto/runtime.
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';

type UpstreamAuthMethod = 'api-key' | 'oauth-bearer';

/** A resolved upstream credential: the secret plus the header shape to use. */
export interface UpstreamCredential {
  value: string;
  method: UpstreamAuthMethod;
}

function upstreamProfileEnvVar(provider: string): string {
  return `LLM_ENDPOINT_PROFILE_${provider.toUpperCase()}`;
}

// Log-once dedupe so a persistent misconfig (e.g. non-darwin keychain) doesn't
// spam a warning on every single request.
const _warnedUpstream = new Set<string>();
function warnUpstreamOnce(key: string, message: string): void {
  if (_warnedUpstream.has(key)) return;
  _warnedUpstream.add(key);
  console.warn(message);
}

/**
 * Resolve the outbound credential for `provider`. Mirrors getApiKey()'s
 * provider-string contract but returns the credential AND the header method.
 *
 * - `LLM_ENDPOINT_PROFILE_<P>` set → resolve the named profile:
 *     • missing / disabled          → undefined (caller 401s, as today)
 *     • source-backed (no credRef)  → undefined + a clear follow-up log
 *                                      (self-refresh not supported here yet)
 *     • credentialRef-backed        → { value, method: profile.method }
 *     • keychain read returns null (credential absent / present-but-unreadable
 *       on a supported host, e.g. a locked Keychain) → undefined (fail-closed;
 *       caller 401s — we do NOT silently downgrade a mapped profile to the env
 *       key)
 *     • keychain read throws (platform-unsupported backend, e.g. non-darwin
 *       host) → env-key fallback + a one-time log; never crashes the request
 * - no mapping → env-key path UNCHANGED (method "api-key").
 */
export async function resolveUpstreamCredential(
  provider: string,
): Promise<UpstreamCredential | undefined> {
  const profileId = process.env[upstreamProfileEnvVar(provider)]?.trim();
  if (profileId) {
    const profile = await getAuthProfile(profileId);
    if (!profile || profile.disabled) {
      warnUpstreamOnce(
        `profile:${provider}:${profileId}`,
        `[Proxy][auth] profile "${profileId}" mapped for provider "${provider}" is ${profile ? 'disabled' : 'missing'}; request will 401. Enable/create it or unset ${upstreamProfileEnvVar(provider)}.`,
      );
      return undefined;
    }
    if (!profile.credentialRef) {
      // Source-backed profile (e.g. source:"claude-code-oauth"). Self-refresh
      // would require re-homing a runtime helper — out of scope for the proxy.
      warnUpstreamOnce(
        `source:${provider}:${profileId}`,
        `[Proxy][auth] profile "${profileId}" is source-backed (source="${profile.source ?? '?'}"); source-backed profiles are not yet supported by the proxy — use a credentialRef profile or a per-provider API-key env var instead. Request will 401.`,
      );
      return undefined;
    }
    try {
      const stored = await new KeychainStore().read({ path: profile.credentialRef });
      if (!stored) {
        // Read succeeded but the credential is absent / unreadable (e.g. a
        // locked or emptied Keychain entry on a supported host). Fail closed —
        // do NOT fall back to the env key, which could silently swap in a
        // different credential for a deliberately-mapped profile.
        warnUpstreamOnce(
          `noref:${provider}:${profileId}`,
          `[Proxy][auth] profile "${profileId}" credentialRef resolved no stored credential; failing closed — request will 401 (no env-key fallback for a mapped profile).`,
        );
        return undefined;
      }
      return { value: stored.value, method: profile.method };
    } catch (err) {
      // Keychain backend unusable on this host (platform-unsupported, e.g. a
      // non-darwin host with no Keychain) → fall back to the env key rather than
      // failing the request. This is the ONLY keychain path that degrades to the
      // env key; a null read above fails closed instead.
      warnUpstreamOnce(
        `keychain:${provider}:${profileId}`,
        `[Proxy][auth] keychain backend unavailable for profile "${profileId}" (${(err as Error).message}); platform-unsupported — falling back to the ${provider} env key.`,
      );
      // fall through to the env-key path below
    }
  }
  // No mapping (or keychain fallback): existing env-key path, unchanged.
  return { value: getApiKey(provider), method: 'api-key' };
}

/**
 * Single source of truth for the outbound upstream-auth header shape. Given a
 * resolved credential, returns the auth-related headers to merge into the
 * request. For an `api-key` credential each provider keeps its existing header
 * exactly; for `oauth-bearer` (only meaningful on the anthropic upstream) it
 * emits the Bearer + anthropic-version + anthropic-beta triple.
 *
 * Fail-closed: an `oauth-bearer` credential (e.g. a Claude subscription OAT)
 * resolved for a NON-anthropic provider returns `null` — the token is never
 * emitted to a third-party upstream. Callers MUST treat `null` as a hard 401
 * and send no request.
 */
export function buildUpstreamAuthHeaders(
  provider: string,
  cred: UpstreamCredential,
): Record<string, string> | null {
  const { value, method } = cred;

  if (method === 'oauth-bearer') {
    if (provider !== 'anthropic') {
      // oauth-bearer is only meaningful for the anthropic upstream. Sending a
      // Claude subscription OAT to any other host would leak the token to a
      // third party — reject rather than forward it.
      warnUpstreamOnce(
        `oauth-misconfig:${provider}`,
        `[Proxy][auth] oauth-bearer credential resolved for non-anthropic provider "${provider}"; refusing to forward it (subscription/oauth credentials are only valid for the anthropic upstream). Request will 401.`,
      );
      return null;
    }
    return {
      'Authorization': `Bearer ${value}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_OAUTH_BETA,
    };
  }

  // api-key — preserve each provider's existing header shape verbatim.
  switch (provider) {
    case 'anthropic':
      return { 'x-api-key': value, 'anthropic-version': ANTHROPIC_VERSION };
    case 'moonshot':
      return { 'X-API-Key': value };
    // openrouter/requesty also set `anthropic-version` at their call sites
    // (left inline — it is a request-shape header, not an auth header).
    default:
      return { 'Authorization': `Bearer ${value}` };
  }
}

/**
 * Fail-closed guard for the OpenAI-compatible surfaces (/v1/responses,
 * /v1/chat/completions). Those surfaces are ALWAYS non-anthropic
 * (getChatCompletionsEndpoint returns null for anthropic) and forward the
 * resolved credential as `Authorization: Bearer <value>` — so only an
 * `api-key` credential may be used. A subscription/oauth credential (e.g. a
 * Claude OAT) must be rejected, never leaked to a third-party host.
 *
 * Returns true when the credential may proceed on this surface. An absent
 * credential returns true here (the caller's missing-key check 401s it).
 */
export function isCredentialAllowedOnOpenAiSurface(
  cred: UpstreamCredential | undefined,
): boolean {
  return !cred || cred.method === 'api-key';
}

/**
 * Handles POST /v1/responses (and /v1/{pack}/responses).
 *
 * Validates the Responses API request, translates it to an OpenAI Chat
 * Completions request, forwards it to the provider's OpenAI-compatible
 * endpoint, and converts the upstream response back to the Responses API
 * format (JSON or SSE).
 */
function handleResponsesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    activePack: ModelPack;
    queryModelCode: string | null;
    queryProvider: string | null;
    queryTools: string | null;
    queryNoTools: string | null;
    headerTools: string | null;
    headerNoTools: string | null;
    headerExcludeTools: string | null;
    forcedAliasCode: string | null;
  }
): void {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const validated = validateResponsesRequest(payload);

      let resolvedTarget: { provider: string; model: string };
      try {
        resolvedTarget = resolveModelRoute(validated, {
          activePack: opts.activePack,
          queryModelCode: null, // Responses facade uses transparent routing only
          queryProvider: opts.queryProvider,
          forcedAliasCode: null,
          allowAliases: false,
        });
      } catch (e: any) {
        console.warn(`[Proxy][responses] ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: e.message } }));
        return;
      }

      const chatPayload = responsesToChatCompletionsRequest(validated, resolvedTarget);

      trimTools(chatPayload, {
        provider: resolvedTarget.provider,
        queryTools: opts.queryTools,
        queryNoTools: opts.queryNoTools,
        headerTools: opts.headerTools,
        headerNoTools: opts.headerNoTools,
        headerExcludeTools: opts.headerExcludeTools,
      });

      const endpoint = getChatCompletionsEndpoint(resolvedTarget.provider);
      if (!endpoint) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Provider "${resolvedTarget.provider}" does not support the OpenAI-compatible /v1/responses surface.` } }));
        return;
      }
      const { hostname, path } = endpoint;
      const cred = await resolveUpstreamCredential(resolvedTarget.provider);
      const targetApiKey = cred?.value ?? '';
      // Fail closed: this OpenAI-compatible surface is ALWAYS non-anthropic
      // (getChatCompletionsEndpoint returns null for anthropic). A non-api-key
      // credential (e.g. a Claude subscription OAT) must never be forwarded as a
      // Bearer token to a third-party host — reject before sending the request.
      if (!isCredentialAllowedOnOpenAiSurface(cred)) {
        console.warn(`[Proxy][responses] refusing to forward a ${cred!.method} credential to non-anthropic provider "${resolvedTarget.provider}"; returning 401.`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error', message: `Subscription/oauth credentials cannot be used on this OpenAI-compatible surface for provider "${resolvedTarget.provider}".` } }));
        return;
      }
      if (!targetApiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error', message: `No API key for provider "${resolvedTarget.provider}"` } }));
        return;
      }

      console.log(`[Proxy Sortant][responses] Redirection vers ${resolvedTarget.provider} (${hostname}${path}) avec le modèle "${chatPayload.model}"`);

      // OpenAI-compatible surface — always Authorization: Bearer (never a
      // provider's Anthropic-surface header). buildUpstreamAuthHeaders is
      // keyed on provider, not surface, so it is NOT used here; only the
      // resolved credential value is (credentialRef-backed profiles included).
      const options: RequestOptions = {
        hostname,
        port: 443,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${targetApiKey}`,
        },
      };

      const proxyReq = request(options, (proxyRes) => {
        const status = proxyRes.statusCode || 200;
        const contentType = proxyRes.headers['content-type'] as string || '';
        const isStreaming = validated.stream === true && /text\/event-stream/i.test(contentType);

        if (isStreaming) {
          const respHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
          delete respHeaders['content-length'];
          delete respHeaders['transfer-encoding'];
          respHeaders['content-type'] = 'text/event-stream';
          res.writeHead(status, respHeaders);
          const converter = new OpenAIChatToResponsesStreamConverter({ requestedModel: validated.model });
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (c: string) => {
            for (const out of converter.push(c)) res.write(out);
          });
          proxyRes.on('end', () => {
            for (const out of converter.flush()) res.write(out);
            res.end();
          });
        } else {
          const respHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
          delete respHeaders['content-length'];
          delete respHeaders['transfer-encoding'];
          respHeaders['content-type'] = 'application/json';
          res.writeHead(status, respHeaders);
          let upstreamBody = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (c: string) => { upstreamBody += c; });
          proxyRes.on('end', () => {
            res.end(chatCompletionsJsonToResponses(upstreamBody || '{}', { requestedModel: validated.model }));
          });
        }
      });

      proxyReq.on('error', (err) => {
        console.error('[Proxy SORTANT error]', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
      });

      proxyReq.write(JSON.stringify(chatPayload));
      proxyReq.end();

    } catch (e: any) {
      console.error('[Payload Error]', e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: e.message } }));
    }
  });
}

/**
 * Handles POST /v1/chat/completions (and /v1/{pack}/chat/completions).
 *
 * This is the normal OpenAI-compatible surface. It does not perform Anthropic
 * schema adaptation; it resolves a transparent `provider/model` reference and
 * forwards the request to the matching provider chat/completions endpoint.
 */
function handleChatCompletionsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    activePack: ModelPack;
    queryProvider: string | null;
    queryTools: string | null;
    queryNoTools: string | null;
    headerTools: string | null;
    headerNoTools: string | null;
    headerExcludeTools: string | null;
  }
): void {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);

      let resolvedTarget: { provider: string; model: string };
      try {
        resolvedTarget = resolveModelRoute(payload, {
          activePack: opts.activePack,
          queryModelCode: null,
          queryProvider: opts.queryProvider,
          forcedAliasCode: null,
          allowAliases: false,
        });
      } catch (e: any) {
        console.warn(`[Proxy][chat/completions] ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: e.message } }));
        return;
      }

      payload.model = resolvedTarget.model;

      trimTools(payload, {
        provider: resolvedTarget.provider,
        queryTools: opts.queryTools,
        queryNoTools: opts.queryNoTools,
        headerTools: opts.headerTools,
        headerNoTools: opts.headerNoTools,
        headerExcludeTools: opts.headerExcludeTools,
      });

      const endpoint = getChatCompletionsEndpoint(resolvedTarget.provider);
      if (!endpoint) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Provider "${resolvedTarget.provider}" does not support the OpenAI-compatible /v1/chat/completions surface.` } }));
        return;
      }
      const { hostname, path } = endpoint;
      const cred = await resolveUpstreamCredential(resolvedTarget.provider);
      const targetApiKey = cred?.value ?? '';
      // Fail closed: this OpenAI-compatible surface is ALWAYS non-anthropic
      // (getChatCompletionsEndpoint returns null for anthropic). A non-api-key
      // credential (e.g. a Claude subscription OAT) must never be forwarded as a
      // Bearer token to a third-party host — reject before sending the request.
      if (!isCredentialAllowedOnOpenAiSurface(cred)) {
        console.warn(`[Proxy][chat/completions] refusing to forward a ${cred!.method} credential to non-anthropic provider "${resolvedTarget.provider}"; returning 401.`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error', message: `Subscription/oauth credentials cannot be used on this OpenAI-compatible surface for provider "${resolvedTarget.provider}".` } }));
        return;
      }
      if (!targetApiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error', message: `No API key for provider "${resolvedTarget.provider}"` } }));
        return;
      }

      console.log(`[Proxy Sortant][chat/completions] Redirection vers ${resolvedTarget.provider} (${hostname}${path}) avec le modèle "${payload.model}"`);

      // OpenAI-compatible surface — always Authorization: Bearer (see the
      // /v1/responses handler above for why buildUpstreamAuthHeaders, which is
      // keyed on provider not surface, is deliberately not used here).
      const options: RequestOptions = {
        hostname,
        port: 443,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${targetApiKey}`,
        },
      };

      const proxyReq = request(options, (proxyRes) => {
        const status = proxyRes.statusCode || 200;
        const respHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
        delete respHeaders['content-length'];
        delete respHeaders['transfer-encoding'];
        res.writeHead(status, respHeaders);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error('[Proxy SORTANT error]', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
      });

      proxyReq.write(JSON.stringify(payload));
      proxyReq.end();

    } catch (e: any) {
      console.error('[Payload Error]', e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: e.message } }));
    }
  });
}

// Adapte un payload Anthropic Messages vers le schéma OpenAI Chat Completions
// (Groq / OpenRouter / ZAI / xAI / OpenAI). Moonshot expose un endpoint /anthropic
// natif et n'a PAS besoin de cette adaptation. Renvoie les champs problématiques
// supprimés et les champs sémantiquement équivalents convertis (system,
// tool_choice, stop).
function adaptAnthropicToOpenAI(payload: any) {
  // 1. system (string | content blocks) -> message role:system en tête de messages
  if (payload.system != null) {
    let sysText = '';
    if (typeof payload.system === 'string') {
      sysText = payload.system;
    } else if (Array.isArray(payload.system)) {
      sysText = payload.system
        .map((b: any) => (typeof b === 'string' ? b : b?.text ?? ''))
        .filter(Boolean)
        .join('\n\n');
    }
    if (sysText) {
      if (!Array.isArray(payload.messages)) payload.messages = [];
      // Évite le double si un message system existe déjà en tête.
      if (!payload.messages[0] || payload.messages[0].role !== 'system') {
        payload.messages.unshift({ role: 'system', content: sysText });
      }
    }
    delete payload.system;
  }

  // 2. tool_choice : {type:auto|any|tool|none, name?} -> schéma OpenAI.
  //    Groq n'accepte QUE "auto"/"none"/function — pas "required" — donc on
  //    mappe any -> "auto" (perte sémantique mineure, mais accepté partout).
  if (payload.tool_choice && typeof payload.tool_choice === 'object') {
    const tc = payload.tool_choice;
    if (tc.type === 'any') {
      payload.tool_choice = 'auto';
    } else if (tc.type === 'tool' && tc.name) {
      payload.tool_choice = { type: 'function', function: { name: tc.name } };
    }
    // 'auto' et 'none' passent tels quels côté OpenAI.
  }

  // 3. stop_sequences -> stop
  if (Array.isArray(payload.stop_sequences) && payload.stop_sequences.length) {
    payload.stop = payload.stop_sequences;
  }

  // 3b. Conversion des blocs de contenu Anthropic -> format OpenAI.
  //     Anthropic: content: [{type:"text"}, {type:"tool_use",id,name,input},
  //                         {type:"tool_result",tool_use_id,content}, {type:"thinking"}]
  //     OpenAI:    content "string" | null + tool_calls[] ;
  //                tool_result -> messages role:"tool" séparés.
  //     SANS cette conversion, Groq/ZAI renvoient 400 :
  //       - assistant content[0].type != "text" (tool_use non converti en tool_calls)
  //       - "Failed to call a function" (historique tool_use illisible par le modèle)
  //
  //     Cas particulier « orphaned tool call » : si le tools array a été
  //     tronqué (ex. Groq limité à 128), l'historique peut contenir des
  //     tool_use pour des outils non déclarés. Groq valide strictement et
  //     rejette (« attempted to call tool 'X' which was not in request.tools »).
  //     -> on convertit ces tool_use orphelins (et leur tool_result) en texte.
  if (Array.isArray(payload.messages)) {
    const declaredTools = new Set<string>(
      Array.isArray(payload.tools) ? payload.tools.map((t: any) => t?.name).filter(Boolean) : []
    );
    const orphanedToolUseIds = new Set<string>();
    if (process.env.PROXY_DEBUG) {
      console.error(`[adapt] declaredTools=${declaredTools.size} names=${JSON.stringify([...declaredTools].slice(0, 20))}`);
    }

    const newMessages: any[] = [];
    for (const msg of payload.messages) {
      if (msg.content == null || typeof msg.content === 'string') {
        newMessages.push(msg);
        continue;
      }
      if (!Array.isArray(msg.content)) {
        newMessages.push(msg);
        continue;
      }
      const blocks = msg.content;

      // Cas 1 : message user contenant des tool_result -> messages role:"tool" OpenAI
      //         (ou texte si le tool_use correspondant est orphelin)
      if (msg.role === 'user' && blocks.some((b: any) => b && b.type === 'tool_result')) {
        const userTextParts: string[] = [];
        for (const b of blocks) {
          if (!b) continue;
          if (b.type === 'tool_result') {
            let trContent = '';
            if (typeof b.content === 'string') trContent = b.content;
            else if (Array.isArray(b.content)) {
              trContent = b.content.map((c: any) => typeof c === 'string' ? c : (c?.text ?? '')).join('\n');
            }
            if (orphanedToolUseIds.has(b.tool_use_id)) {
              // tool_use orphelin : on garde le résultat comme contexte texte user
              if (trContent) userTextParts.push(`[Tool result: ${trContent}]`);
            } else {
              newMessages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: trContent || '' });
            }
          } else if (b.type === 'text' && b.text) {
            userTextParts.push(b.text);
          }
        }
        if (userTextParts.length) {
          newMessages.push({ role: 'user', content: userTextParts.join('\n') });
        }
        continue;
      }

      // Cas 2 : assistant/user avec blocs text + tool_use (thinking ignoré)
      const textParts: string[] = [];
      const toolCalls: any[] = [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'text' && b.text) {
          textParts.push(b.text);
        } else if (b.type === 'tool_use') {
          // Orphelin si l'outil n'est PAS déclaré, OU si aucun outil n'est déclaré
          // (ex. turn "lean" sans tools, ?notools=1, follow-up sans tools array).
          // Si on ne convertit pas, Groq rejette : « tool X not in request.tools »
          // car les tool_use passent en tool_calls OpenAI contre un tools array vide.
          const isOrphan = !declaredTools.has(b.name);
          if (process.env.PROXY_DEBUG) {
            console.error(`[adapt] tool_use name=${b.name} isOrphan=${isOrphan} declaredHas=${declaredTools.has(b.name)} declaredSize=${declaredTools.size}`);
          }
          if (isOrphan) {
            // Outil non déclaré (tools tronqué) : convertir en note texte
            const argStr = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {});
            textParts.push(`[Used tool ${b.name} with args ${argStr}]`);
            if (b.id) orphanedToolUseIds.add(b.id);
          } else {
            toolCalls.push({
              id: b.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              type: 'function',
              function: {
                name: b.name,
                arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {})
              }
            });
          }
        }
        // thinking / redacted_thinking : ignorés (raisonnement interne, pas envoyé à OpenAI)
      }
      const newMsg: any = { role: msg.role };
      newMsg.content = textParts.length ? textParts.join('\n') : (toolCalls.length ? null : '');
      if (toolCalls.length) newMsg.tool_calls = toolCalls;
      if (msg.name) newMsg.name = msg.name;
      newMessages.push(newMsg);
    }
    payload.messages = newMessages;
  }

  // 4. Champs spécifiques Anthropic non reconnus par OpenAI -> suppression.
  //    (Le CLI `claude` 2.x peut envoyer output_config, context_management, etc.
  //    que Groq/ZAI/OpenRouter rejettent en 400 "unsupported".)
  delete payload.thinking;
  delete payload.context_management;
  delete payload.top_k;
  delete payload.metadata;
  delete payload.betas;
  delete payload.anthropic_beta;
  delete payload.stop_sequences;
  delete payload.cache_control;
  delete payload.output_config;
  delete payload.service_tier;
  delete payload.mcp_servers;
}

// --- OpenRouter : strip des blocs thinking/redacted_thinking ---
// Le CLI `claude` (Claude Code) VÉRIFIE la signature des blocs thinking pour les
// modèles courants (claude-sonnet-5, opus-4-8, fable-5, haiku-4-5). OpenRouter
// renvoie ces blocs avec signature:"" (invalide) → le CLI laisse tomber TOUT le
// contenu et n'affiche rien. On retire donc thinking/redacted_thinking côté proxy
// pour ne garder que les blocs text/tool_use que le CLI sait afficher.

function stripThinkingFromAnthropicJson(jsonStr: string): string {
  try {
    const obj = JSON.parse(jsonStr);
    if (Array.isArray(obj.content)) {
      obj.content = obj.content.filter(
        (b: any) => b && b.type !== 'thinking' && b.type !== 'redacted_thinking'
      );
    }
    return JSON.stringify(obj);
  } catch {
    return jsonStr;
  }
}

// --- Empty-turn retry ---------------------------------------------------
// Certains modèles "reasoning" servis derrière un routeur (vérifié : Requesty
// sur sference/thinkingcap-qwen3.6-27b, ~12% des tours) raisonnent puis
// n'émettent RIEN : que des blocs thinking, aucun text, aucun tool_use, et
// stop_reason "end_turn". Le tour est un no-op silencieux — et comme on strip
// justement les blocs thinking, le client reçoit un message vide.
//
// Le tour vide est un défaut MODÈLE, pas un défaut de traduction : mesuré
// identique (12%) sur les deux surfaces de Requesty (Anthropic et OpenAI).
// On rejoue donc une fois, ce qui ramène ~12% à ~1.4%.
//
// Portée volontairement étroite :
//   - seulement les providers `needsStrip` (ceux qui présentent le défaut) ;
//   - seulement sur HTTP 200 — une 429/500 n'est pas un tour vide ;
//   - seulement sur stop_reason "end_turn" — un "max_tokens" signifie que le
//     modèle a brûlé son budget dans le thinking, et rejouer à budget
//     identique reproduirait le même résultat en facturant deux fois ;
//   - 1 essai par défaut (`LLM_ENDPOINT_EMPTY_TURN_RETRY=0` désactive).
// Chaque rejeu est loggé : un retry silencieux masquerait un vrai tour vide,
// que @agentproto/runtime remonte justement comme `empty: true`.
const DEFAULT_EMPTY_TURN_RETRIES = 1;

function resolveEmptyTurnRetries(): number {
  const raw = process.env.LLM_ENDPOINT_EMPTY_TURN_RETRY;
  if (raw === undefined) return DEFAULT_EMPTY_TURN_RETRIES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EMPTY_TURN_RETRIES;
}

/**
 * True when an Anthropic Messages JSON body is a "tour vide": ended normally
 * (`end_turn`) but carries no client-visible content once thinking is stripped.
 */
function isEmptyAnthropicTurn(jsonStr: string): boolean {
  try {
    const obj = JSON.parse(jsonStr);
    if (!obj || obj.type === 'error' || !Array.isArray(obj.content)) return false;
    if (obj.stop_reason !== 'end_turn') return false;
    return !obj.content.some(
      (b: any) => b && b.type !== 'thinking' && b.type !== 'redacted_thinking'
    );
  } catch {
    return false;
  }
}

// Transformeur SSE en flux : filtre les content_block_start/delta/stop des blocs
// thinking/redacted_thinking et réindexe les blocs conservés (0,1,2…) pour que le
// CLI voie des indices contigus. Garde message_start/message_delta/message_stop/ping.
class AnthropicThinkingStripper {
  private skipIndices = new Set<number>();
  private indexMap = new Map<number, number>();
  private nextOut = 0;
  private buffer = '';
  /**
   * True once a NON-thinking content block has started — i.e. the turn is
   * producing something the client will actually see (text or tool_use).
   * Read by the empty-turn retry: a turn that ends without this produced
   * nothing but stripped thinking, so nothing has been written downstream yet
   * and the attempt is still safely discardable.
   */
  hasMeaningfulContent = false;
  /** stop_reason seen on message_delta, if any. */
  stopReason: string | null = null;

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    const parts = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = parts.pop() ?? '';
    for (const part of parts) {
      const transformed = this.transformEvent(part);
      if (transformed) out.push(transformed);
    }
    return out;
  }

  flush(): string[] {
    if (this.buffer.trim()) {
      const transformed = this.transformEvent(this.buffer);
      this.buffer = '';
      return transformed ? [transformed] : [];
    }
    return [];
  }

  private transformEvent(rawEvent: string): string | null {
    const lines = rawEvent.split(/\r?\n/);
    let eventLine: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventLine = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return rawEvent ? rawEvent + '\n\n' : null;

    let data: any;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return rawEvent + '\n\n';
    }

    const type = data.type;
    if (type === 'content_block_start') {
      const ct = data.content_block && data.content_block.type;
      if (ct === 'thinking' || ct === 'redacted_thinking') {
        this.skipIndices.add(data.index);
        return null;
      }
      const outIdx = this.nextOut++;
      this.indexMap.set(data.index, outIdx);
      data.index = outIdx;
      this.hasMeaningfulContent = true;
    } else if (type === 'message_delta') {
      const sr = data.delta && data.delta.stop_reason;
      if (typeof sr === 'string') this.stopReason = sr;
    } else if (type === 'content_block_delta') {
      if (this.skipIndices.has(data.index)) return null;
      const dt = data.delta && data.delta.type;
      if (dt === 'thinking_delta' || dt === 'signature_delta' || dt === 'redacted_thinking_delta') return null;
      data.index = this.indexMap.get(data.index) ?? data.index;
    } else if (type === 'content_block_stop') {
      if (this.skipIndices.has(data.index)) return null;
      data.index = this.indexMap.get(data.index) ?? data.index;
    }

    const ev = eventLine ? `event: ${eventLine}\n` : '';
    return ev + `data: ${JSON.stringify(data)}\n\n`;
  }
}

// --- Groq/ZAI/xAI/OpenAI : conversion OpenAI → Anthropic ---
// Ces providers ne parlent que l'API OpenAI (chat/completions). Le CLI `claude`
// ne parse QUE le format Anthropic. On convertit donc la réponse OpenAI (JSON
// ou SSE) en Anthropic côté proxy.

function openaiFinishToAnthropicStop(fr: string | null | undefined): string {
  switch (fr) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

function openaiJsonToAnthropic(jsonStr: string): string {
  try {
    const o = JSON.parse(jsonStr);
    // Pass-through des erreurs upstream (OpenAI/ZAI renvoient {"error":{...}})
    // sous forme d'erreur Anthropic, au lieu d'un message vide trompeur.
    if (o && typeof o === 'object' && o.error) {
      const e = o.error;
      return JSON.stringify({
        type: 'error',
        error: {
          type: e.type || 'api_error',
          message: e.message || (typeof e === 'string' ? e : 'Upstream error')
        }
      });
    }
    const choice = o.choices && o.choices[0];
    const msg = choice && choice.message;
    const content: any[] = [];
    if (msg && typeof msg.content === 'string' && msg.content) {
      content.push({ type: 'text', text: msg.content });
    }
    if (msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let input: any = {};
        try { input = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = {}; }
        content.push({
          type: 'tool_use',
          id: tc.id || `toolu_${Date.now()}`,
          name: tc.function && tc.function.name,
          input
        });
      }
    }
    const usage = o.usage || {};
    const out = {
      id: o.id || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: o.model || 'groq',
      content,
      stop_reason: openaiFinishToAnthropicStop(choice && choice.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0
      }
    };
    return JSON.stringify(out);
  } catch {
    return jsonStr;
  }
}

// Convertit un flux SSE OpenAI (chat.completion.chunk) en flux SSE Anthropic.
// Séquence Anthropic émise :
//   message_start → content_block_start(text) → content_block_delta(text_delta)*
//   → content_block_stop → (tool_use blocks si tool_calls) → message_delta(stop) → message_stop
class OpenAIToAnthropicStreamConverter {
  private msgId = `msg_${Date.now()}`;
  private sentStart = false;
  private textBlockOpen = false;
  private toolBlockIdx = -1;
  private buffer = '';
  private accUsage: { prompt_tokens?: number; completion_tokens?: number } = {};
  private finished = false;

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    const parts = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = parts.pop() ?? '';
    for (const part of parts) {
      const transformed = this.transformChunk(part);
      if (transformed) out.push(...transformed);
    }
    return out;
  }

  flush(): string[] {
    if (this.buffer.trim()) {
      const transformed = this.transformChunk(this.buffer);
      this.buffer = '';
      return transformed || [];
    }
    return [];
  }

  private sse(event: string, data: any): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private transformChunk(rawEvent: string): string[] | null {
    const lines = rawEvent.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return null;

    const out: string[] = [];
    for (const dl of dataLines) {
      if (dl === '[DONE]') {
        if (this.finished) continue;
        if (this.textBlockOpen) { out.push(this.sse('content_block_stop', { type: 'content_block_stop', index: 0 })); this.textBlockOpen = false; }
        out.push(this.sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: this.accUsage.prompt_tokens || 0, output_tokens: this.accUsage.completion_tokens || 0 } }));
        out.push(this.sse('message_stop', { type: 'message_stop' }));
        this.finished = true;
        continue;
      }
      let data: any;
      try { data = JSON.parse(dl); } catch { continue; }

      const choice = data.choices && data.choices[0];
      const delta = choice && choice.delta;
      const content = delta && delta.content;

      // message_start au premier chunk utile
      if (!this.sentStart && (content !== undefined || (delta && delta.role))) {
        out.push(this.sse('message_start', {
          type: 'message_start',
          message: {
            id: this.msgId, type: 'message', role: 'assistant',
            model: data.model || 'groq', content: [],
            stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        }));
        this.sentStart = true;
      }

      // Contenu texte
      if (typeof content === 'string' && content) {
        if (!this.textBlockOpen) {
          out.push(this.sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
          this.textBlockOpen = true;
        }
        out.push(this.sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } }));
      }

      // tool_calls (streaming) — ouverture d'un bloc tool_use par appel
      if (delta && Array.isArray(delta.tool_calls)) {
        if (this.textBlockOpen) { out.push(this.sse('content_block_stop', { type: 'content_block_stop', index: 0 })); this.textBlockOpen = false; }
        for (const tc of delta.tool_calls) {
          if (tc.function && tc.function.name && tc.index !== undefined) {
            this.toolBlockIdx = tc.index + 1;
            out.push(this.sse('content_block_start', {
              type: 'content_block_start', index: this.toolBlockIdx,
              content_block: { type: 'tool_use', id: tc.id || `toolu_${Date.now()}`, name: tc.function.name, input: {} }
            }));
          }
          if (tc.function && tc.function.arguments) {
            out.push(this.sse('content_block_delta', {
              type: 'content_block_delta', index: this.toolBlockIdx,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
            }));
          }
        }
      }

      // usage (x_groq ou usage direct)
      const u = data.x_groq && data.x_groq.usage ? data.x_groq.usage : data.usage;
      if (u) { if (u.prompt_tokens != null) this.accUsage.prompt_tokens = u.prompt_tokens; if (u.completion_tokens != null) this.accUsage.completion_tokens = u.completion_tokens; }

      // finish_reason → fermeture
      const fr = choice && choice.finish_reason;
      if (fr && !this.finished) {
        if (this.textBlockOpen) { out.push(this.sse('content_block_stop', { type: 'content_block_stop', index: 0 })); this.textBlockOpen = false; }
        if (this.toolBlockIdx >= 0) { out.push(this.sse('content_block_stop', { type: 'content_block_stop', index: this.toolBlockIdx })); this.toolBlockIdx = -1; }
        out.push(this.sse('message_delta', { type: 'message_delta', delta: { stop_reason: openaiFinishToAnthropicStop(fr), stop_sequence: null }, usage: { input_tokens: this.accUsage.prompt_tokens || 0, output_tokens: this.accUsage.completion_tokens || 0 } }));
        out.push(this.sse('message_stop', { type: 'message_stop' }));
        this.finished = true;
      }
    }
    return out.length ? out : null;
  }
}

// ── Inbound access gate ─────────────────────────────────────────────────────
// Optional CLIENT→proxy authentication, independent of the upstream provider
// keys (proxy→provider), which are always server-side and never the client's.
// Enabled by setting LLM_ENDPOINT_ACCESS_TOKENS to a comma-separated allow-list;
// unset/empty leaves the proxy open (prior behaviour). Read once at boot like
// the provider keys — changing it requires a restart.

/** Parse a comma-separated token allow-list into a Set (trimmed, non-empty). */
export function parseAccessTokens(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((t) => t.trim()).filter(Boolean));
}

let _accessTokens: Set<string> | null = null;
/** Cached allow-list from LLM_ENDPOINT_ACCESS_TOKENS (empty Set = gate off). */
function accessTokens(): Set<string> {
  if (_accessTokens === null) _accessTokens = parseAccessTokens(process.env.LLM_ENDPOINT_ACCESS_TOKENS);
  return _accessTokens;
}

/**
 * Extract a presented access token from `Authorization: Bearer <t>` or the
 * `X-Proxy-Access: <t>` header (so a client that reserves Authorization for
 * something else can still pass one). Returns null when neither is present.
 */
export function extractInboundToken(headers: IncomingMessage['headers']): string | null {
  const auth = headers['authorization'];
  const a = Array.isArray(auth) ? auth[0] : auth;
  if (a) {
    const m = /^Bearer\s+(.+)$/i.exec(a.trim());
    if (m && m[1]!.trim()) return m[1]!.trim();
  }
  const xp = headers['x-proxy-access'];
  const x = Array.isArray(xp) ? xp[0] : xp;
  if (x && x.trim()) return x.trim();
  return null;
}

/**
 * True when the request may proceed: gate disabled (empty allow-list), or the
 * presented token is in the allow-list. A high-entropy random token makes the
 * Set membership check's non-constant time immaterial.
 */
export function isAuthorized(headers: IncomingMessage['headers'], tokens: Set<string>): boolean {
  if (tokens.size === 0) return true;
  const presented = extractInboundToken(headers);
  return presented !== null && tokens.has(presented);
}

// ── Edge/WAF token gate ─────────────────────────────────────────────────────
// A SECOND, independent client→proxy auth layer meant to be checked by an
// edge/WAF rule (Cloudflare custom rule) in front of the proxy, not just by
// this process — see buildWafRuleExpression below. Deliberately separate from
// the inbound access gate above: the two can be rotated/enabled independently
// (e.g. a WAF-only token in front of a publicly reachable deployment, plus an
// app-level token for direct callers). Unset/empty leaves this layer off.

let _edgeTokens: Set<string> | null = null;
/** Cached allow-list from LLM_ENDPOINT_EDGE_TOKENS (empty Set = layer off). */
function edgeTokens(): Set<string> {
  if (_edgeTokens === null) _edgeTokens = parseAccessTokens(process.env.LLM_ENDPOINT_EDGE_TOKENS);
  return _edgeTokens;
}

/**
 * Extract a presented edge token from the `X-Edge-Auth: <t>` header. Returns
 * null when absent or blank.
 */
export function extractEdgeToken(headers: IncomingMessage['headers']): string | null {
  const raw = headers['x-edge-auth'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v && v.trim()) return v.trim();
  return null;
}

/**
 * True when the request may proceed through the edge/WAF layer: layer
 * disabled (empty allow-list), or the presented `X-Edge-Auth` token is in the
 * allow-list.
 */
export function isEdgeAuthorized(headers: IncomingMessage['headers'], edgeTokensSet: Set<string>): boolean {
  if (edgeTokensSet.size === 0) return true;
  const presented = extractEdgeToken(headers);
  return presented !== null && edgeTokensSet.has(presented);
}

/**
 * Builds a Cloudflare custom-rule (wirefilter) expression that BLOCKS any
 * request lacking a valid token, for the header (`authorization` or
 * `x-edge-auth`) matching the layer being enforced at the edge. Intended to
 * be pasted into a Cloudflare custom rule so the token check happens before
 * traffic ever reaches this process — the `edgeTokens()`/`isEdgeAuthorized`
 * pair above is the same policy enforced in-process as a fallback.
 *
 * CORS preflight (`OPTIONS`) is always allowed through so the browser's
 * preflight — which cannot carry the token — isn't blocked.
 */
export function buildWafRuleExpression(opts: {
  host?: string;
  tokens: string[];
  header: 'authorization' | 'x-edge-auth';
}): string {
  if (opts.tokens.length === 0) {
    throw new Error('buildWafRuleExpression requires at least one token');
  }
  const headerName = opts.header.toLowerCase();
  const values = opts.tokens.map((t) => (opts.header === 'authorization' ? `Bearer ${t}` : t));
  const memberships = values.map((v) => `any(http.request.headers["${headerName}"][*] eq "${v}")`);
  const notValid = memberships.length === 1 ? `not ${memberships[0]}` : `not (${memberships.join(' or ')})`;
  const hostPrefix = opts.host ? `http.host eq "${opts.host}" and ` : '';
  return `(${hostPrefix}http.request.method ne "OPTIONS" and ${notValid})`;
}

/**
 * Normalise an incoming request path so a redundant `/v1` an Anthropic client
 * appends to a base URL that already ends in `/v1` (optionally with a pack
 * segment) doesn't break routing.
 *
 *   /v1/v1/messages                    → /v1/messages
 *   /v1/stealth-requesty/v1/messages   → /v1/stealth-requesty/messages
 *   /v1/stealth-requesty/v1/models     → /v1/stealth-requesty/models
 *
 * Without the pack-segment case the extra `/v1` breaks the `/v1/<pack>/<verb>`
 * match, the pack is silently lost, and the request falls back to the default
 * pack — the "no usable models" / "Unable to resolve model" failure a client
 * configured with `base_url = .../v1/<pack>` hits.
 */
export function normalizeProxyPath(pathname: string): string {
  return pathname
    .replace(/\/+$/, '')
    .replace(/^\/v1\/v1(\/|$)/, '/v1$1')
    .replace(/^(\/v1\/[^/]+)\/v1(\/|$)/, '$1$2');
}

let _publicModels: boolean | null = null;
/** Whether the default model-list path may be read unauthenticated (LLM_ENDPOINT_PUBLIC_MODELS truthy). */
function publicModels(): boolean {
  if (_publicModels === null) {
    const v = (process.env.LLM_ENDPOINT_PUBLIC_MODELS ?? '').trim().toLowerCase();
    _publicModels = v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }
  return _publicModels;
}

/**
 * True only for the DEFAULT model-discovery path — `/v1/models` or `/models`,
 * never a pack-scoped list (`/v1/<pack>/models`). Lets opt-in public discovery
 * expose the default codename list without disclosing pack names.
 */
export function isPublicModelListPath(pathname: string): boolean {
  const p = normalizeProxyPath(pathname);
  return p === '/v1/models' || p === '/models';
}

const server = createServer((req, res) => {
  // CORS & Options
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization, anthropic-version, X-Proxy-Access, X-Proxy-Pack, X-Proxy-Format, X-Edge-Auth');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const rawUrl = req.url || '';
  const parsedUrl = new URL(rawUrl, `http://localhost:${PORT}`);
  // Le binary `claude` ajoute lui-même `/v1/messages` à ANTHROPIC_BASE_URL —
  // si celle-ci se termine déjà par `/v1` (config normale du proxy), la requête
  // arrive en `/v1/v1/messages`. `endsWith('/messages')` la route déjà
  // correctement plus bas, mais laisser le chemin brut dans les logs noie le
  // vrai souci (config base_url mal formée). Normalisé ici une fois pour
  // toutes — un `/v1/v1/...` redevient `/v1/...` pour le matching ET les logs.
  const urlPath = normalizeProxyPath(parsedUrl.pathname);

  // Discovery exemption — the DEFAULT model-list path may be read without a
  // token when LLM_ENDPOINT_PUBLIC_MODELS is set, so OpenAI-compatible clients
  // (e.g. Claude Desktop's launch-time model discovery) can populate their
  // selector. Only `/v1/models` (`/models`) — pack lists stay gated.
  const gateExempt = publicModels() && isPublicModelListPath(urlPath);

  // Inbound access gate — 401 any non-preflight request without a valid token
  // when LLM_ENDPOINT_ACCESS_TOKENS is set. Gates discovery too (unless exempt
  // above), so pack config isn't readable unauthenticated.
  if (!gateExempt && !isAuthorized(req.headers, accessTokens())) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Missing or invalid proxy access token.' } }));
    return;
  }

  // Edge/WAF token gate — independent of the inbound access gate above. Off
  // by default (unset LLM_ENDPOINT_EDGE_TOKENS); see buildWafRuleExpression
  // for enforcing the same policy at the edge instead of in-process.
  if (!gateExempt && !isEdgeAuthorized(req.headers, edgeTokens())) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Missing or invalid edge token.' } }));
    return;
  }

  // ── Pack resolution ──────────────────────────────────────────────────────
  // Priority: header X-Proxy-Pack > URL path /v1/{pack}/messages > query param ?pack= > default
  let packId: string | null = null;

  // 1. Header personnalisé (Claude Desktop "Custom inference headers")
  const proxyPackHeader = req.headers['x-proxy-pack'];
  const proxyPackValue: string | null = (Array.isArray(proxyPackHeader) ? proxyPackHeader[0] : proxyPackHeader) || null;
  if (proxyPackValue) {
    if (getMergedPackIds().includes(proxyPackValue)) {
      packId = proxyPackValue;
    } else {
      console.warn(`[Proxy] Unknown pack "${proxyPackValue}" via X-Proxy-Pack header — returning 400.`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Unknown pack "${proxyPackValue}" via X-Proxy-Pack. Available: ${getMergedPackIds().join(', ')}` } }));
      return;
    }
  }

  // 2. URL path /v1/{pack}/...
  if (!packId) {
    const packPathMatch = urlPath.match(/^\/v1\/([^\/]+)(?:\/messages|\/models|\/chat\/completions|\/responses)?$/);
    if (packPathMatch) {
      const potentialPack = packPathMatch[1];
      const RESERVED_SEGMENTS = new Set(['v1', 'messages', 'models', 'packs', 'chat', 'responses']);
      if (potentialPack && !RESERVED_SEGMENTS.has(potentialPack)) {
        if (getMergedPackIds().includes(potentialPack)) {
          packId = potentialPack;
        } else {
          console.warn(`[Proxy] Unknown pack "${potentialPack}" via URL path — returning 400.`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Unknown pack "${potentialPack}" in URL path. Available: ${getMergedPackIds().join(', ')}` } }));
          return;
        }
      }
    }
  }

  // 3. Query param ?pack=
  if (!packId) {
    const queryPack = parsedUrl.searchParams.get('pack');
    if (queryPack) {
      if (getMergedPackIds().includes(queryPack)) {
        packId = queryPack;
      } else {
        console.warn(`[Proxy] Unknown pack "${queryPack}" — returning 400.`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Unknown pack "${queryPack}". Available: ${getMergedPackIds().join(', ')}` } }));
        return;
      }
    }
  }

  const { queryProvider, queryModelCode, queryTools, queryNoTools, headerTools, headerNoTools, headerExcludeTools, forcedAliasCode, anthropicFormat } =
    readQueryAndToolOptions(parsedUrl, req);

  // Anthropic-style format: relabel the resolved pack's routes with opaque
  // `claude-<family>-<sha>` ids for THIS request only. Every downstream
  // consumer (model listing + message routing) then sees the transformed pack.
  const resolvedPack = resolvePackMerged(packId);
  const activePack = anthropicFormat ? toAnthropicStyle(resolvedPack) : resolvedPack;

  console.log(
    `[Proxy] Incoming request: ${req.method} ${rawUrl}` +
      (urlPath !== parsedUrl.pathname.replace(/\/+$/, '') ? ` (normalized: ${urlPath})` : '') +
      ` [pack: ${activePack.id}]`
  );

  // 0b. OpenAI Responses API facade for Codex custom providers
  if (req.method === 'POST' && urlPath.endsWith('/responses')) {
    handleResponsesRequest(req, res, {
      activePack,
      queryModelCode,
      queryProvider,
      queryTools,
      queryNoTools,
      headerTools,
      headerNoTools,
      headerExcludeTools,
      forcedAliasCode,
    });
    return;
  }

  // 0c. OpenAI chat/completions surface
  if (req.method === 'POST' && urlPath.endsWith('/chat/completions')) {
    handleChatCompletionsRequest(req, res, {
      activePack,
      queryProvider,
      queryTools,
      queryNoTools,
      headerTools,
      headerNoTools,
      headerExcludeTools,
    });
    return;
  }

  // 0. Endpoint /v1/packs pour la découverte des packs disponibles
  if (req.method === 'GET' && (urlPath === '/v1/packs' || urlPath === '/packs')) {
    const mergedRegistry = { ...PACK_REGISTRY, ...getLocalPacks() };
    const packsResponse = {
      object: 'list',
      data: Object.values(mergedRegistry).map((pack: ModelPack) => ({
        id: pack.id,
        label: pack.label,
        description: pack.description,
        model_count: Object.keys(pack.models).length,
        models: Object.entries(pack.models).map(([code, target]) => ({
          code,
          provider: target.provider,
          model: target.model,
          equivalent_claude_name: target.equivalentClaudeName,
        })),
      })),
    };
    console.log(`[Proxy] Returning pack list (${packsResponse.data.length} packs).`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(packsResponse));
    return;
  }

  // 0a. Hot-reload local packs from packs.local.json (POST). Gated by the same
  // access token as every other route (checked above). Re-reads + validates the
  // local envelope; unlike the fail-soft load path, an EXPLICIT reload gets a
  // hard 400 with the field-scoped errors so a bad edit is legible instead of
  // silently ignored. On success the cache is dropped and repopulated, and the
  // reloaded pack ids + count are returned.
  if (req.method === 'POST' && (urlPath === '/v1/packs/reload' || urlPath === '/packs/reload')) {
    const load = readLocalPacksFromDisk();
    if (load.errors.length > 0) {
      // Leave the previously-cached packs in place — a rejected reload must not
      // wipe a working config.
      console.warn(`[Proxy] Pack reload rejected — ${load.errors.length} validation error(s).`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid packs.local.json', errors: load.errors } }));
      return;
    }
    resetLocalPacksCache();
    const localPacks = getLocalPacks(); // repopulate the cache from the now-validated file
    const packIds = getMergedPackIds();
    console.log(`[Proxy] Reloaded packs from ${load.path ?? '(no local file)'} — ${packIds.length} packs (${Object.keys(localPacks).length} local).`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'packs.reload',
      reloaded: true,
      source: load.path,
      local_pack_ids: Object.keys(localPacks),
      pack_ids: packIds,
      count: packIds.length,
    }));
    return;
  }

  // 1. Endpoint /v1/models pour la découverte des modèles
  // Supporte aussi /v1/{pack}/models pour la sélection de pack via URL path
  if (req.method === 'GET' && (urlPath === '/v1/models' || urlPath === '/models' || urlPath.endsWith('/models'))) {
    const isAnthropicStyle = req.headers['anthropic-version'] !== undefined || req.headers['x-api-key'] !== undefined;
    const mapping = buildMappingFromPack(activePack);
    const isLocalPack = Boolean(getLocalPacks()[activePack.id]);
    // Alias-bearing: a local pack, or an official pack transformed to Anthropic
    // style for this request — either exposes equivalentClaudeName as the id.
    const isAliasPack = isLocalPack || anthropicFormat;

    if (isAnthropicStyle) {
      // Format 100% Natif d'Anthropic Claude
      const anthropicModelsResponse = {
        data: Object.entries(mapping).map(([code, target]) => {
          const id = (isAliasPack && target.equivalentClaudeName) ? target.equivalentClaudeName : code;
          return {
            id,
            display_name: code,
            created_at: '2026-02-04T00:00:00Z',
            type: 'model',
            capabilities: {},
          };
        }),
        has_more: false,
        first_id: null,
        last_id: null
      };
      console.log(`[Proxy] Returning native Anthropic-formatted model list.`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(anthropicModelsResponse));
      return;
    } else {
      // Format OpenAI standardisé
      const openaiModelsResponse = {
        object: 'list',
        data: Object.entries(mapping).map(([code, target]) => ({
          id: code,
          object: 'model',
          created: 1718841600,
          owned_by: target.provider,
        }))
      };
      console.log(`[Proxy] Returning standard OpenAI-formatted model list.`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openaiModelsResponse));
      return;
    }
  }

  // 2. Traitement des messages
  if (req.method !== 'POST' || !urlPath.endsWith('/messages')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'not_found', message: `Route not found` } }));
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);

      // Trouver la destination (Provider & Model)
      let resolvedTarget: { provider: string; model: string };
      try {
        resolvedTarget = resolveModelRoute(payload, {
          activePack,
          queryModelCode,
          queryProvider,
          forcedAliasCode,
          allowAliases: true,
          anthropicFormat,
        });
      } catch (e: any) {
        console.warn(`[Proxy] ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: e.message } }));
        return;
      }

      // Configuration de la requête sortante selon le provider résolu
      let hostname = '';
      let path = '';
      let targetApiKey = '';
      let cred: UpstreamCredential | undefined;
      let headers: Record<string, string> = { 'Content-Type': 'application/json' };

      payload.model = resolvedTarget.model;

      // Trimme les outils AVANT la transformation de forme propre à chaque provider
      // (ZAI/Groq mappent input_schema → function.parameters ; le trim doit voir la forme Anthropic).
      trimTools(payload, {
        provider: resolvedTarget.provider,
        queryTools,
        queryNoTools,
        headerTools,
        headerNoTools,
        headerExcludeTools,
      });

      switch (resolvedTarget.provider) {
        case 'anthropic':
          // Anthropic natif — pas de transformation de forme requise.
          hostname = 'api.anthropic.com';
          path = '/v1/messages';
          cred = await resolveUpstreamCredential('anthropic');
          targetApiKey = cred?.value ?? '';
          if (cred) Object.assign(headers, buildUpstreamAuthHeaders('anthropic', cred));
          break;

        case 'openrouter':
          // OpenRouter expose un endpoint Anthropic NATIF (/api/v1/messages) qui renvoie le
          // format Anthropic (content/stop_reason) tel quel — indispensable pour le CLI `claude`
          // qui ne parse PAS le format OpenAI (sinon : "malformed response HTTP 200").
          // Aucune adaptation request/response : tools (input_schema), system, thinking,
          // tool_choice, stop_sequences passent en natif Anthropic côté OpenRouter.
          hostname = 'openrouter.ai';
          path = '/api/v1/messages';
          cred = await resolveUpstreamCredential('openrouter');
          targetApiKey = cred?.value ?? '';
          if (cred) Object.assign(headers, buildUpstreamAuthHeaders('openrouter', cred));
          headers['anthropic-version'] = '2023-06-01';
          break;

        case 'requesty':
          // Requesty expose aussi un endpoint Anthropic NATIF — servi à
          // /v1/messages (et NON /anthropic/v1/messages comme l'annonce leur
          // doc, qui 404). Même traitement qu'OpenRouter : aucune adaptation
          // request/response, tools/system/thinking passent en natif.
          hostname = 'router.requesty.ai';
          path = '/v1/messages';
          cred = await resolveUpstreamCredential('requesty');
          targetApiKey = cred?.value ?? '';
          if (cred) Object.assign(headers, buildUpstreamAuthHeaders('requesty', cred));
          headers['anthropic-version'] = '2023-06-01';
          break;

        case 'zai':
          hostname = 'open.bigmodel.cn';
          path = '/api/paas/v4/chat/completions'; // Zhipu AI standard path
          cred = await resolveUpstreamCredential('zai');
          targetApiKey = cred?.value ?? '';
          if (cred) Object.assign(headers, buildUpstreamAuthHeaders('zai', cred));
          adaptAnthropicToOpenAI(payload);

          // Transformation des tools Anthropic pour ZAI
          if (payload.tools && Array.isArray(payload.tools)) {
            payload.tools = payload.tools.map((t: any) => {
              if (t.input_schema) {
                return {
                  type: 'function',
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema
                  }
                };
              }
              return t;
            });
          }
          break;

        case 'groq':
          hostname = 'api.groq.com';
          path = '/openai/v1/chat/completions'; // Groq utilise l'API OpenAI standard
          cred = await resolveUpstreamCredential('groq');
          targetApiKey = cred?.value ?? '';
          if (cred) Object.assign(headers, buildUpstreamAuthHeaders('groq', cred));
          adaptAnthropicToOpenAI(payload);
          // Raisonnement modèle-aware — Groq a 3 familles aux APIs incompatibles :
          //  - qwen/qwen3.6-27b : reasoning_effort:"none" coupe le raisonnement à la source
          //    (sinon leak <think> + finish:length). Ne supporte PAS reasoning_format.
          //  - gpt-oss-* : reasoning inclus par défaut (leak <think>). Pas de reasoning_format ;
          //    include_reasoning:false supprime le raisonnement du output.
          //  - llama-3.3-70b et modèles non-reasoning : AUCUN param reasoning (sinon 400).
          delete payload.reasoning_format;
          delete payload.reasoning_effort;
          delete payload.include_reasoning;
          if (resolvedTarget.model === 'qwen/qwen3.6-27b') {
            payload.reasoning_effort = 'none';
          } else if (resolvedTarget.model.startsWith('openai/gpt-oss')) {
            payload.include_reasoning = false;
          }

          // Transformation des tools Anthropic pour Groq
          if (payload.tools && Array.isArray(payload.tools)) {
            payload.tools = payload.tools.map((t: any) => {
              if (t.input_schema) {
                return {
                  type: 'function',
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema
                  }
                };
              }
              return t;
            });
          }
          break;

        case 'xai':
          hostname = 'api.x.ai';
          path = '/v1/chat/completions'; // xAI uses OpenAI-compatible API
          cred = await resolveUpstreamCredential('xai');
          targetApiKey = cred?.value ?? '';
          if (cred) Object.assign(headers, buildUpstreamAuthHeaders('xai', cred));
          adaptAnthropicToOpenAI(payload);

          // Transformation des tools Anthropic pour xAI (format OpenAI)
          if (payload.tools && Array.isArray(payload.tools)) {
            payload.tools = payload.tools.map((t: any) => {
              if (t.input_schema) {
                return {
                  type: 'function',
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema
                  }
                };
              }
              return t;
            });
          }
          break;

        case 'openai':
          hostname = 'api.openai.com';
          path = '/v1/chat/completions';
          cred = await resolveUpstreamCredential('openai');
          targetApiKey = cred?.value ?? '';
          if (cred) Object.assign(headers, buildUpstreamAuthHeaders('openai', cred));
          adaptAnthropicToOpenAI(payload);

          // Transformation des tools Anthropic pour OpenAI (format function)
          if (payload.tools && Array.isArray(payload.tools)) {
            payload.tools = payload.tools.map((t: any) => {
              if (t.input_schema) {
                return {
                  type: 'function',
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema
                  }
                };
              }
              return t;
            });
          }
          break;

        case 'moonshot':
        default:
          hostname = 'api.moonshot.ai';
          path = '/anthropic/v1/messages'; // Mode d'émulation Anthropic natif (Pas besoin de changer les tools)
          cred = await resolveUpstreamCredential('moonshot');
          targetApiKey = cred?.value ?? '';
          if (cred) Object.assign(headers, buildUpstreamAuthHeaders('moonshot', cred));
          headers['Accept'] = 'text/event-stream';

          if (!payload.max_tokens) {
            payload.max_tokens = 4096;
          }
          if (resolvedTarget.model === 'kimi-k2.7-code' && !payload.thinking) {
            payload.thinking = { type: 'enabled', budget_tokens: 4000 };
          }
          break;
      }

      // Fail closed: buildUpstreamAuthHeaders returns null when a non-api-key
      // credential (e.g. a Claude subscription OAT) is resolved for a
      // non-anthropic upstream. The per-provider Object.assign above already
      // refused to emit it — but we must NOT fall through to an unauthenticated
      // https.request either. 401 before any request is sent.
      if (cred && buildUpstreamAuthHeaders(resolvedTarget.provider, cred) === null) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error', message: `The resolved credential for provider "${resolvedTarget.provider}" cannot be used on this upstream (subscription/oauth credentials are only valid for the anthropic upstream).` } }));
        return;
      }

      if (!targetApiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error', message: `No API key for provider "${resolvedTarget.provider}"` } }));
        return;
      }

      console.log(`[Proxy Sortant] Redirection vers ${resolvedTarget.provider} (${hostname}${path}) avec le modèle "${payload.model}"`);

      const options: RequestOptions = {
        hostname,
        port: 443,
        path,
        method: 'POST',
        headers
      };

      // Budget de rejeu sur tour vide — voir isEmptyAnthropicTurn. Réservé aux
      // providers needsStrip ; décrémenté à chaque rejeu, jamais réarmé.
      let emptyTurnRetriesLeft =
        (resolvedTarget.provider === 'openrouter' || resolvedTarget.provider === 'requesty')
          ? resolveEmptyTurnRetries()
          : 0;

      const sendUpstream = (): void => {
      const proxyReq = request(options, (proxyRes) => {
        const status = proxyRes.statusCode || 200;
        const contentType = proxyRes.headers['content-type'] as string || '';
        const isStreaming = (payload.stream === true) && /text\/event-stream/i.test(contentType);
        /** Rejoue le tour. Retourne false si le budget est épuisé. */
        const retryEmptyTurn = (): boolean => {
          if (status !== 200 || emptyTurnRetriesLeft <= 0) return false;
          emptyTurnRetriesLeft--;
          console.warn(
            `\x1b[33m[Proxy] tour vide (end_turn sans texte ni tool_use) de ` +
            `${resolvedTarget.provider}:${resolvedTarget.model} — rejeu ` +
            `(${emptyTurnRetriesLeft} restant(s))\x1b[0m`
          );
          proxyRes.resume(); // libère le socket avant de renvoyer
          sendUpstream();
          return true;
        };
        // OpenRouter renvoie des blocs thinking/redacted_thinking (signature vide) que le
        // CLI `claude` rejette pour les modèles courants → on les strip côté proxy.
        // Requesty a le même défaut (vérifié live : sference/* renvoie
        // {"type":"thinking",…,"signature":""}), et c'est précisément par le pack local —
        // où le modèle porte un nom Claude — que le CLI applique ce rejet.
        const needsStrip =
          resolvedTarget.provider === 'openrouter' || resolvedTarget.provider === 'requesty';
        // Groq/ZAI/xAI/OpenAI parlent OpenAI : convertir la réponse (JSON ou SSE) en Anthropic.
        const needsConvert = resolvedTarget.provider === 'groq' || resolvedTarget.provider === 'zai' || resolvedTarget.provider === 'xai' || resolvedTarget.provider === 'openai';

        if (needsConvert && !isStreaming) {
          const respHeaders = { ...proxyRes.headers };
          delete respHeaders['content-length'];
          delete respHeaders['transfer-encoding'];
          respHeaders['content-type'] = 'application/json';
          res.writeHead(status, respHeaders);
          let body = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (c: string) => { body += c; });
          proxyRes.on('end', () => {
            res.end(openaiJsonToAnthropic(body || '{}'));
          });
        } else if (needsConvert && isStreaming) {
          const respHeaders = { ...proxyRes.headers };
          delete respHeaders['content-length'];
          respHeaders['content-type'] = 'text/event-stream';
          res.writeHead(status, respHeaders);
          const converter = new OpenAIToAnthropicStreamConverter();
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (c: string) => {
            for (const out of converter.push(c)) res.write(out);
          });
          proxyRes.on('end', () => {
            for (const out of converter.flush()) res.write(out);
            res.end();
          });
        } else if (needsStrip && !isStreaming) {
          // Non-streaming : bufferiser le body JSON, strip les blocs thinking, renvoyer.
          // writeHead est différé jusqu'après la décision de rejeu : une fois les
          // en-têtes envoyés, la réponse est engagée et le rejeu impossible.
          let body = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (c: string) => { body += c; });
          proxyRes.on('end', () => {
            if (isEmptyAnthropicTurn(body) && retryEmptyTurn()) return;
            const respHeaders = { ...proxyRes.headers };
            delete respHeaders['content-length']; // on va reformer le body
            delete respHeaders['transfer-encoding'];
            res.writeHead(status, respHeaders);
            res.end(stripThinkingFromAnthropicJson(body || '{}'));
          });
        } else if (needsStrip && isStreaming) {
          // Streaming SSE : filtrer les events thinking en flux (indices contigus).
          //
          // Les events sont retenus jusqu'au PREMIER bloc réellement visible
          // (text/tool_use). Coût nul : les blocs thinking étant strippés, rien
          // ne partait vers le client pendant la phase de raisonnement de toute
          // façon — cette fenêtre est exactement celle où le tour vide se joue.
          // Passé ce point on est engagé et on repasse en flux direct.
          const stripper = new AnthropicThinkingStripper();
          const pending: string[] = [];
          let committed = false;
          const commit = (): void => {
            if (committed) return;
            committed = true;
            const respHeaders = { ...proxyRes.headers };
            delete respHeaders['content-length'];
            res.writeHead(status, respHeaders);
            for (const out of pending) res.write(out);
            pending.length = 0;
          };
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (c: string) => {
            for (const out of stripper.push(c)) {
              if (committed) res.write(out);
              else pending.push(out);
            }
            if (!committed && stripper.hasMeaningfulContent) commit();
          });
          proxyRes.on('end', () => {
            for (const out of stripper.flush()) {
              if (committed) res.write(out);
              else pending.push(out);
            }
            if (!committed && stripper.hasMeaningfulContent) commit();
            if (!committed) {
              // Rien de visible n'a été produit. Rejouer si c'est la signature
              // du tour vide ; sinon livrer le flux tel quel (message bien formé,
              // fût-il vide) plutôt que de laisser le client pendre.
              const emptyTurn = stripper.stopReason === 'end_turn';
              if (emptyTurn && retryEmptyTurn()) return;
              commit();
            }
            res.end();
          });
        } else {
          // Moonshot (Anthropic natif) : pipe brut inchangé.
          res.writeHead(status, proxyRes.headers);
          proxyRes.pipe(res);
        }
      });

      proxyReq.on('error', (err) => {
        console.error('[Proxy SORTANT error]', err);
        // Un rejeu peut échouer après qu'un essai précédent a engagé la réponse —
        // n'écrire l'erreur que si rien n'est encore parti.
        if (res.headersSent) { res.end(); return; }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: err.message } }));
      });

      proxyReq.write(JSON.stringify(payload));
      proxyReq.end();
      };

      sendUpstream();

    } catch (e: any) {
      console.error('[Payload Error]', e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: e.message } }));
    }
  });
});

/** Le serveur HTTP du proxy (non démarré). Importable pour test/embed. */
export { server };

/** Exporté pour les tests — voir la note sur le rejeu de tour vide. */
export { isEmptyAnthropicTurn, resolveEmptyTurnRetries };

/** Démarre le proxy sur `port` (défaut : {@link PORT}). Renvoie le serveur en écoute. */
export function start(port: number = PORT) {
  return server.listen(port, () => {
    console.log(`[Proxy Server] Live on http://localhost:${port}`);
    console.log(`[Proxy Server] Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses surfaces configured.`);
  });
}
