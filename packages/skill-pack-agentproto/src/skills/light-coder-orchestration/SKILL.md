---
name: light-coder-orchestration
description: >-
  Orchestrer des modèles de code "légers"/économiques (glm-5.2, deepseek-v4-pro,
  kimi, qwen… via hermes/OpenRouter, ou claude-code) depuis une session cowork
  via le daemon agentproto, avec un FILET DE VÉRIFICATION Sonnet. Déclenche ce
  skill quand l'utilisateur veut « faire coder une tâche par un modèle pas cher
  », « tester glm / deepseek / un autre modèle sur du vrai code », « lancer
  plusieurs agents en parallèle sur des WP », « babysitter un agent », ou
  industrialiser un découpage tâche → exécution modèle léger → vérif. Complète
  le skill agent-session-orchestration-agentproto en ajoutant :
  choix/branchement des modèles légers, gate vert systématique, passe de vérif
  Sonnet, parallélisme prudent, et discipline de commit.
---

# Light-coder orchestration (modèles économiques + filet Sonnet)

Méthodologie éprouvée sur un vrai projet (extraction monorepo, ~10 WP livrés
verts). **L'orchestrateur (toi, dans cowork) ne code pas** : il découpe en WP
bornés, fait exécuter par un modèle léger via agentproto, et fait **vérifier par
Sonnet**. Les modèles légers sont bons en implémentation bornée mais ont des
angles morts → la vérif Sonnet n'est pas optionnelle.

## Principe en une ligne

`brief borné → exécution (modèle léger) → gate vert (check-types/tests) → passe de vérif Sonnet → commit`

## 1. Brancher un modèle léger (hermes via OpenRouter)

- Adapters via `adapter_list`. `claude-code` et `hermes` sont en ACP.
- **hermes** route plein de modèles OpenRouter (glm-5.2, deepseek-v4-pro, kimi,
  qwen, grok, gpt-5.x…). Sélection : `agent_start(adapter:"hermes")` **puis**
  envoie `/model <id>` comme **premier prompt** — `/model` fonctionne en ACP
  hermes (≠ claude-code où `/model` est bloqué et sans param `model` au spawn).
  Vérifie la sortie : `Model switched to: … · Provider: openrouter`.
- **Prérequis daemon** : la clé du provider doit être dans l'environnement du
  **daemon** (ex. `OPENROUTER_API_KEY`) — `hermes acp` hérite de l'env du
  daemon. Symptôme si absente : « No LLM provider configured » au `/model`. (La
  sélection faite dans le TUI hermes interactif n'est PAS héritée par les
  sessions ACP.)
- grok-4.3 marche souvent par défaut (OAuth Nous, fichier
  `~/.hermes/auth.json`), les autres modèles passent par leur clé d'env.

## 2. Le brief (borné, autoportant)

Un bon brief de WP :

- **Périmètre de fichiers explicite** + interdits clairs (« ne touche pas X »).
- **Contexte récent** que le modèle ne peut pas deviner (migrations récentes,
  renommages d'API…).
- **Gate** : les commandes exactes qui doivent être vertes (`check-types`,
  `test`).
- **STOP-si-fork** : « si choix de design non trivial, STOP et demande » + nomme
  les forks probables et la valeur par défaut souhaitée.
- Demande un **compte-rendu final** : fichiers touchés, choix de design, exit
  codes.
- Avant de déléguer, colle le Brief Contract de `supervisor-session` dans
  chaque brief.

## 3. Autonome vs babysit

- **Autonome** (launch-and-leave) pour les WP à faible risque, additifs, gated
  par les tests : un seul brief complet → le modèle déroule → tu vérifies à la
  fin. C'est là qu'on voit vraiment la qualité d'un modèle.
- **Babysit** (pas-à-pas) pour le risqué/ambigu : 1 étape par tour, tu **relis
  le diff** entre chaque, puis donne l'étape suivante. Le babysitting masque les
  faiblesses du modèle (il l'empêche de partir en vrille) — utile pour livrer,
  trompeur pour évaluer.

## 4. Le filet de vérification Sonnet (à la fin) — NON optionnel

Après qu'un modèle léger rend « vert », lance une **session Sonnet (claude-code)
séparée** qui :

1. **Relance** `check-types` + `test` (exit codes réels — ne crois pas le
   compte-rendu sur parole).
2. **Cause racine** de tout échec : bug introduit par le WP vs pré-existant —
   **exige une preuve**, pas une affirmation. (N'utilise PAS `git stash` sur un
   repo partagé.)
3. **Revue de scope** : `git diff --stat` — rien hors périmètre, pas de secret.
4. **Régression** : les invariants/tests existants tiennent toujours.

Pourquoi : les modèles légers (a) écrivent parfois un **test bogué** puis
**mal-diagnostiquent** l'échec (« c'est pré-existant ») et partent en impasse ;
(b) calent sur l'**infra de test** (devDep vitest manquante, dist pas rebuild) ;
(c) peuvent **se dégrader** (format d'outil qui bave). Sonnet attrape tout ça en
quelques minutes.

## 5. Parallélisme prudent

- Lance plusieurs WP en parallèle **seulement sur des périmètres de fichiers
  disjoints**. Donne à chacun la consigne « ignore les erreurs confinées aux
  fichiers que tu ne touches pas (travail parallèle) ».
- **Point partagé inévitable** (ex. un `index.ts` de package que deux WP
  exportent) → fais une **passe de consolidation** unique (un seul writer) qui
  réconcilie et relance le gate combiné. Sans ça, le dernier writer écrase
  l'autre.

## 6. Gotchas (vécus)

- **Un prompt en file n'interrompt pas un tour en cours** → pour stopper un
  agent qui déraille, il faut le **kill**, pas lui prompter « stop ». Le code
  déjà écrit est sur disque, donc rien de perdu à killer.
- **Les sessions se font tuer par vagues** (cleanup d'env / sessions
  concurrentes) → travaille en t'appuyant sur le **disque** (vérité =
  `git status`/fichiers), pas sur l'état en mémoire d'une session.
- **Mode autonome : le modèle s'arrête souvent en chemin** → un nudge «
  continue, finis, passe le gate jusqu'au vert » suffit en général.
- **Migrations** : schéma → `db:generate` (jamais hand-écrire le `.sql`).
  Vérifie la cohérence `snapshot`/`_journal`.
- **Commit** : passe par une **session hôte** (claude-code), pas le sandbox (le
  hook husky + les perms `.git/objects` cassent dans le sandbox).
- **Repo partagé entre agents** : les `git add` larges des sessions concurrentes
  **aspirent** tes fichiers dans leurs commits → commits entremêlés. Parade :
  lance les agents en **worktree isolé**, ou stage **ciblé**
  (`git add <chemins>` jamais `-A`) + commit rapidement.
- **Ne pas committer les docs de travail/plans** sauf demande ; commit = code.

## 7. Discipline de commit

- Stage **ciblé** (chemins explicites), jamais `git add -A` sur un tree partagé.
- Exclure les `.md`/plans si l'utilisateur veut « code only ».
- Vérifier `git diff --cached --name-only` (0 fichier hors périmètre, 0 secret).
- Commit **sans push** sauf go explicite.

## 8. Choisir le modèle

- Pas de gagnant absolu parmi les légers : tous bons en impl bornée, tous
  capables d'un angle mort. **Le différenciateur, c'est le filet Sonnet**, pas
  le modèle.
- Gros contexte (ex. glm-5.2 ~1M) = utile pour les tâches qui brassent beaucoup
  de fichiers.
- Pour **livrer** vite et sûr : Sonnet exécute + Sonnet/toi vérifie. Pour
  **économiser** : modèle léger exécute + Sonnet vérifie.

## Checklist par WP

- [ ] Brief borné (périmètre, interdits, gate, STOP-si-fork, compte-rendu)
- [ ] Modèle branché (`/model` confirmé) si modèle léger
- [ ] Exécution (autonome ou babysit selon le risque)
- [ ] Nudge si arrêt prématuré
- [ ] **Passe de vérif Sonnet** (re-run gate + cause racine + scope +
      régression)
- [ ] Consolidation si périmètres partagés
- [ ] Commit ciblé (host, scoped, no push) — ou worktree isolé
