---
name: supervisor-session
description:
  Conduire une session SUPERVISEUR avec agentproto — l'orchestrateur (Claude,
  tokens chers) ne code pas mais garde la main. Pipeline prouvé (extension VS
  Code agentproto, 2026-07-14) - scout recon vérifié-source → SPEC + interfaces
  gelées → WP briefs disjoints → exécuteurs parallèles (modèles économiques) →
  vérif disque systématique → consolidation single-writer → verify adversarial +
  e2e live → PR (« done » lu dans l'AGENTS.md du repo, jamais recopié ici).
  Déclenche quand l'utilisateur veut "superviser au maximum en gardant la
  capacité d'agir", faire construire un livrable multi-WP par des modèles pas
  chers, ou industrialiser scout→brief→exécution→vérif→commit. Complète
  light-coder-orchestration (choix modèle + filet Sonnet) et durable-supervision
  (policies in-daemon) - ici c'est la BOUCLE OPÉRATOIRE du superviseur.
---

# Supervisor session (agentproto)

**Principe** : le superviseur tient le _plan, les contrats et la vérité disque_
; les sessions tiennent le _travail_. Tu ne codes pas — SAUF la consolidation et
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
toi                               → e2e LIVE (script tsx contre le vrai daemon) + PR (cf. AGENTS.md du repo)
```

- **WP0 fondation d'abord, seul** : il GÈLE les interfaces (client, store, ids
  de commandes). Les WP1..N codent contre ces noms sans se coordonner.
- **Fichiers partagés = à personne.** Chaque brief interdit `package.json` /
  `extension.ts` (équivalents) et exige dans le rapport final : _les lignes de
  wiring exactes + snippets de config à merger_. La consolidation (toi) les
  applique en une passe et résout les collisions (ex. deux WPs revendiquant la
  même commande → renomme l'un).
- Briefs = fichiers dans `.plans/<projet>/WPn-brief.md` ; le prompt de session
  ne contient QUE le pointeur + les overrides (no-git, no-subagents, parallel-
  aware). Rapport final imposé : fichiers touchés, choix de design, wiring
  lines, exit codes RÉELS.

## Preflight (avant tout spawn)

1. Charge le fichier d'instructions agents du repo CIBLE (pas celui-ci) — le
   « done » est déclaré là, jamais ici (même discipline qu'en Fin de session :
   ce skill pointe, il ne recopie pas).
2. `auth_profile_list` + `adapter_list` AVANT tout spawn : choisis l'auth de
   l'exécuteur depuis la MÉTHODE du profil — un provider gateway (openrouter,
   moonshot) veut un profil api-key (`access.profileRef`), jamais
   `auth:{mode:"subscription"}` (réservé Anthropic/claude-code). Fallback
   billing quand un provider est mort/flaky : OpenRouter cheap → claude-sdk
   moonshot (kimi) → claude-code `subscription` + Anthropic cheap (haiku),
   coût marginal nul. Ne bloque jamais le pipeline sur un provider mort.

## Brief Contract (à coller verbatim dans chaque brief)

Colle ce bloc tel quel en tête de chaque brief exécuteur/superviseur — c'est
ce qui fait passer la discipline jusqu'aux modèles qui ne chargent aucun
skill (hermes, OpenRouter, modèles nus). Ne le paraphrase pas, ne le traduis
pas : un copier-coller mécanique de skill/doc a déjà corrompu des faits par le
passé — ce bloc doit voyager identique à sa source.

```
- Definition of done: POINTER, never restated. Load the target repo's agent-instructions file (agentproto/ts → root AGENTS.md) and obey it verbatim: green local gate + open PR = terminal state; never `gh pr merge`; changeset written by the reviewer, not by hand; no AI attribution in commits/PR.
- Gate = exit code, never piped output: `pnpm test > /tmp/gate.log 2>&1; echo "EXIT=$?"` then grep the log. `| tail` reports tail's exit, not the gate's.
- Truth = disk, never the report. Read the actual diff; re-run the gate yourself.
- Waits are FOREGROUND/blocking, never yield-the-turn: `agentproto sessions wait <id> --until turn-end --timeout <ms>` backgrounded, or `session_monitor` (≤49s) for a quick check. A stopped agent-cli session has no timer — yielding to "wait" is a dead end.
- A wedged session (bus says awaiting-input but enqueue says mid-turn, or empty turns) → `agent_prompt interrupt:true` redirects without losing context; `agent_kill` only if truly dead (code is on disk).
- Executor auth is read from the profile's METHOD, before spawning: `auth_profile_list` + `adapter_list`. Gateway providers (openrouter/moonshot) need an api-key profile via `access.profileRef` — NOT `auth:{mode:"subscription"}`. Billing fallback when a provider is flaky/dead: OpenRouter-cheap → claude-sdk moonshot (kimi) → claude-code `subscription` + cheap Anthropic (haiku), marginal-cost-zero. Never block the pipeline on a dead provider.
```

Le premier tiret (« Definition of done ») pointe vers l'AGENTS.md du repo cible
— il ne le remplace pas ; adapte `agentproto/ts → root AGENTS.md` si le repo
cible diffère.

## Worktree natif — provisionne + spawne en UN geste

**Le DÉFAUT : ne fais JAMAIS `git worktree add` + `pnpm install` à la main.**
Passe le champ `worktree` à `agent_start` et le daemon s'en charge :

- `agent_start({ cwd: <repo cible>, worktree: { slug, base: "origin/main" } })`
  (ou `worktree: true`, slug auto-minté depuis `label`). Le daemon fait
  `git worktree add -b wt/<slug> … origin/main` **puis joue les setup hooks de
  l'`agentproto.json` du repo** (pour `agentproto/ts` : `pnpm install
  --prefer-offline` + `pnpm build`) AVANT de spawner l'adapter dedans. Donc
  install + build sont AUTOMATIQUES — zéro geste git/pnpm à la main.
- Le worktree atterrit HORS du monorepo (racine `worktrees.root` du daemon,
  défaut `~/.agentproto/worktrees/<repo>/<slug>`) — ce qui règle du même coup le
  piège « worktree sibling de `ts/` → collision de packages pnpm/turbo »
  (worktree HORS du monorepo par construction).
- **Root seulement.** Honoré uniquement pour un spawn ROOT ; un enfant spawné
  VIA cet orchestrateur hérite de l'arbre du parent (pas de second worktree) —
  ne provisionne donc PAS par-enfant. Ignoré pour un spawn `sandbox` (la box
  isole déjà). Exige un `cwd` (ou `workspaceSlug`) explicite, sinon
  `worktree_requires_explicit_repo` (pas de branche coupée au hasard sur le
  workspace actif). Une policy daemon `worktrees.isolation` (`always` / `never`,
  env `AGENTPROTO_WORKTREES_ISOLATION` > config) peut forcer/interdire
  globalement ; défaut `on-request`.
- **Teardown = à la main APRÈS merge** (le worktree n'est PAS supprimé à la
  fermeture de session) : `agentproto worktree rm|archive <path|slug>` (`rm`
  refuse si l'arbre est dirty sauf `--discard-modified/--discard-untracked` ;
  `archive` snapshot d'abord sous `~/.agentproto/worktree-salvage/`), ou
  `agentproto worktree gc --apply` pour balayer les merged+clean+idle.
- **Fallback — worktree local à TOI** (quand le superviseur veut son PROPRE
  worktree pour consolider/éditer SANS spawner d'agent) :
  `agentproto worktree new <slug> [--base origin/main]` (crée sous
  `worktrees.root`, branche `wt/<slug>`, joue les setup hooks — `--no-setup`
  pour les sauter) — PAS un `git worktree add` brut à la main.

## Protocole de spawn (hermes / modèles OpenRouter)

1. `agent_start` **idle** (pas de prompt initial !), `role: "executor"` (strip
   agent_start/agent_prompt), `cwd` = le repo cible + `worktree: { slug, base:
   "origin/main" }` (cf. section précédente — le daemon provisionne + installe ;
   pas de worktree fait main).
2. `/model <slug>` seul → attendre turn-end → **vérifier la ligne
   `Model switched to: <slug> · Provider: …`** dans agent_output.
3. Ping de vie : `Reply with exactly: READY` → turn non-vide = session saine.
4. Alors seulement, le brief.

**Pourquoi** : `/model` en prompt de spawn fait FREELANCER hermes (explore le
repo sur le modèle par défaut cher — vécu : ~$1.9 le tour pour rien). Et un turn
vide après switch ≠ session foutue : voir Diagnostic.

Pour claude-code/claude-sdk : `model` + `auth {mode:"subscription"}` (ou
`mode:"moonshot"` + kimi) **et `worktree`** se pinnent AU SPAWN — pas de danse
/model, le brief peut partir dans le prompt initial.

## Monitoring (économe en tokens superviseur)

- Quick check : `session_monitor` (≤49s), fan-in via `sessionIds: [...]`.
- Attente longue :
  `npx agentproto sessions wait <id> --until turn-end --timeout 2400000`
  **backgroundé** (piège vécu : timeout en **ms** — `900` = 900 ms). Fan-in :
  une boucle `for s in …; do wait; done` dans UN SEUL background task.
- Ne JAMAIS lire tout l'output : `agent_output clean lastN 40-60` après
  turn-end, c'est tout.

## Vérité = disque, jamais le rapport

Après chaque WP « vert » : `git status --porcelain` (scope exact — rien hors
périmètre), re-run du gate TOI-MÊME (exit codes réels), checkpoint commit
**ciblé** (`git add <chemins>`, `--no-verify` si hook balaye le WIP, PAS de
push). Le rapport de l'exécuteur sert à la consolidation, pas à la confiance.

## Diagnostic des turns vides / sessions « wedged »

**Avant** toute théorie sur l'état de session : `tail ~/.hermes/logs/errors.log`
(ou l'events.jsonl de la session). Vécu : 3 modèles différents « wedged »
simultanément = **OpenRouter 402 Insufficient credits** ; et
`moonshotai/kimi-k2.7` = 400 invalid model id (slug valide :
`moonshotai/kimi-k2`). Symptôme identique dans les deux cas :
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
au lieu de coder contre un endpoint fantôme). Quand un fork révèle une erreur de
recon : **corrige le recon doc immédiatement** (bloc CORRECTION daté) pour que
les WPs suivants n'héritent pas de l'erreur.

## Verify final — deux jambes, pas une

1. **Session Sonnet adversariale** (subscription) : re-run gates, diff des
   commits vs briefs, cohérence config/code (commandes déclarées ↔ enregistrées
   1 fois, menus ↔ contextValues), failure modes classiques des modèles légers
   (tests qui n'assertent rien, mocks masquants, rejections avalées). Rapporte,
   ne fixe pas.
2. **E2E live par toi** : petit script tsx qui importe le VRAI code (pas les
   mocks) contre le VRAI daemon. Vécu : a attrapé en 1 min un 406 MCP (`Accept`
   devait inclure `application/json, text/event-stream`) invisible aux 178 tests
   unitaires. Attention à tes propres probes : vérifie la signature réelle avant
   d'accuser le produit.

## Fin de session

**Le « done » est déclaré par le repo, pas par ce skill.** Charge le fichier
d'instructions agents du repo cible et applique-le tel quel — pour
`agentproto/ts` c'est `AGENTS.md` à la racine (gate vert + PR ouverte = état
terminal ; `gh pr merge` jamais ; changeset écrit par le reviewer, pas à la
main). Ne recopie **pas** la règle ici : ce paragraphe a dit `--draft` pendant
que le repo était passé à _ready_, et le superviseur du 2026-07-15 a forcé
`--draft` sur toute une série de PRs en se fiant à ce skill plutôt qu'à la
source. Un skill qui _restate_ une règle versionnée ailleurs devient un menteur
à la première évolution — il **pointe**, il ne recopie pas (cf. le même fix
appliqué à `CLAUDE.md` → `@AGENTS.md`).

Plans jamais committés, et **capitalise** : chaque gotcha nouveau → memory ou
amendement de CE skill. Une session superviseur qui n'apprend rien au suivant
est ratée.

**Chaque session lancée a un terminus.** launched → settled → cleaned. Au
turn-end : lis la sortie, vérifie le disque, puis `agent_kill`. Une session
`running`+idle qu'on garde « au cas où » est un orphelin — le 2026-07-15 : 35
sessions lancées, 0 sorties propres. Ne poll pas à la main : `policy_attach`
(in-daemon, cf. `durable-supervision`) puis `agentproto policy wait <id>` en
tâche de fond bloquante — c'est ça, le « push » côté superviseur.
