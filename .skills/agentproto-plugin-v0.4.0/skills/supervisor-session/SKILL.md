---
name: supervisor-session
description: Conduire une session SUPERVISEUR avec agentproto — l'orchestrateur (Claude, tokens chers) ne code pas mais garde la main. Pipeline prouvé (extension VS Code agentproto, 2026-07-14) - scout recon vérifié-source → SPEC + interfaces gelées → WP briefs disjoints → exécuteurs parallèles (modèles économiques) → vérif disque systématique → consolidation single-writer → verify adversarial + e2e live → draft PR. Déclenche quand l'utilisateur veut "superviser au maximum en gardant la capacité d'agir", faire construire un livrable multi-WP par des modèles pas chers, ou industrialiser scout→brief→exécution→vérif→commit. Complète light-coder-orchestration (choix modèle + filet Sonnet) et durable-supervision (policies in-daemon) - ici c'est la BOUCLE OPÉRATOIRE du superviseur.
---

# Supervisor session (agentproto)

**Principe** : le superviseur tient le *plan, les contrats et la vérité disque* ;
les sessions tiennent le *travail*. Tu ne codes pas — SAUF la consolidation et
les fixes chirurgicaux (1 fichier, cause connue), parce que le worktree est
local : c'est ça, « garder la capacité d'agir ».

## Pipeline (rôles → artefacts)

```
scout (modèle 1M ctx, pas cher)   → recon doc VÉRIFIÉ vs source (spot-check grep toi-même)
toi                               → SPEC.md + contrat d'interfaces GELÉ + matrice de fichiers par WP
exécuteurs parallèles (cheap)     → WPs sur périmètres DISJOINTS (briefs = fichiers .plans/)
toi (après chaque turn-end)       → vérif disque + checkpoint commit ciblé
toi (single writer)               → consolidation (fichiers partagés : extension.ts, package.json…)
verify session (Sonnet, sub)      → re-gates + revue adversariale du diff (ne fixe pas, rapporte)
toi                               → e2e LIVE (script tsx contre le vrai daemon) + draft PR
```

- **WP0 fondation d'abord, seul** : il GÈLE les interfaces (client, store, ids
  de commandes). Les WP1..N codent contre ces noms sans se coordonner.
- **Fichiers partagés = à personne.** Chaque brief interdit `package.json` /
  `extension.ts` (équivalents) et exige dans le rapport final : *les lignes de
  wiring exactes + snippets de config à merger*. La consolidation (toi) les
  applique en une passe et résout les collisions (ex. deux WPs revendiquant la
  même commande → renomme l'un).
- Briefs = fichiers dans `.plans/<projet>/WPn-brief.md` ; le prompt de session
  ne contient QUE le pointeur + les overrides (no-git, no-subagents, parallel-
  aware). Rapport final imposé : fichiers touchés, choix de design, wiring
  lines, exit codes RÉELS.

## Protocole de spawn (hermes / modèles OpenRouter)

1. `agent_start` **idle** (pas de prompt initial !), `role: "executor"`
   (strip agent_start/agent_prompt), cwd = worktree dédié.
2. `/model <slug>` seul → attendre turn-end → **vérifier la ligne
   `Model switched to: <slug> · Provider: …`** dans agent_output.
3. Ping de vie : `Reply with exactly: READY` → turn non-vide = session saine.
4. Alors seulement, le brief.

**Pourquoi** : `/model` en prompt de spawn fait FREELANCER hermes (explore le
repo sur le modèle par défaut cher — vécu : ~$1.9 le tour pour rien). Et un
turn vide après switch ≠ session foutue : voir Diagnostic.

Pour claude-code/claude-sdk : `model` + `auth {mode:"subscription"}` (ou
`mode:"moonshot"` + kimi) se pinnent AU SPAWN — pas de danse /model, le brief
peut partir dans le prompt initial.

## Monitoring (économe en tokens superviseur)

- Quick check : `session_monitor` (≤49s), fan-in via `sessionIds: [...]`.
- Attente longue : `npx agentproto sessions wait <id> --until turn-end
  --timeout 2400000` **backgroundé** (piège vécu : timeout en **ms** — `900`
  = 900 ms). Fan-in : une boucle `for s in …; do wait; done` dans UN SEUL
  background task.
- Ne JAMAIS lire tout l'output : `agent_output clean lastN 40-60` après
  turn-end, c'est tout.

## Vérité = disque, jamais le rapport

Après chaque WP « vert » : `git status --porcelain` (scope exact — rien hors
périmètre), re-run du gate TOI-MÊME (exit codes réels), checkpoint commit
**ciblé** (`git add <chemins>`, `--no-verify` si hook balaye le WIP, PAS de
push). Le rapport de l'exécuteur sert à la consolidation, pas à la confiance.

## Diagnostic des turns vides / sessions « wedged »

**Avant** toute théorie sur l'état de session :
`tail ~/.hermes/logs/errors.log` (ou l'events.jsonl de la session).
Vécu : 3 modèles différents « wedged » simultanément = **OpenRouter 402
Insufficient credits** ; et `moonshotai/kimi-k2.7` = 400 invalid model id
(slug valide : `moonshotai/kimi-k2`). Symptôme identique dans les deux cas :
`[warning] empty turn — cost $null`.

- Un prompt queued n'interrompt PAS un turn ; `interrupt: true` redirige la
  session sans perdre son contexte ; `agent_kill` si vraiment mort (le code
  écrit est sur disque, on ne perd rien).
- Fallback billing quand un provider tombe : OpenRouter cheap → claude-sdk
  moonshot (kimi-k2.7-code) → claude-code `subscription` (coût marginal nul,
  Sonnet-5). Ne bloque jamais le pipeline sur un provider mort.

## STOP-si-fork : le rendre réel

Chaque brief : « fork de design non couvert → STOP et demande » + forks
probables nommés avec leur défaut. Ça marche (vécu : l'exécuteur WP0 a détecté
que le recon doc inventait des events sur `GET /events` et a proposé 3 options
au lieu de coder contre un endpoint fantôme). Quand un fork révèle une erreur
de recon : **corrige le recon doc immédiatement** (bloc CORRECTION daté) pour
que les WPs suivants n'héritent pas de l'erreur.

## Verify final — deux jambes, pas une

1. **Session Sonnet adversariale** (subscription) : re-run gates, diff des
   commits vs briefs, cohérence config/code (commandes déclarées ↔
   enregistrées 1 fois, menus ↔ contextValues), failure modes classiques des
   modèles légers (tests qui n'assertent rien, mocks masquants, rejections
   avalées). Rapporte, ne fixe pas.
2. **E2E live par toi** : petit script tsx qui importe le VRAI code (pas les
   mocks) contre le VRAI daemon. Vécu : a attrapé en 1 min un 406 MCP
   (`Accept` devait inclure `application/json, text/event-stream`) invisible
   aux 178 tests unitaires. Attention à tes propres probes : vérifie la
   signature réelle avant d'accuser le produit.

## Fin de session

Draft PR (agentproto/ts = `--draft`, merge = go de Jeremy), plans jamais
committés, et **capitalise** : chaque gotcha nouveau → memory ou amendement de
CE skill. Une session superviseur qui n'apprend rien au suivant est ratée.
