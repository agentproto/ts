import { createServer } from 'http';
import { request, RequestOptions } from 'https';

// Port local du proxy — surchargeable via env (LLM_ENDPOINT_PORT | PORT).
// NOTE: evaluated once at module-load time. Set the env variable *before*
// importing this module if you need a non-default port without passing it
// explicitly to start(port).
const PORT = Number(process.env.LLM_ENDPOINT_PORT ?? process.env.PORT ?? 18090);

interface SecretTarget {
  provider: string;
  model: string;
  equivalentClaudeName: string;
}

// Mappage des codes secrets aléatoires vers les vrais noms de modèles/providers.
// equivalentClaudeName utilise la famille Claude COURANTE (Opus 4.8 / Fable 5 / Sonnet 5 / Haiku 4.5)
// pour que le TUI de `claude` (Claude Code 2.x) accepte le modèle au démarrage — les anciens
// noms retirés (claude-3-5-*) sont rejetés côté client par le CLI interactif. Les backends
// secondaires gardent un alias legacy accessible en mode print ou via ?m=<code>.
const SECRET_CODE_MAPPING: Record<string, SecretTarget> = {
  // Codes pour Moonshot direct (exposés sous forme de claude pour tromper les parsers Anthropic d'extensions)
  'jupiter-7': { provider: 'moonshot', model: 'kimi-k2.7-code', equivalentClaudeName: 'claude-opus-4-8' },
  'mars-6': { provider: 'moonshot', model: 'kimi-k2.6', equivalentClaudeName: 'claude-3-opus' },

  // Codes pour OpenRouter
  'saturn-5': { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', equivalentClaudeName: 'claude-sonnet-5' },
  'neptune-4': { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', equivalentClaudeName: 'claude-sonnet-4-6' },
  'uranus-8': { provider: 'openrouter', model: 'google/gemini-3.1-pro-preview', equivalentClaudeName: 'claude-fable-5' },
  'mercury-9': { provider: 'openrouter', model: 'z-ai/glm-5.2', equivalentClaudeName: 'claude-3-haiku-20240307' }, // Mise à jour de Mercury-9 vers GLM 5.2 via OpenRouter !

  // Codes pour OpenRouter — top modèles populaires (non-Anthropic)
  'halley-1': { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', equivalentClaudeName: 'claude-fable-4' },        // DeepSeek V4 Flash (rapide)
  'orion-2': { provider: 'openrouter', model: 'xiaomi/mimo-v2.5', equivalentClaudeName: 'claude-opus-4-6' },                 // Xiaomi MiMo-V2.5
  'pegasus-3': { provider: 'openrouter', model: 'minimax/minimax-m3', equivalentClaudeName: 'claude-opus-4-9' },              // MiniMax M3
  'lyra-4': { provider: 'openrouter', model: 'tencent/hy3-preview', equivalentClaudeName: 'claude-opus-4-7' },                // Tencent Hy3 preview
  'vega-5': { provider: 'openrouter', model: 'stepfun/step-3.7-flash', equivalentClaudeName: 'claude-sonnet-4-5' },  // Step 3.7 Flash (rapide)

  // Codes pour Zhipu AI / ZAI (BigModel direct)
  'venus-3': { provider: 'zai', model: 'glm-5.2', equivalentClaudeName: 'claude-3-5-fable' },

  // Codes pour Groq (Inférence ultra-rapide)
  'pluto-2': { provider: 'groq', model: 'qwen/qwen3.6-27b', equivalentClaudeName: 'claude-haiku-4-5' },
  'atlas-6': { provider: 'groq', model: 'llama-3.3-70b-versatile', equivalentClaudeName: 'claude-3-5-sonnet-20241022' },      // Llama 3.3 70B (non-reasoning)
  'titan-7': { provider: 'groq', model: 'openai/gpt-oss-120b', equivalentClaudeName: 'claude-sonnet-4-7' }                    // GPT-OSS 120B (reasoning, include_reasoning:false)
};

// Limite max d'outils par provider (au-delà, Groq renvoie 400 "maximum number of items is 128").
// Les providers non listés sont illimités. Le CLI `claude` charge sa config MCP globale
// (~/.claude + .mcp.json + skills) → dépasse souvent 128 outils → on tronque côté proxy.
const PROVIDER_MAX_TOOLS: Record<string, number> = {
  groq: 128
};

// Providers routables — sert d'allow-list pour l'override `?p=`. Un `?p=<inconnu>`
// laisserait sinon hostname vide et échouerait plus loin avec une erreur opaque.
const KNOWN_PROVIDERS = new Set(['moonshot', 'openrouter', 'zai', 'groq']);

// Trimme/strip les outils du payload selon :
//  - queryTools ("a,b,c") : allow-list explicite (garde uniquement ces outils, par nom).
//  - queryNoTools ("1") : strip TOUS les outils (+ tool_choice) → mode "lean".
//  - sinon : tronque au cap du provider si dépassé.
// `toolName` extrait le nom d'un outil quelle que soit sa forme (Anthropic: .name ;
// OpenAI function: .function.name). Doit tourner AVANT la transformation de forme
// propre à chaque provider (ZAI/Groq mappent input_schema → function.parameters).
function trimTools(payload: any, provider: string, queryTools: string | null, queryNoTools: string | null): void {
  if (!payload || !Array.isArray(payload.tools) || payload.tools.length === 0) return;

  // 1. Strip total demandé explicite (?notools=1 ou ?tools=none)
  if (queryNoTools === '1' || queryTools === 'none') {
    console.log(`[Proxy][tools] strip total (${payload.tools.length} outils supprimés)`);
    delete payload.tools;
    delete payload.tool_choice;
    return;
  }

  // 2. Allow-list explicite (?tools=Bash,Read,Write)
  if (queryTools) {
    const allow = new Set(queryTools.split(',').map(s => s.trim()).filter(Boolean));
    const before = payload.tools.length;
    payload.tools = payload.tools.filter((t: any) => {
      const name = (t && (t.name || (t.function && t.function.name))) || '';
      return allow.has(name);
    });
    console.log(`[Proxy][tools] allow-list {${[...allow].join(',')}} → ${before}→${payload.tools.length}`);
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
  moonshot: string;
  openrouter: string;
  zai: string;
  groq: string;
}

// Résolution des clés API d'hôtes depuis les variables d'environnement.
// Place un fichier .env à la racine du workspace ou exporte les variables
// d'environnement avant de démarrer le serveur.
function resolveSecretKeys(): ProviderKeys {
  return {
    moonshot: process.env.MOONSHOT_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
    zai: process.env.ZHIPUAI_API_KEY || process.env.ZAI_API_KEY || '',
    groq: process.env.GROQ_API_KEY || ''
  };
}

const resolvedKeys = resolveSecretKeys();

// Adapte un payload Anthropic Messages vers le schéma OpenAI Chat Completions
// (Groq / OpenRouter / ZAI). Moonshot expose un endpoint /anthropic natif et
// n'a PAS besoin de cette adaptation. Renvoie les champs problématiques supprimés
// et les champs sémantiquement équivalents convertis (system, tool_choice, stop).
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

// Transformeur SSE en flux : filtre les content_block_start/delta/stop des blocs
// thinking/redacted_thinking et réindexe les blocs conservés (0,1,2…) pour que le
// CLI voie des indices contigus. Garde message_start/message_delta/message_stop/ping.
class AnthropicThinkingStripper {
  private skipIndices = new Set<number>();
  private indexMap = new Map<number, number>();
  private nextOut = 0;
  private buffer = '';

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

// --- Groq/ZAI : conversion OpenAI → Anthropic ---
// Groq et ZAI ne parlent que l'API OpenAI (chat/completions). Le CLI `claude` ne
// parse QUE le format Anthropic. On convertit donc la réponse OpenAI (JSON ou SSE)
// en Anthropic côté proxy. Champs clés (validés via le repo
// Skillter/OpenAI-to-Claude-API-Converter-Proxy) :
//   finish_reason: stop|length|tool_calls|content_filter  →  stop_reason: end_turn|max_tokens|tool_use|stop
//   choices[0].message.content (string)                   →  content:[{type:"text",text}]
//   choices[0].message.tool_calls[]                       →  content:[{type:"tool_use",id,name,input}]
//   usage.prompt_tokens / completion_tokens               →  usage.input_tokens / output_tokens

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

const server = createServer((req, res) => {
  // CORS & Options
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization, anthropic-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const rawUrl = req.url || '';
  const parsedUrl = new URL(rawUrl, `http://localhost:${PORT}`);
  const urlPath = parsedUrl.pathname.replace(/\/+$/, '');

  // Lecture des paramètres de requête p (provider), m (secret code model),
  // tools (allow-list d'outils à garder) et notools (strip tous les outils).
  const queryProvider = parsedUrl.searchParams.get('p');
  const queryModelCode = parsedUrl.searchParams.get('m');
  const queryTools = parsedUrl.searchParams.get('tools'); // ex: ?tools=Bash,Read,Write
  const queryNoTools = parsedUrl.searchParams.get('notools'); // ex: ?notools=1

  console.log(`[Proxy] Incoming request: ${req.method} ${rawUrl}`);

  // 1. Endpoint /v1/models pour la découverte des modèles (conforme au format exact d'Anthropic ou d'OpenAI)
  if (req.method === 'GET' && (urlPath === '/v1/models' || urlPath === '/models')) {
    const isAnthropicStyle = req.headers['anthropic-version'] !== undefined || req.headers['x-api-key'] !== undefined;

    if (isAnthropicStyle) {
      // Format 100% Natif d'Anthropic Claude
      const anthropicModelsResponse = {
        data: Object.entries(SECRET_CODE_MAPPING).map(([code, target]) => ({
          id: target.equivalentClaudeName,
          display_name: `Claude ${code.toUpperCase()}`,
          created_at: "2026-02-04T00:00:00Z",
          type: "model",
          max_input_tokens: 200000,
          max_tokens: 8192,
          capabilities: {
            batch: { supported: true },
            citations: { supported: true },
            code_execution: { supported: true },
            context_management: { supported: true },
            effort: { high: { supported: true }, supported: true },
            image_input: { supported: true },
            structured_outputs: { supported: true },
            thinking: { supported: true, types: { enabled: { supported: true } } }
          }
        })),
        has_more: false,
        first_id: null,
        last_id: null
      };
      console.log(`[Proxy] Returning native Anthropic-formatted model list.`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(anthropicModelsResponse));
      return;
    } else {
      // Format d'étude OpenAI standardisé au cas où
      const openaiModelsResponse = {
        object: 'list',
        data: Object.keys(SECRET_CODE_MAPPING).map(code => ({
          id: code,
          object: 'model',
          created: 1718841600,
          owned_by: 'openai', // Utiliser 'openai' par défaut pour forcer les parsers tiers à l'accepter
          permission: [
            {
              id: 'modelperm-' + code,
              object: 'model_permission',
              created: 1718841600,
              allow_create_engine: false,
              allow_effectively_free: true,
              allow_sampling: true,
              allow_logprobs: true,
              allow_search_indices: false,
              allow_view: true,
              allow_fine_tuning: false,
              organization: '*',
              group: null,
              is_blocking: false
            }
          ],
          root: code,
          parent: null
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

  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const incomingModelName = (payload.model || '').toLowerCase();
      
      // Trouver la destination (Provider & Model)
      let resolvedTarget = { provider: 'moonshot', model: 'kimi-k2.6' };
      
      // Étape 1 : S'il y a un paramètre de code secret 'm' explicite dans l'URL
      const explicitTarget = queryModelCode ? SECRET_CODE_MAPPING[queryModelCode] : undefined;
      if (explicitTarget) {
        resolvedTarget = explicitTarget;
        console.log(`[Proxy] Detected URL model parameter code "${queryModelCode}" -> mapping to ${resolvedTarget.provider}:${resolvedTarget.model}`);
      } else {
        // Étape 2 : Chercher dans notre dictionnaire d'équivalence Claude (exemples: "claude-3-5-sonnet")
        const matchedEntry = Object.entries(SECRET_CODE_MAPPING).find(
          ([code, target]) => target.equivalentClaudeName === incomingModelName || code.toLowerCase() === incomingModelName
        );

        if (matchedEntry) {
          resolvedTarget = matchedEntry[1];
          console.log(`[Proxy] Matched incoming model "${incomingModelName}" to equivalent secret mapping ${resolvedTarget.provider}:${resolvedTarget.model}`);
        } else {
          // Étape 3 : Fallback par regex habituel si aucune équivalence stricte trouvée.
          // Routage par tier pour la famille Claude courante (opus/fable → kimi, sonnet → deepseek, haiku → groq).
          if (/opus|fable/i.test(incomingModelName)) {
            resolvedTarget = { provider: 'moonshot', model: 'kimi-k2.7-code' };
          } else if (/sonnet/i.test(incomingModelName)) {
            resolvedTarget = { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' };
          } else if (/haiku/i.test(incomingModelName)) {
            resolvedTarget = { provider: 'groq', model: 'llama-3.3-70b-versatile' };
          } else {
            resolvedTarget = { provider: 'moonshot', model: 'kimi-k2.6' };
          }
        }
      }

      // S'il y a une demande de changement de provider explicite via "?p=..."
      if (queryProvider) {
        if (!KNOWN_PROVIDERS.has(queryProvider)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `Unknown provider "${queryProvider}" in ?p= (allowed: ${[...KNOWN_PROVIDERS].join(', ')})` } }));
          return;
        }
        resolvedTarget.provider = queryProvider;
        console.log(`[Proxy] Explicit URL provider parameter override -> ${queryProvider}`);
      }

      // Configuration de la requête sortante selon le provider résolu
      let hostname = '';
      let path = '';
      let targetApiKey = '';
      let headers: Record<string, string> = { 'Content-Type': 'application/json' };

      payload.model = resolvedTarget.model;

      // Trimme les outils AVANT la transformation de forme propre à chaque provider
      // (ZAI/Groq mappent input_schema → function.parameters ; le trim doit voir la forme Anthropic).
      trimTools(payload, resolvedTarget.provider, queryTools, queryNoTools);

      switch (resolvedTarget.provider) {
        case 'openrouter':
          // OpenRouter expose un endpoint Anthropic NATIF (/api/v1/messages) qui renvoie le
          // format Anthropic (content/stop_reason) tel quel — indispensable pour le CLI `claude`
          // qui ne parse PAS le format OpenAI (sinon : "malformed response HTTP 200").
          // Aucune adaptation request/response : tools (input_schema), system, thinking,
          // tool_choice, stop_sequences passent en natif Anthropic côté OpenRouter.
          hostname = 'openrouter.ai';
          path = '/api/v1/messages';
          targetApiKey = resolvedKeys.openrouter;
          headers['Authorization'] = `Bearer ${targetApiKey}`;
          headers['anthropic-version'] = '2023-06-01';
          break;

        case 'zai':
          hostname = 'open.bigmodel.cn';
          path = '/api/paas/v4/chat/completions'; // Zhipu AI standard path
          targetApiKey = resolvedKeys.zai;
          headers['Authorization'] = `Bearer ${targetApiKey}`;
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
          targetApiKey = resolvedKeys.groq;
          headers['Authorization'] = `Bearer ${targetApiKey}`;
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

        case 'moonshot':
        default:
          hostname = 'api.moonshot.ai';
          path = '/anthropic/v1/messages'; // Mode d'émulation Anthropic natif (Pas besoin de changer les tools)
          targetApiKey = resolvedKeys.moonshot;
          headers['X-API-Key'] = targetApiKey;
          headers['Accept'] = 'text/event-stream';
          
          if (!payload.max_tokens) {
            payload.max_tokens = 4096;
          }
          if (resolvedTarget.model === 'kimi-k2.7-code' && !payload.thinking) {
            payload.thinking = { type: 'enabled', budget_tokens: 4000 };
          }
          break;
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

      const proxyReq = request(options, (proxyRes) => {
        const status = proxyRes.statusCode || 200;
        const contentType = proxyRes.headers['content-type'] as string || '';
        const isStreaming = (payload.stream === true) && /text\/event-stream/i.test(contentType);
        // OpenRouter renvoie des blocs thinking/redacted_thinking (signature vide) que le
        // CLI `claude` rejette pour les modèles courants → on les strip côté proxy.
        const needsStrip = resolvedTarget.provider === 'openrouter';
        // Groq/ZAI parlent OpenAI : convertir la réponse (JSON ou SSE) en Anthropic.
        const needsConvert = resolvedTarget.provider === 'groq' || resolvedTarget.provider === 'zai';

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
          const respHeaders = { ...proxyRes.headers };
          delete respHeaders['content-length']; // on va reformer le body
          delete respHeaders['transfer-encoding'];
          res.writeHead(status, respHeaders);
          let body = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (c: string) => { body += c; });
          proxyRes.on('end', () => {
            res.end(stripThinkingFromAnthropicJson(body || '{}'));
          });
        } else if (needsStrip && isStreaming) {
          // Streaming SSE : filtrer les events thinking en flux (indices contigus).
          const respHeaders = { ...proxyRes.headers };
          delete respHeaders['content-length'];
          res.writeHead(status, respHeaders);
          const stripper = new AnthropicThinkingStripper();
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', (c: string) => {
            for (const out of stripper.push(c)) res.write(out);
          });
          proxyRes.on('end', () => {
            for (const out of stripper.flush()) res.write(out);
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
});

/** Le serveur HTTP du proxy (non démarré). Importable pour test/embed. */
export { server };

/** Démarre le proxy sur `port` (défaut : {@link PORT}). Renvoie le serveur en écoute. */
export function start(port: number = PORT) {
  return server.listen(port, () => {
    console.log(`[Proxy Server] Live on http://localhost:${port}`);
    console.log(`[Proxy Server] Dual API specifications (Anthropic native & OpenAI schemas) fully configured.`);
    console.log(`[Proxy Server] Credentials status - Moonshot: ${resolvedKeys.moonshot ? 'OK' : 'MISSING'}, OpenRouter: ${resolvedKeys.openrouter ? 'OK' : 'MISSING'}, ZAI: ${resolvedKeys.zai ? 'OK' : 'MISSING'}, Groq: ${resolvedKeys.groq ? 'OK' : 'MISSING'}`);
  });
}
