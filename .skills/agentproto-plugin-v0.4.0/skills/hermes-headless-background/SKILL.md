---
name: hermes-headless-background
description:
  "Déléguer une tâche (audit, recherche, grunt-work) à une session hermes sur un
  modèle PAS CHER (glm-5.2/deepseek/kimi via OpenRouter) en CLI DIRECT,
  headless, en arrière-plan — SANS le daemon agentproto ni les tools MCP.
  Déclenche ce skill quand les tools `mcp__agentproto__*` sont absents de la
  session, quand l'utilisateur dit « lance un agent hermes/glm/deepseek en
  background », « fais auditer ça par un modèle pas cher pendant qu'on continue
  », ou quand tu veux un second avis indépendant bon marché sans cramer
  l'abonnement. Complète agent-session-orchestration-agentproto (qui, lui,
  suppose le daemon MCP)."
---

# Hermes headless en background (sans daemon MCP)

Pattern réel, prouvé en session : faire tourner une session **hermes** sur un
modèle bon marché (OpenRouter) **en CLI direct**, headless, en arrière-plan,
quand le daemon agentproto / les tools `mcp__agentproto__*` ne sont PAS chargés
dans la session (démarrer le daemon en cours de route ne réinjecte pas ses tools
MCP). On parle au binaire `hermes` directement.

Pour le chemin MCP (daemon présent) voir
`agent-session-orchestration-agentproto` et `light-coder-orchestration`. Le
présent skill = le **fallback CLI**.

## Quand l'utiliser

- `ToolSearch "agentproto agent_start"` ne ramène aucun
  `mcp__agentproto__*`.
- Tâche déléguable à un modèle pas cher (audit READ-ONLY, recherche,
  classification, bulk) — pas du frontier-judgment. Voir
  `feedback_delegate_to_cheap_agentproto`.
- Tu veux continuer à bosser pendant que ça tourne → background.

## Recette (end-to-end)

### 0. Pré-vol

```bash
which hermes            # ex: ~/.local/bin/hermes  (sinon: stop)
hermes status 2>&1 | grep -iE "openrouter|provider|model"   # provider authed ✓ ?
```

`hermes --help` : flags clés = `-z PROMPT` (headless one-shot), `-m MODEL`,
`--provider PROVIDER`, `--yolo` (pas de confirmations), `--resume SESSION`.

### 1. VÉRIFIER LE MODÈLE D'ABORD (si l'utilisateur a nommé un modèle précis)

Consigne fréquente : « si tu n'arrives pas à avoir le modèle, tu STOP ».
`hermes model` est juste un sélecteur interactif — il ne liste pas. Le seul test
fiable = un probe minimal + lire la colonne `model` de `state.db` :

```bash
export PATH="$HOME/.local/bin:$PATH"
hermes -z "Reply with exactly: PONG" -m z-ai/glm-5.2 --provider openrouter --yolo 2>&1 | tail -5
sqlite3 ~/.hermes/state.db "select model, estimated_cost_usd from sessions order by rowid desc limit 1;"
# La sortie DOIT montrer model = z-ai/glm-5.2 (pas le défaut deepseek-v4-pro). Sinon → STOP.
```

Alias modèles courants (OpenRouter, ~$0.01-0.5/run) : **`z-ai/glm-5.2`** («
glm-z2 » / « zlm g2 ») et **`deepseek/deepseek-v4-pro`**. hermes IGNORE le model
de session ACP mais l'adapter envoie un `/model <id>` → d'où la vérif via
state.db.

### 2. Écrire le brief dans un fichier (pas inline)

Les prompts longs cassent l'escaping shell. Écris le brief dans le scratchpad,
passe-le avec `"$(cat …)"`. Pour un AUDIT, le brief DOIT contenir :

- **READ-ONLY** explicite (« Do NOT edit, deploy, git-write, DB-write »).
- Le contexte + tes conclusions à **CHALLENGER avec preuves** (file:line), pas à
  gober.
- La liste des fichiers à lire + les livrables (verdict par claim, ce qui
  manque, plan rangé).

### 3. Lancer en background

```bash
export PATH="$HOME/.local/bin:$PATH"; cd <repo-root>
hermes -z "$(cat <scratchpad>/brief.md)" -m z-ai/glm-5.2 --provider openrouter --yolo \
  > <scratchpad>/audit-out.log 2>&1
```

→ outil Bash avec `run_in_background: true`. Tu es **notifié à la fin**
(`<task-notification>`). **Ne poll PAS en boucle** (ça crame TON contexte) —
attends la notif, puis `Read` le `.log`.

### 4. Lire le résultat + le coût

```bash
sqlite3 ~/.hermes/state.db \
  "select model, estimated_cost_usd, input_tokens, output_tokens from sessions order by rowid desc limit 1;"
```

Colonnes utiles de `sessions` :
`model, estimated_cost_usd, actual_cost_usd, input_tokens, output_tokens, cache_read_tokens, end_reason, tool_call_count`.

### 5. FILET DE VÉRIFICATION (non négociable)

Un modèle léger **hallucine des file:line** et se trompe sur les calculs. Avant
de relayer : re-vérifie toi-même chaque claim actionnable (grep/sed les
file:line cités, refais l'arithmétique). Relaye en marquant CONFIRMÉ / corrigé /
réfuté.

## Gotchas (tous rencontrés en vrai)

- **Pas de `mcp__agentproto__*`** → inutile de lancer le daemon en cours de
  session pour les récupérer ; les serveurs MCP se chargent au boot. Reste en
  CLI direct.
- **macOS n'a pas `timeout`** (`command not found` → toute la ligne
  court-circuite, hermes ne tourne jamais). N'enrobe PAS avec `timeout`.
  `hermes -z` est one-shot et sort seul ; pour borner, utilise le `timeout` de
  l'outil Bash ou `run_in_background`.
- **Le classifier auto-mode bloque les secrets en clair** sur la ligne de
  commande (clé API inline = « Credential Leakage »). Source depuis un fichier
  env : `export X="$(grep -E '^X=' envs/…/.env | cut -d= -f2-)"`, jamais la
  valeur en dur, jamais un `echo`/`cat` qui la matérialise dans le transcript.
- **`state.db` s'écrit ~après le turn-end** — si la colonne `model`/coût semble
  vide, relire après une courte attente.
- Le modèle par défaut hermes (`~/.hermes`) est `deepseek-v4-pro` ; si tu ne
  passes pas `-m`, c'est lui qui tourne. Toujours expliciter
  `-m … --provider …`.
- Reprendre une session : `hermes -r <sessionId>` (id = `sessions.id` dans
  state.db).

## Pourquoi

OpenRouter pay-per-token (centimes), séparé de l'abonnement Claude — pour le
grunt/audit/recherche, déléguer ici plutôt que brûler un subagent Opus/Sonnet.
Réserve le `Agent` tool / Claude au frontier-judgment et à la passe de vérif.
