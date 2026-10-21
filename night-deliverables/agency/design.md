# Boucle d'auto-amelioration des agents (cerveau et PM)

Statut : lecture + redaction. Aucun commit, aucun push, aucune PR.

## 1. Sources etudiees

| Source | Etat | Clone |
|---|---|---|
| github.com/karpathy/autoresearch | lu (README.md, program.md, train.py) | `/home/user/work/research/autoresearch` (shallow) |
| github.com/google-research/harness2 | lu (README.md, `harness2/core/*`) | `/home/user/work/research/harness2` (shallow) |
| `projects/agentik-studio`, `rapports/harness2-et-agents-externes.md` | **absent** | aucun clone `agentik-studio` sur la machine, aucun repertoire `rapports/` trouve |

Le rapport existant demande n'a donc pas pu etre relu : il n'est pas present sur le disque. Les conclusions ci-dessous viennent de la lecture directe des deux depots et de la stack locale `agentproto/ts`.

## 2. Ce que l'on retient des deux patrons externes

### 2.1 autoresearch : la boucle autonome a metrique figee

Le patron tient en quatre ingredients :

1. **Un budget de temps fixe par experience** (5 minutes de training, inchange que l'on change l'architecture). Les experiences sont donc comparables entre elles, sinon on compare des budgets et des modeles.
2. **Un seul fichier modifiable** (`train.py`). Tout le reste est en lecture seule. Cela borne la surface de ce que l'agent peut casser.
3. **Un journal de resultats** (`results.tsv`) : commit, metrique, cout memoire, statut `keep`/`discard`/`crash`, description. C'est ce journal, et non la narration de l'agent, qui alimente la decision de la nuit suivante.
4. **Un texte de consignes unique** (`program.md`) que l'humain edite. C'est le vrai code de l'organisation de recherche : le code Python est jetable, les consignes sont le capital.

Le point cle pour nous : la qualite du systeme ne tient pas au modele mais au texte de consignes, et ce texte s'ameliore par comparaison de resultats chiffres.

### 2.2 harness2 : ameliore le harnais, pas la tache

Harness2 ameliore recursivement le *harnais* (prompts systeme, garde-fous, memoire, guidance outils, subagents, skills, scripts, plugins) autour d'un modele fige. Deux recursion :

- **recursion au niveau tache** : `Propose - Probe - Compose`. On propose des editions du harnais, on les execute sur la tache pour mesurer l'effet, puis on compose un harnais refine a partir des *contrastes de comportement* observes. La selection finale porte sur les *livrables*, harnais caches, ce qui evite de gagner par la complicatee.
- **recursion au niveau harnais** : ce qui est adopte et les lecons porteuses de preuves alimentent une **bibliotheque d'experience** par domaine, relue avant chaque tache suivante.

Quatre principes transposables, cites dans le code :

- **Le candidat adopte n'est pas la seule preuve** (`harness2/core/prompts.py`, section `THE ADOPTED CANDIDATE IS NOT THE ONLY EVIDENCE`). Un edit d'un candidat rejete peut etre le bon edit.
- **Le verdict par defaut est `confounded`** : quand un candidat change plusieurs composants a la fois et qu'aucune execution n'isole un changement, on le dit, plutot que d'inventer une causalite. Une attribution inventee empoisonne la bibliotheque.
- **La lecon est un couple `cue` / `lesson` / `evidence` / `confidence`** : le `cue` decrit une *forme de situation* pour que la lecon puisse se declencher ailleurs, pas les faits d'une tache.
- **Un registre de budget** (`harness2/core/ledger.py`) : pour un budget `k`, exactement `R = 4k` rollouts et `P = 3k` sessions d'amelioration, verifie par assertion. Une identite de budget, pas une surveillance floue.

### 2.3 Ce que nous n'empruntons pas

Nous n'empruntons pas la double recursion de harness2 a plein regime : le cout modele y est `O(k)` sessions pour un gain marginal. Nous en gardons la forme (proposer, executer, mesurer, composer) avec `k = 1` la plupart du temps, et `k = 2` uniquement quand une nuit est propre et que le budget le permet.

## 3. Architecture de la boucle

Trois roles, un cycle de 24 h, un artefact d'entree et un artefact de sortie par role.

```
        20h                     21h -> 06h                 07h                 08h
  PLANIFICATEUR (PM)      EXECUTEUR DE NUIT            MESUREUR            ADJUSTEMENT
  lit le bilan de la nuit   execute NIGHT-PLAN.md       lit les PR, les     ajuste les
  precedente, ecrit le      dans des sessions           sessions, les       consignes du
  NIGHT-PLAN.md de la      agentproto, une par tache    rapports            planificateur
  nuit, ouvre les PR       (branches, jamais merge)     produit les metriques
  ------------------------------------------------------------------------------------->
                              retour de la nuit (mesures, lecons)
```

Le boucle est **circulaire** : la sortie de l'ajustement (les consignes revisees, les lecons) est l'entree du planificateur du jour suivant. Une boucle qui ne modifie que les plans mais jamais les consignes n'apprend rien.

### 3.1 Role 1 : le planificateur (PM)

C'est le cerveau. Il ne code pas. Il :

- lit les rapports de la nuit precedente (`rapports/<date>/`) et les lecons en vigueur ;
- lit le registre de mesures (`measure.py` sur le log de PR) ;
- decompose la nuit en taches bornées : une tache = un livrable verifiable, un critere d'acceptation ecrit, une estimation d'heures-homme, un plafond de cout ;
- ecrit `nuits/<date>/NIGHT-PLAN.md` ;
- ouvre les PR (ou les fait ouvrir par l'executeur) en `ready`, jamais en `draft` sans raison.

Regle de non-regression : une tache qui n'a pas ete acceptee la veille avec un `changes_requested` ne repasse pas la nuit suivante sans correction de la cause racine ecrite dans le plan.

### 3.2 Role 2 : l'executeur de nuit

C'est le corps. Il :

- lit `NIGHT-PLAN.md` et n'execute que les taches listees (pas d'improvisation de perimetre) ;
- cree une session agentproto par tache (`agent_start`, `wait: false` pour un fan-out parallele, cf. AGENTS.md sur la serialisation de `wait: true`) ;
- travaille dans un worktree dedie (`agentproto worktree new`), branche la PR, pousse, mais **ne merge jamais** ;
- respecte le contrat `AGENTS.md` du depot : gate vert (`pnpm test` **et** `pnpm check-types`, exit code relu directement) puis PR prete ;
- note dans la PR le footer de provenance (`@agentproto-bot`), que `packages/pr-outcome` sait relire pour recuperer `cost_usd`, tokens, `sessionId`, modele.

Garde-fou du temps : chaque tache a un budget de duree. Au-dela, la session est tuee, la tache est loguee comme echouee, la nuit continue. Une nuit qui dure 30 h est une nuit ratée, pas une nuit productive.

### 3.3 Role 3 : le mesureur

Il ne juge pas la qualite du code. Il compte des faits :

- heures-homme livrees (somme des `est_hours` des taches acceptees) ;
- taux de livrables acceptes ;
- cout par livrable accepte ;
- le tout par PM et par nuit.

Il produit `rapports/<date>/mesures.md` (tableau) et `rapports/<date>/bilan.md` (lecture en une page). Il utilise `measure.py` (prototype local) et les enregistrements de `packages/pr-outcome` quand ils sont disponibles.

Point important : comme en harness2, le mesureur **compare des livrables, pas des intentions**. Une tache est acceptee si sa PR est fusionnee ou explicitement acceptee par un relecteur. Les echecs sont comptes, jamais reecrits.

## 4. Format NIGHT-PLAN.md

Format lisible par un humain et parsable par la stdlib Python (pas de YAML, pas de dependance) :

```
# NIGHT-PLAN

night: 2026-10-21
pm: alice
repo: agentproto/ts

## Tasks
| id | pm | title | deliverable | est_hours | cost_usd | pr |
|----|----|-------|-------------|-----------|----------|-----|
| T1 | alice | Rapport de nuit | rapports/2026-10-21/bilan.md | 6.0 | 1.20 | 412 |
```

Colonnes attendues par `measure.py` : `id`, `pm`, `title`, `deliverable`, `est_hours`, `cost_usd`, `pr`. Colonnes optionnelles : `night`, `status`. Une tache sans PR (ou avec `pr` a `-`) compte dans le cout prevu mais pas dans les livrables acceptes.

## 5. Ajustement des consignes

Deux niveaux, du plus local au plus global.

### 5.1 Niveau 1 : les consignes de la nuit (quotidien, automatique)

Le planificateur du matin edite trois choses :

1. **Le gabarit du plan** : quelles colonnes demander, quel niveau de decoupage, quand une tache est trop grosse. Si deux nuits de suite produisent des PR rejetees pour "perimetre trop large", la regle "une tache = un fichier ou une fonction" est ajoutee au gabarit.
2. **Le dossier de consignes de l'agent** : l'equivalent de notre `AGENTS.md` et des skills. Edition ciblee, une regle par PR rejetee, jamais une rewrite generale.
3. **Le seuil de cout et de duree** : si le cout par livrable monte, on baisse le plafond par tache ou on reduit le nombre de taches.

### 5.2 Niveau 2 : la bibliotheque de lecons (transversal, durable)

Une lecon ne descend au niveau 2 que si elle a survécu a au moins deux nuits et a ete confirmée sur un second PM. Elle est stockee au format de notre `packages/lesson` (AIP-11) : frontmatter `schema: learning/v1`, `slug`, `title`, `trigger.description` + `trigger.tags`, `outcome`, `evidence[]` (au moins une entree resolvable), `confidence`.

Traduction du triplet harness2 vers notre format :

| harness2 | chez nous | Role |
|---|---|---|
| `cue` | `trigger.description` + `trigger.tags` | forme de situation declencheuse |
| `lesson` | `title` + corps de la lecon | operation a executer, verifiable |
| `evidence` | `evidence[]` (kind + ref + note) | PR, session, rapport sur lequel elle repose |
| `confidence` | `confidence` (0..1) | valeur initiale, mise a jour par le runtime |
| composant vise | `trigger.targets[].role` / `.skill` | ou la lecon s'applique |

Regle de mise a jour issue de harness2 : `confidence` baisse quand une lecon est appliquee sans succes (`failure_count`), `success_count` monte quand elle tient. Une lecon avec un `cue` trop generique ("sois rigoureux") est rejetee a la relecture : une lecon qui ne declenche nulle part ne vaut rien, une lecon qui ne declenche qu'une fois non plus.

### 5.3 Ce qui ne change pas automatiquement

Les regles de fond (definition of done, interdiction de merge, escalade humaine) ne sont jamais editees par la boucle. Elles sont hors perimetre par construction : la boucle ajuste *comment* on travaille, pas *ce qu'on a le droit de faire*.

## 6. Mesure

`measure.py` (prototype, stdlib seule) prend :

- `--plans <dir>` : recherche recursive des `NIGHT-PLAN.md` ;
- `--pr-log <fichier>` : log de PR en JSONL (un objet par ligne) ou TSV avec en-tete.

Champs PR reconnus : `pr`, `pm`, `night`, `title`, `task`, `merged`, `accepted`, `status`, `cost_usd`.

Regles de calcul :

- **heures-homme livrees** : somme de `est_hours` des taches dont la PR est acceptee (ou dont `status` indique une livraison). Une PR hors plan compte comme livrable accepte mais avec 0 h-h : on ne peut pas inventer une estimation.
- **taux d'acceptation** : livrables acceptes / livrables, ou un livrable est une tache de plan, plus les PR sans tache correspondante.
- **cout par livrable** : cout total de la nuit / nombre de livrables acceptes. Cout d'une tache = `cost_usd` de sa PR si elle existe, sinon le `cost_usd` prevu au plan. Une PR sans tache est comptee a son propre cout.
- Le cout provient du footer `@agentproto-bot` des PR (relu par `packages/pr-outcome`) ou, a defaut, du log passe en argument.

Sortie : trois tableaux (par PM, par nuit, total) en texte, ou `--json`.

## 7. Garde-fous

| Garde-fou | Regle concrete |
|---|---|
| **Pas de deploiement** | Aucune action de deploiement, de publication, de migration en production, ni de push sur `main`. La boucle s'arrete a la PR prete. Le merge reste hors perimetre du daemon (cf. `AGENTS.md` et `scripts/agentflow/merge-gate.mjs`). |
| **Pas de depense** | Plafond par nuit et par tache, en USD, ecrit dans `NIGHT-PLAN.md` et verifie avant chaque session. Au-dela du plafond, la tache est refusee, pas "on continue un peu". Aucun achat, aucun service payant hors plafond, aucun modele premium sans accord humain. |
| **Pas d'auto-modification du harnais de garde** | La boucle ne touche ni `AGENTS.md` ni les regles de merge sans validation humaine explicite. Les edits de consignes passent par PR, donc par la revue automatique. |
| **Duree** | Budget de temps par tache. Une session qui depasse est tuee et loguee en echec. |
| **Perimetre** | L'executeur de nuit ne fait que les taches du plan. Une tache non prevue est refusee et reportee au plan suivant. |
| **Droits** | Les sessions de nuit tournent avec des droits reduits (pas d'ecriture de secrets, pas d'acces aux depots de production). |
| **Tracabilite** | Toute action de la nuit est rattachee a une session, une tache, une PR. Une action non attribuee n'est pas executee. |
| **Retour arriere** | Une consigne qui degrade le taux d'acceptation est revertie. On garde la version anterieure des consignes dans le depot, la comparaison est donc toujours possible. |

## 8. Branchement sur la stack agentproto

| Besoin | Brique existante | Usage |
|---|---|---|
| Lancer la nuit a heure fixe | `agentproto cron add --schedule "0 21 * * *" --prompt "..."`, ou `cron_create` / `cron_list` / `cron_run` | un job par role et par phase |
| Paralleliser les taches | `agent_start(wait: false)` (le `wait: true` serialise, cf. AGENTS.md) | une session par tache |
| Attendre la fin sans timer | `agentproto sessions wait <id> --until turn-end --timeout 8h` en processus detache | fan-in de la nuit |
| Gate sur etat PR | `policy_attach` avec `gh pr view --json reviewDecision` | PR fusionnee ou pas |
| Cout et provenance PR | `packages/pr-outcome` + footer `@agentproto-bot` | `cost_usd`, tokens, session |
| Lecons durables | `packages/lesson` (AIP-11, `learning/v1`) | bibliotheque de lecons |
| Rapports et plans | `rapports/<date>/`, `nuits/<date>/NIGHT-PLAN.md` | artefacts de la boucle |
| Contrat de travail | `AGENTS.md` a la racine du repo | definition of done inchangee |

Point d'attention : le daemon est lui-meme un systeme que la boucle ameliore. On applique a la boucle les memes regles qu'a nos agents : pas de modification de la machinerie de garde sans passage par une PR.

## 9. Limites connues

- Les heures-homme sont **estimees**, posees par le planificateur dans `NIGHT-PLAN.md`. Le prototype mesure donc une estimation, pas un fait. La seule facon de durcir la mesure est de calibrer `est_hours` sur des livrables deja acceptes et de le revoir quand l'ecart est grand.
- Le cout n'est known que si le footer de provenance est present sur la PR. Sans lui, le cout par livrable est sous-estimé, pas nul : le script distingue les deux cas.
- Le prototype `measure.py` ne lit pas GitHub. Il consomme un log. La collecte (via `packages/pr-outcome`) est une brique separee, ce qui garde le prototype testable hors ligne.
- Une seule nuit ne prouve rien. Les ajustements de consignes sont pris sur une seule nuit par nature; seule une tendance sur plusieurs nuits justifie un changement durable (niveau 2).

## 10. Prochaine etape proposee

1. Poser le format `NIGHT-PLAN.md` dans un workspace pilote et creer deux plans fictifs (ceux de `exemple/`) pour valider le contrat de mesure.
2. Brancher un cron de nuit sur une seule tache a faible risque, avec plafond de cout a 0.50 USD.
3. Tourner trois nuits, produire `rapports/<date>/mesures.md`, et lire la tendance avant toute automatisation de l'ajustement.
4. N'introduire le niveau 2 (lecons) qu'apres au moins cinq nuits et deux PM, sinon on encode des bruit dans des consignes permanentes.
