# TACHE 17 - Controle fin des harnais, politique de prereglages et routeur de modele

Document de lecture seule cote daemon : aucun code de production n est modifie
ici. Reference : etat de `origin/main` au commit `fb025f0b` (feat(sandbox):
reap orphan computer boxes in sandbox gc (#2164)).

Branche du plan : `night/t17-harnais-routeur`. Plan lie lu pour cette tache :
`night-deliverables/agent-presets/PLAN-r2.md`, branche
`origin/night/t16-agent-presets-swap-r2` (TACHE 16 r2, bot de bascule et
presets). Cette branche est laissee dans le clone pour l analyse ; le present
document ne la modifie pas.

Trois sujets lies, dans cet ordre :

- (a) une liste de harnais ACTIVES (globale puis par workspace), ce qu elle
  masque et ce qu elle INTERDIT reellement au lancement ;
- (b) une politique globale "prereglages seulement" ou "tout permis" ;
- (c) un routeur de modele (middleware) dans l esprit du classifieur Jev.

## 0. Sommaire

1. [Method et perimetre](#1-method-et-perimetre)
2. [Sujet (a) - la liste des harnais actives](#2-sujet-a--la-liste-des-harnais-actives)
3. [Sujet (b) - prereglages seulement ou tout permis](#3-sujet-b--prereglages-seulement-ou-tout-permis)
4. [Sujet (c) - le routeur de modele](#4-sujet-c--le-routeur-de-modele)
5. [Design minimal](#5-design-minimal)
6. [Decoupage en PR](#6-decoupage-en-pr)
7. [Risques](#7-risques)
8. [Decisions a trancher](#8-decisions-a-trancher)
9. [Sources consultees](#9-sources-consultees)

## 1. Method et perimetre

Lecture seule : aucun fichier de `packages/**` n est touche. Le livrable est ce
document. La branche `night/t17-harnais-routeur` part de `origin/main`.

Trois lectures de reference croisees :

- `origin/night/t16-agent-presets-swap-r2` : `PLAN-r2.md` (presets, harnais par
  defaut, bot de bascule). C est le plan auquel (b) et (c) se recoupent.
- `origin/night/t16-agent-presets-swap` : `PLAN.md` (plan v1).
- `origin/night/t15-agent-identity-plan` : identite d agent stable, cite par
  le plan r2.

Trois notions sontEmployees dans ce document et ne doivent pas etre confondues :

| Notion | Ce que c est | Ou |
| --- | --- | --- |
| harnais (adapter) | le CLI agent qu on lance (opencode, claude-code, hermes, ...) | `adapters/<slug>/`, `packages/provider-kit` |
| prereglage (preset) | un paquet d axes de spawn (harnais + modele + wallet + ...) | `~/.agentproto/presets.json` (user) et `~/.agentproto/harness-presets.json` (defaut par harnais) |
| profil d acces (wallet) | la credentiel qui facture | `~/.agentproto/auth-profiles.json`, type `AuthProfile` |

Le mot "harnais" designe ici l adapter CLI, comme dans le reste du code
(`adapterSlug`, `harness`).

## 2. Sujet (a) - la liste des harnais actives

### 2.1 Etat des lieux : comment les adapters installs sont decouverts

Le chemin de decouverte est court et il n'y a aucun filtre :

1. `packages/provider-kit/src/discover.ts` : marche de `node_modules` a la
   recherche de `@agentproto/adapter-<slug>` (premiere partie) et
   `@<scope>/agentproto-adapter-<slug>` (troisieme partie). Dedoublonne par
   slug, la premiere partie gagne. Ne leve jamais.
2. `packages/provider-kit/src/list-resolve.ts:89` `makeAdapterLister` : le
   moteur de statut. Le statut (`ready`, `available`, `supported`,
   `unresolvable`) vient de la resolvabilite + du ledger de setup + de la
   presence des credentials. Par defaut, `handle.check()` n est PAS appele
   (OQ-5) : le statut est un etat d installation, pas un etat de sante du
   binaire.
3. `packages/cli/src/registry/resolve.ts:935` `listInstalledAdapters` et
   `:1261` `listAdaptersWithCatalog` (qui adjoint les modeles du catalogue au
   modele declare par l adapter).
4. `packages/runtime/src/http-server.ts` : type `AgentAdapterLister`
   (`:828`), branche dans le daemon.

Conclusion d etat des lieux : la liste des adapters est une consequence de ce
qui est installe sur le disque. Elle n est stockee nulle part, donc elle n est
ni activable, ni desactivable, ni restreignable.

### 2.2 Etat des lieux : ou la liste apparait aujourd hui

Toutes ces surfaces rendent la MEME liste, non filtree. C est le probleme
pose : "tous les adapters installes apparaissent partout".

| Surface | Point d entree | Code |
| --- | --- | --- |
| Outil MCP `adapter_list` | lister les adapters installes | `packages/runtime/src/agent-tools.ts:1697` |
| Outil MCP `adapter_models` | modeles d un adapter | `packages/runtime/src/agent-tools.ts:1746` |
| Outil MCP `harness_capabilities` | introspection d un adapter | `packages/runtime/src/agent-tools.ts:1780` |
| REST `GET /adapters` | idem pour les clients HTTP | `packages/runtime/src/http-server.ts` |
| VS Code, arbre Harnesses | `client.listAdapters()` | `packages/vscode/src/views/harnessesTree.ts:45` |
| VS Code, tri et actions de l arbre | `sortAdapters`, `canInstallHarness` | `packages/vscode/src/views/harnessesTree.logic.ts:27` et `:40` |
| VS Code, panneau webview Harnesses | `listAdaptersWithStatus()` | `packages/vscode/src/webview/harnessesWebviewPanel.ts:127` |
| VS Code, assistant de spawn (picker) | `client.listAdapters()` | `packages/vscode/src/commands/spawn.ts:108` |
| VS Code, Configuration Lab | `fetchers.listAdapters()` | `packages/vscode/src/commands/configurationLab.logic.ts:704` |
| VS Code, Auth Explorer | `listAdaptersWithStatus()` | `packages/vscode/src/webview/authExplorerPanel.ts:103` |
| VS Code, Auth Model Mindmap | `listAdaptersWithStatus()` | `packages/vscode/src/webview/authModelMindmapPanel.ts:78` |
| App UIs (session-chat, Pygmalion, ...) | picker `mountRunnerSelect` | `packages/app-client/src/runner-select.ts:24` (`APP_UI_DISCOVERY_TOOLS = ["adapter_list", "harness_preset_list"]`) |
| CLI `agentproto harness outdated/check/upgrade` | parcourt les adapters installes | `packages/cli/src/commands/harness.ts`, `packages/cli/src/registry/harness.ts:530` |

Deux points de vigilance :

- le picker `runner-select` des app UIs est le "selecteur session-chat" du
  besoin. Il lit `adapter_list` + `harness_preset_list` par appel d outil
  MCP. Filtrer `adapter_list` le filtre donc automatiquement, sans toucher au
  script injecte ;
- l arbre Harnesses et le panneau webview affichent aussi les adaptateurs non
  installes ("supported"), avec une action "Install". Une liste d activation
  ne doit pas supprimer la possibilite d installer un harnais : elle doit
  masquer le harnais de la liste de LANCEMENT, pas sa fiche.

### 2.3 Etat des lieux : ce que le daemon controle au lancement

Aujourd hui, un `agent_start` peut nommer n importe quel adapter resolvable.
Le seul controle daemon au lancement est la resolvabilite :

- `packages/runtime/src/session-spawn.ts:3522` : `resolveAgentAdapter(input.adapter)`
  ; si la resolution echoue, `adapter_not_found` (`:3569`) avec des indices
  actionnables (slug d un profil d acces, slug d une passerelle, liste des
  adapters installes).
- `packages/runtime/src/http-server.ts:6081` et `:7052` : `adapter_not_found`
  est mappe en 404.
- cron : `packages/runtime/src/cron-scheduler.ts` verifie la resolvabilite de
  l adapter a la CREATION du cron (`assertCronAdapterResolvable`), mais le
  controle de l adapter au TIR passe par le meme `spawnAgentSession`.

Verdict : une liste d harnais actifs n a AUCUNE prise sur le daemon aujourd
hui. Elle est purement cosmetique tant qu un controle de refus n est pas
ajoute.

C est la distinction centrale du sujet (a) : **masquer n est pas interdire**.
Une liste stockee et lue par les surfaces de listing ne change rien a ce que
le daemon accepte de lancer.

### 2.4 Ce que la liste masque

Trois familles d effets, a distinguer :

1. **Listes de choix (UI)** : arbre Harnesses, panneau webview, picker de
   spawn, Configuration Lab, runner-select des app UIs. Un harnais non actif
   disparait (ou passe en fin de liste, grise) dans ces listes.
2. **Catalogues et inventaires** : `listAdaptersWithCatalog` rattache les
   modeles du catalogue aux adapters ; l inventaire de capacites
   (`packages/runtime/src/capabilities-inventory.ts:491`) agrege par harnais ;
   le rollout d usage (`packages/runtime/src/usage-rollup.ts`) agrege par
   harnais (`byHarness`). Attention : le "catalogue" du modele
   (`packages/model-catalog`) est un catalogue de MODELES, pas d adapters. Une
   liste d harnais actifs ne doit pas retirer des modeles du catalogue : elle
   retire des ADRAPTERS des listes, et les modeles restent lisibles via
   `adapter_models` pour un adapter installe mais inactif (diagnostic) ou
   via le catalogue de modeles.
3. **Presets** : un preset qui pointe un harnais non actif devient
   inexploitable. Today, le daemon sait deja detecter le cas voisin (preset
   de harnais dont le PROFIL a disparu ou est desactive) et refuse avec
   `harness_preset_profile_unavailable` (`session-spawn.ts:2170-2185`). Le cas
   miroir (preset dont le HARNais est inactif) n existe pas.

### 2.5 Ce que la liste INTERDIT reellement au lancement

Trois niveaux possibles, du plus faible au plus fort. Le niveau 2 est le
minimum utile, le niveau 3 est un controle de securite qui doit etre
decide explicitement.

| Niveau | Effet | Cout | Point d insertion |
| --- | --- | --- | --- |
| 1. Filtrage de listing | les listes UI n offerent plus le harnais | faible, aucun risque | cote lister (`adapter_list`, `GET /adapters`) |
| 2. Refus explicite | un `agent_start` vers un harnais inactif echoue (400) avec un code dedie | moyen | `spawnAgentSession`, avant la resolution d adapter (`session-spawn.ts`, avant `:3522`) |
| 3. Substitution | le daemon remplace le harnais demande par le harnais actif par defaut | eleve (changement de facture et de comportement, silencieux) | idem, mais AVEC journalisation |

Regle de conception retenue : le niveau 2 est **fail-loud** (on refuse, on ne
substitue pas). La substitution silencieuse est un changement de wallet deguise
et le plan r2 le refuse explicitement pour les presets (section 10, point 1 de
`PLAN-r2.md` : "un prereglage qui change de wallet sans controle").

Un niveau 2 impose de traiter TOUTES les entrees de lancement, pas seulement
`agent_start` :

| Entree | Chemin | Today |
| --- | --- | --- |
| MCP `agent_start` | `packages/runtime/src/agent-tools.ts:443` -> `spawnAgentSession` | passe par le coeur commun |
| REST `POST /sessions/agent` | `packages/runtime/src/http-server.ts:6919` | passe par le coeur commun |
| REST `POST /sessions/chat` | `packages/runtime/src/http-server.ts:7013` | passe par le coeur commun |
| Cron `kind: "agent"` | `packages/runtime/src/cron-scheduler.ts:1057` | passe par le coeur commun |
| CLI `agentproto sessions` | `packages/cli/src/commands/sessions.ts:1126` | passe par le coeur commun |
| VS Code | `packages/vscode/src/commands/spawn.ts:243` | passe par le coeur commun |
| Box daemon (spawn dans un sandbox) | forwarding du host | a traiter : le controle est dans le daemon qui spawn, donc la box herite du controle du host |

Le coeur commun est `spawnAgentSession` : un seul point de controle suffit
pour le niveau 2. Le point de controle des crons a la creation
(`assertCronAdapterResolvable`) gagne en outre le controle de l activation,
pour ne pas creer un cron qui echouera a chaque tir.

### 2.6 Ou la stocker

Trois emplacements candidats, un par principe.

| Emplacement | Fichier | Pour | Contre |
| --- | --- | --- | --- |
| A. config du daemon | `~/.agentproto/config.json` (chemin : `packages/runtime/src/config.ts:781`) | c est un REGLAGE global, pas une donnee de pointeur ; la config a deja une section par sujet (`models`, `spawn`, `defaults`, `catalog`, ...) ; le schema de validation existe (`packages/runtime/src/config-schema.ts`, registre `CONFIG_KEYS`) | fichier unique, ecrit en entier a chaque modification |
| B. fichier dedie | `~/.agentproto/harnesses.json` | isole la liste du reste de la config ; format libre | cree un cinquieme store pour une liste de slugs ; rien ne l explique dans la config globale |
| C. `harness-presets.json` | `~/.agentproto/harness-presets.json` | deja un store harnais | ce store lie harnais -> profil et modele, avec des invariants de profile ; y melanger une liste d activation casse son modele |

Retenu : **A pour le global**, avec la meme cle de section que les autres
reglages de spawn, et une surcharge par workspace.

- Global : `~/.agentproto/config.json`, section `harnesses` (ou `spawn.harnesses`
  si on veut rester dans la section `spawn` qui porte deja les defauts de
  spawn). La cle doit etre declaree dans `CONFIG_KEYS`
  (`packages/runtime/src/config-schema.ts`), sinon le test de derive
  `findUnclassifiedConfigPaths` (`config-schema.ts:1655`) echoue.
- Par workspace : `<repo>/agentproto.json`, section `harnesses`. C est la
  convention deja etablie pour la couche workspace : le model-role y lit son
  bloc `models` (`packages/runtime/src/model-roles-tools.ts:72`,
  `loadWorkspaceModels`). Meme convention, meme precedence workspace >
  daemon.
- Le store `harness-presets.json` reste intact : il porte les bindings
  harnais -> profil, pas l activation.

Precedence retenue, alignee sur `resolveModelRole` (`model-roles.ts:169`) :
explicite (requete) > workspace > daemon > defaut.

### 2.7 Forme de la liste

Trois formes possibles, avec des consequences tres differentes :

1. **Allowlist stricte** : `harnesses: { active: ["opencode", "claude-code"] }`.
   Tout adapter absent est inactif. Sur : controle maximal. Contre : un adapter
   que l operateur installe n est jamais propose, et l operateur doit
   maintenir la liste a la main.
2. **Liste d exclusions** : `harnesses: { disabled: ["hermes"] }`. Tout est actif
   sauf ce qui est cite. Sur : pas de maintenance. Contre : une liste
   d exclusions n est pas un controle, et ne dit rien de ce qui est
   reellement autorise.
3. **Liste d activation explicite avec defaut** : `harnesses: { mode: "all" | "list", active: [...] }`.
   `mode: "all"` = comportement actuel (retrocompatible), `mode: "list"` =
   allowlist stricte. Le defaut du daemon est `mode: "all"`.

Retenu pour le design : la forme 3, avec `mode: "all"` par defaut. Elle
permet le mode strict sans casser les installs existants, et elle rend
explicite la difference entre "je n ai rien configure" et "j ai tout ferme".
Le cas "liste presente mais vide" est un piege : en mode `list`, une liste
vide doit signifier "aucun harnais actif" et non "tous actifs". A trancher
(cf. section 8).

### 2.8 Effet sur les presets et les roles

Deux consequences a traiter dans le meme PR que la liste, sinon on laisse des
etats incoherents :

- un **preset de harnais** (`harness-presets.json`) dont le `harnessSlug` est
  inactif doit etre signale. Le code d erreur existant
  `harness_preset_profile_unavailable` est le modele : on ajoute
  `harness_preset_harness_inactive`, lu au spawn comme au listing
  (`harness_preset_list` peut alors exposer un `harnessInactive` par ligne,
  comme il expose deja `profileDisabled`).
- un **role de modele** (`model-roles.ts`) qui impose un adapter via
  `adapterForModelId` (`model-roles.ts:107`) doit pouvoir etre incoherent avec la liste
  active (par exemple `review.small` = `opencode-go/...` alors que `opencode`
  est inactif). Le role doit alors resoudre sur un harnais actif equivalent ou
  le signaler.

## 3. Sujet (b) - prereglages seulement ou tout permis

### 3.1 Ce que le daemon controle DEJA

Le daemon n est pas depourvu de controles de facturation. Il en a cinq, de
forces inegales.

| Controle | Portee | Code | Force |
| --- | --- | --- | --- |
| Allowlist de modeles par profil | tout modele facture par ce profil | `AuthProfile.models` (curation), `packages/auth/src/profile-types.ts:130` ; intersection dans la jointure catalogue ; verifiee a l ecriture d un preset par `profileServicesModel` (`harness-preset-store.ts:159`) | forte : un modele hors allowlist n est pas facturable |
| Eligibilite du profil | profil inconnu, desactive, route incompatible | `eligibleProfiles` (`packages/auth/src/eligibility.ts:84`), `resolveAccessProfileAuth` (`session-spawn.ts:651`), codes `access_profile_not_found`, `access_profile_ineligible` (`session-spawn.ts:710`, `:764`, `:864`, `:3580`) | forte |
| Defaults par harnais | harnais -> profil + modele | `~/.agentproto/harness-presets.json`, `harness_preset_list/create/delete/set_default` (`packages/runtime/src/harness-preset-tools.ts`) ; applique au spawn en derniere couche de precedence (`session-spawn.ts:2169`) | moyenne : c est un DEFAUT, contournable |
| Presets utilisateur | axes complets de spawn | `~/.agentproto/presets.json` (`packages/runtime/src/user-presets.ts:35`), `presetId` de `agent_start` (`agent-tools.ts:443`), CLI `agentproto preset`, REST `/user-presets` | faible : c est une commodite de nommage, pas un controle |
| "Free reste free" | rotation de modele | `isOpencodeFreeModel`, `validateTurnRetryRotate` (`packages/runtime/src/turn-retry-policy.ts:143` et `:150`) ; le wallet ne change jamais par rotation (`rotationTargetRejection`, `packages/runtime/src/turn-retry.ts:396`) | forte, mais limitee a la rotation |

S y ajoute une precedente tres proche du besoin : le profil d EXECUTION du
workflow de decision (`packages/runtime/src/decision-profile.ts`).

- `validateSpawnTarget` (`:186`) : controle fail-closed d un triplet
  (adapter, modele) contre un entitlement (`free-only` ou `subscription`),
  y compris CHAQUE cible de `turnRetry.rotate`. Un modele sans adapter
  explicite est refuse ("a harness default is dynamic identity, refused").
  Une route explicite est refusee sous `free-only`.
- `resolveAndValidateTarget` (`:241`) : resout un preset (harnais OU user) ou
  un role, puis controle ce qui serait REELLEMENT lance, y compris le profil
  de default de harnais qu un spawn nu heriterait, puis applique le garde
  OpenRouter.

C est le modele a recopier pour (b) : une politique de spawn evaluee sur le
triplet CONCRET qui va tourner, fail-closed, et appliquee au coeur commun du
spawn.

Ce que le daemon NE controle pas aujourd hui : **rien n impose qu un
lancement passe par un preset**. `agent_start` accepte un adapter libre, un
modele libre, un `access.profileRefs` libre. La seule chose qui lie un spawn
a un preset, c est que le caller en donne l id.

### 3.2 La regle proposee

Une regle globale, puis surchargeable par workspace, avec trois etats. Elle
repond a la question "ce lancement DOIT-IL passer par un preset, ou peut-il
nommer librement adapter, profil et modele".

| Etat | Ce qui est autorise au lancement | Ce qui est refuse |
| --- | --- | --- |
| `free` (defaut) | tout : adapter libre, modele libre, profil libre | rien de plus que les controles existants (allowlist du profil, eligibilite, free-stays-free) |
| `default-harness` | nommer un `presetId`, ou nommer un adapter sans modele ni profil (le daemon applique le defaut de harnais pour le modele et le wallet) | un modele ou un profil nomme a la main qui n est pas celui du preset vise ; un adapter sans preset ni defaut de harnais |
| `presets-only` | nommer un `presetId`, ou ne nommer ni adapter, ni modele, ni profil (le defaut de harnais s applique) | tout nommage libre d adapter, de modele ou de profil ; un `presetId` inconnu ; un preset qui viole la policy (cf. plus bas) |

Trois lectures de la regle qui doivent etre explicites :

1. **La regle porte sur le RESULTAT, pas sur la SYNTAXE.** Under
   `presets-only`, un `agent_start` avec `adapter: "opencode"` et rien d autre
   est-il permis ? Il depend du sens : si le harness `opencode` a un preset
   par defaut, le resultat est deterministe, donc permis ; sinon il est
   indetermine (le wallet ambiant), donc refuse. C est la formulation
   retenue : la regle porte sur le triplet resolu, pas sur les champs nommes.
2. **Le preset peut lui-meme violer la policy.** Under `presets-only` avec une
   regle de cout stricte, un preset paye ne doit pas passer. Reponse proposee :
   fail-closed, la policy gagne sur le preset, et le refus nomme la policy ET
   le preset.
3. **La regle est globale, jamais par session.** Conformement a la demande de
   Jeremy, la regle vit dans la config du daemon, avec une surcharge par
   workspace. Elle ne vit PAS dans le descripteur de session (ce serait du
   session-par-session), ni dans un preset (un preset ne pourrait pas
   s auto-appliquer).

### 3.3 Ou la placer

| Emplacement | Pour | Contre |
| --- | --- | --- |
| Dans `spawnAgentSession` (au coeur des couches de precedence) | un seul point, toutes les entrees convergent (MCP, REST, cron, CLI, VS Code, box) ; le triplet est deja resolu a cet endroit | le coeur est deja long (6800 lignes) ; le controle doit etre extractible |
| Dans l outil `agent_start` seul | rapide | les autres entrees (REST, cron) contournent |
| En politique de governance attachee a la session (`packages/policy`) | mecanisme existant, ports et budgets | une politique de session agit APRES le spawn ; elle ne peut pas interdire un choix de modele au moment du lancemement |

Retenu : **au coeur du spawn**, dans une fonction pure et testable, appelee
apres la resolution des couches de precedence (preset utilisateur vers
`session-spawn.ts:2136`, defaut de harnais vers `:2169`) et AVANT la
resolution de l adapter et de l auth (`:3522` et apres), pour que le refus
soit tot, explicite et sans effet de bord.

Emplacement concret propose : un module pur `packages/runtime/src/preset-policy.ts`
(validation de la politique contre un triplet resolu) plus un point de
branchement dans `spawnAgentSession`, avec un code d erreur dedie (propose :
`preset_policy_violation`), mappe en 400 dans `http-server.ts` (a cote des
`access_profile_ineligible` deja traites en `:6097` et `:7066`).

### 3.4 Ce que la politique ne doit pas faire

- **Pas de substitution.** Refuser, pas remplacer par le preset. Une
  substitution silencieuse changerait de wallet sans que personne l ait
  demande, ce que le plan r2 refuse pour les presets (section 10).
- **Pas de controle par le client.** La regle est evaluee par le daemon, sur
  le triplet resolu. Un caller qui nomme `presetId` n est pas plus soumis
  qu un caller qui nomme un adapter.
- **Pas de double source de verite.** Une regle dans `config.json` ET une
  regle dans `presets.json` feraient drift. La regle vit dans la config, les
  presets ne portent que des valeurs.
- **Pas d application aux sessions de decision** sans decision explicite :
  le workflow de decision a son propre profil d execution
  (`decision-profile.ts`), plus strict que `free`. Deux politiques qui se
  contredisent doivent avoir une regle decedence ecrite.

### 3.5 Interaction avec les harnais actifs (sujet (a))

Les deux sujets se combinent naturally :

- la liste d harnais actifs repond a "quels harnais peuvent etre lances" ;
- la politique de preset repond a "quels CHOIX peuvent etre nommes a la main".

Combinaison :

| | `free` | `default-harness` | `presets-only` |
| --- | --- | --- | --- |
| harnais non actif | refuse | refuse | refuse |
| preset nomme | applique | applique | applique (et valide contre la policy) |

## 4. Sujet (c) - le routeur de modele

### 4.1 Ce qui existe deja, et ce qui ne va pas dans la meme boite

Cinq briques proches, de nature tres differente. Le routeur doit s asseoir
par-dessus, pas les remplacer.

**(1) `@agentproto/model-routing` (AIP-57)** est une primitive PURE de
resolution de cle vers une route, par couches (`override` > `env` > `pack`),
avec une semantique de gate (`null` = indisponible, un catch-all ne peut pas
re-enabler une cle gated). `resolve` (`packages/model-routing/src/resolve.ts`)
ne fait AUCUNE IO : ni horloge, ni aleatoire, ni reseau. C est la brique de bas
niveau, ce n est PAS un routeur de choix de modele : il ne connait ni la
tache, ni le quota, ni le cout, ni la sante des cles. Il resout une cle que
quelqu un d autre a decidee.

**(2) `turnRetry.rotate`** est une rotation APRES echec d un tour, portee a
une session, sur le profil COURANT (jamais de changement de wallet,
`rotationTargetRejection`, `packages/runtime/src/turn-retry.ts:396`), avec
"free reste free" (`turn-retry-policy.ts:150`) et une carte de refroidissement
daemon-wide par modele (`model-cooldowns.ts`). C est un filet, pas un
choix.

**(3) Les roles de modele et leurs presets (PR #1892)** sont une table
nommee : `review.small`, `review.large`, `review.pr`, `judge.session`, avec
des presets `opus`, `sonnet`, `haiku`, `go-free`, `free-sonnet`
(`packages/runtime/src/model-roles.ts:72`) et une precedence
input > workspace > daemon > preset > default (`:169`). C est une
ENTREE pour le routeur (une tache de relecture mappe sur un role), pas une
sortie du routeur pour les sessions de travail.

**(4) Le classifieur Jev** est le precedent a recopier. `packages/runtime/src/jev-client.ts` :
un appel `SystemOne` avec UNE question, des criteres, un ensemble ferme de
choix, et une reponse typee (`choice`, `confidence`, `probabilities`). Les
criteres sont ecrits en clair (`WRAPUP_VERDICT_CRITERIA`, `:226`). Le refus est
explicite : une reponse hors ensemble ferme, sans confiance exploitable, ou un
transport en echec donnent `{ ok: false }` et l appelant CHOIT (le workflow de
decision, `decision-workflow-tools.ts:303` ; le session-steward,
`judgeSessionWithJev`, `jev-client.ts:280`). Le profil d execution porte un
interrupteur `jev: { enabled, timeoutMs }` (`decision-profile.ts:57`), desactive
par defaut sur le profil gratuit. C est exactement la discipline a appliquer a
un routeur : un classifieur doit pouvoir dire "je ne sais pas".

**(5) La sante des profils et le cout** sont deja lus par des modules
dedies, tous "best-effort" et tous bornants par la meme discipline : une
valeur inconnue vaut `undefined`, jamais un zero fabrique.

| Signal | Module | Forme |
| --- | --- | --- |
| quota live d un profil | `packages/runtime/src/quota-status-tool.ts:94` (`readQuotaStatus`), lecteurs OpenRouter/Moonshot de `@agentproto/model-intel` | `{ window, remainingPct, resetsAt }`, ou un negatif explicite (`profile_not_found`, `no_reader`) |
| quota glissant Anthropic (5h/7d) | `packages/runtime/src/remaining-quota.ts` + `remaining-quota-store.ts` (`~/.agentproto/usage-quota.json`) | `RemainingQuota` (basis `provider`), derniere valeur vue |
| credits prepayes | `packages/runtime/src/account-credits.ts` | `{ balanceUsd, basis: "provider" }`, `undefined` si inconnu |
| cout deja depense | `packages/runtime/src/usage-rollup.ts:249` (`rollupUsage`) | `spentUsd` par profil, par modele, par harnais, sur une fenetre |
| plafond de depense | `AuthProfile.costBudget` (`packages/auth/src/profile-types.ts:137`), `agent_start.costBudget` | fenetre + scope (`session` ou `profile`) ; declenche `policy:failed`, ne tue pas |
| plafond de session | `agent_start.maxCostUsd` | arret au tour suivant |
| etat du profil | `packages/auth/src/eligibility.ts:84` | profil desactive, routes, methode ; credential resoluble via le keychain |
| expiration de cle | **absente** | angle mort deja signale par le plan r2 (section 13.4) : rien ne dit "cette cle expire le 21/10" avant l echec |

### 4.2 Ou il se branche : trois points d accroche compares

| Point d accroche | Ce qu il voit | Ce qu il decide | Avantages | Inconvenients |
| --- | --- | --- | --- | --- |
| **A. Avant `agent_start`**, dans `spawnAgentSession` | le prompt initial (parfois), la config, les quotas, le cout | adapter + modele + profil | un seul point de decision, avant tout cout | la "tache" n est visible que si le caller a donne un prompt ; un cron n en a pas |
| **B. Dans le choix du preset** (la ou le defaut de harnais est lu, `session-spawn.ts:2169`) | la liste des presets, l etat de sante des profils, la tache | QUEL preset appliquer (donc harnais + modele + wallet) | s insere exactement la ou la decision est deja prise ; le preset porte deja harnais, modele, profil et `turnRetry` ; le plan r2 y loge deja le "defaut de harnais" | ne s applique qu aux spawns sans `presetId` ; un caller qui nomme un preset ecrase le routeur |
| **C. Par tour** (dans le controleur de `turnRetry`) | le transcript, l etat du tour, l erreur ou non | un re-route du modele entre deux tours | voit l etat reel de la conversation ; peut anticiper la rotation | changement de modele en cours de conversation, limite par `models.apply` de l adapter (`arg` vs `config`) ; ne voit pas la tache, seulement l etat du tour |

Recommandation : **B en point principal, A en repli, C seulement comme
extension a froid** declenchee par le bot de bascule du plan r2 (section 13),
pas par le routeur lui-meme.

Pourquoi B : c est le point ou le daemon doit DEJA choisir un triplet quand
le caller n en nomme aucun. Le routeur ne cree pas une nouvelle decision, il
remplace une decision statique (`getDefaultHarnessPreset` : le premier preset
marque default) par une decision argumentee. La signature de sortie reste la
meme, donc le reste du daemon ne bouge pas.

Pourquoi A en repli : quand aucun preset par defaut n existe pour le harnais
demande, le daemon laisse le modele ambiant. Le routeur peut proposer un
choix explicite, mais seulement parmi des cibles declarees.

Pourquoi C en retrait : le routeur par tour se recoupe avec `turnRetry.rotate`
(qui fait deja une rotation post-erreur) et avec la limite `models.apply`
des adapters (un adapter en mode `arg` ne peut pas changer de modele a chaud :
`packages/vscode/src/commands/spawn.logic.ts` le dit pour les pickers, et le
meme contrainte vaut cote daemon).

### 4.3 Ce que le routeur lit

Quatre familles d entrees, dans cet ordre de decreasing fiabilite.

1. **La tache** (classifieur Jev). Une question fermee, du type
   `typeTache ∈ { code, relecture, recherche, redaction, surveillance,
   administration }`, plus une taille (contexte, nombre de fichiers, nature du
   prompt) et une sensibilite (le code du client ne sort pas du host : pas de
   rail externe pour un depot prive ; pas de fournisseur qui retient les
   prompts). Regle de repli : quand le classifieur est indisponible (pas de
   cle Jev, timeout, reponse hors ensemble ferme), le routeur NE CHOISIT PAS
   au hasard : il applique la regle deterministe (section 4.5) et journalise
   "classification indisponible".
2. **Les quotas** : `quota_status` par profil (fenetres et pourcentages
   restants), le quota glissant Anthropic 5h/7d (`remaining-quota`), les
   credits prepayes (`account-credits`). Un profil sous un seuil (par exemple
   20 % de quota restant) est `degrade` ; un profil a credits nuls ou cle
   absente est `sec`.
3. **L etat des cles** : profil existant, actif, credential resoluble,
   source-backed valide. L expiration reste un angle mort ; le routeur ne
   pretend pas la connaitre (il raisonne sur ce qu il peut voir).
4. **Le cout** : `spentUsd` par profil sur la fenetre du plafond
   (`usage-rollup`), plafond lui-meme (`AuthProfile.costBudget`, scope
   `profile`), et un plafond de nuit exprime comme une fenetre horaire sur le
   profil (la syntaxe de fenetre existe deja : `parseWindow`,
   `packages/runtime/src/usage-rollup.ts:148`, accepte `h`, `d`, et les durees
   ISO). Le "plafond de nuit" n est donc pas une nouvelle primitive : c est un
   `costBudget` de profil sur une fenetre de nuit.

### 4.4 Ce que le routeur decide

Un triplet, plus une raison :

```
{ adapter, model, profileRef, reason, source, alternativesEcartes[] }
```

Regle de conception forte : **le routeur ne propose jamais un modele libre**. Il
classe parmi des CIBLES DECLAREES :

- les presets (harnais -> profil + modele) de `harness-presets.json` et
  `presets.json` ;
- les roles de modele (`model-roles.ts`), donc les presets de roles #1892 ;
- les modeles autorises par le profil (`AuthProfile.models`), qui est
  l allowlist de facto.

C est la difference entre un routeur et un recomendateur : sa sortie est
toujours un choix parmi des choses que l operateur a declarees.

### 4.5 Ce que le routeur journalise

Sans trace, un routeur est unexpliquable. Trace persistee (fichier JSONL sous
`~/.agentproto/` ou table du daemon), une ligne par decision :

| Champ | Contenu |
| --- | --- |
| horodatage, session | quand, pour quelle session |
| appelant | MCP / REST / cron / CLI, et l identite si elle existe |
| tache classee | type, taille, sensibilite, et la confiance du classifieur |
| contraintes vues | quota restant par profil, credits, cout de la fenetre, plafond restant |
| choix | adapter, modele, profil |
| source | preset / role / defaut de harnais / repli deterministe |
| alternatives ecartees | pour chaque cible ecartee, la raison (quota, cout, pas dans l allowlist, en refroidissement, harnais inactif) |
| escalade payante | `false`, ou `true` avec le motif de l accord manque |

Le meme type de trace est deja demande par le plan r2 pour le bot de bascule
(section 13.5, point 3 : "chaque bascule est journalisee : profil precedent,
profil nouveau, raison, horodatage, verdict"). Les deux traces SHOULD etre
dans le meme fichier ou le meme format, sinon on aura deux histoires.

### 4.6 Regles deterministes (le filet quand le classifieur est muet)

Le routeur ne peut pas dependre d un appel reseau pour une decision de
depense. Il doit avoir une regle deterministe, testable, qui rend la meme
decision pour les memes entrees :

1. **Preference par defaut** : le preset de defaut du harnais, si son profil
   est sain.
2. **Degradation** : si le profil du preset est `degrade` (quota bas sous
   le seuil), on cherche un preset de meme harnais ou un harnais voisin dont
   le profil est `ok` ; on ne change pas de qualite de modele sans raison.
3. **Jamais de montee de cout sans accord** (voir section 4.8).
4. **Refus explicite** : si aucune cible saine n existe, le routeur ne
  choisit pas une cible arbitraire : il echoue avec un message qui nomme les
   profils refuses et leur raison (a l image de `harness_preset_profile_unavailable`
   et de `access_profile_ineligible`, qui sont deja des messages
   actionnables).

### 4.7 Recoupement avec `turnRetry.rotate`, les roles #1892 et le bot de bascule

| Avec quoi | Frontiere | Regle de non-conflit |
| --- | --- | --- |
| `turnRetry.rotate` | le routeur decide AVANT le premier tour ; la rotation repond APRES un echec | le routeur ne produit JAMAIS de liste `rotate` : il choisit un modele de depart. La rotation garde la main sur le post-erreur. Les deux partagent la regle "free reste free" (`turn-retry-policy.ts:143`) et la carte de refroidissement (`model-cooldowns.ts`) : le routeur ne doit pas choisir un modele en cooldown |
| roles #1892 (`model-roles.ts`) | les roles sont nommes et fixes ; le routeur est derive et argumenté | les roles sont une ENTREE du routeur (une tache de relecture vise `review.small`), et le routeur ne peut pas les ecraser : un role configure par l operateur doit primer sur la classification. Les presets de roles (#1892) restent le moyen de changer de jeu de modeles en une cle |
| bot de bascule (plan r2, section 13) | le bot decide QUAND basculer (etat de sante des profils, avant l erreur) ; le routeur decide QUOI choisir | le bot ne doit PAS ecrire le preset lui-meme : il demande au routeur de classer la chaine de repli du preset (`fallback: [...]`, section 13.5 du plan r2) et de dire lequel est sain. Le preset porte l ACCORD (liste `fallbackApproved`), le routeur porte la CLASSIFICATION, le bot porte la DECISION de basculer |
| politiques de preset du sujet (b) | la politique dit ce qui est permis de nommer ; le routeur dit ce qui est choisi | le routeur est un CHOIX, pas une permission : sa sortie ne peut jamais contourner la politique (b) ni la liste de harnais actifs (a). Il est evalue par la meme couche |

Ce recoupement merite une phrase : **le bot du plan r2 veut basculer vers plus
cher en cas de crise ; le routeur, par definition, ne bascule JAMAIS vers plus
cher sans accord.** La solution n est pas de weakening le garde-fou du routeur
mais de faire porter l accord par le preset (`fallbackApproved`), que seul
l operateur ecrit, comme le prevoit deja le plan r2 (section 13.6).

### 4.8 Garde-fou : jamais de bascule vers plus cher sans accord

Cinq regles, dont trois sont deja dans le code et doivent etre REUTILISEES,
pas reecrites.

1. **Le modele de reference.** Toute cible proposee est comparée au modele de
   reference du preset demande (ou du role). Une cible plus chere n est
   proposee que si elle figure dans une liste d accord ecrite par
   l operateur (par exemple `router.paidTargets: [...]` dans la config du
   daemon). Absente de la liste : la cible n est pas proposee, et le routeur
   journalise "escalade payante non autorisee".
2. **La regle free reste free.** `isOpencodeFreeModel` et
   `validateTurnRetryRotate` (`packages/runtime/src/turn-retry-policy.ts:143`
   et `:150`) sont deja le predicat de cout de reference du daemon. Le routeur
   s en sert tel quel : une session gratuite ne peut pas finir sur un modele
   payant.
3. **L allowlist du profil.** Une cible payante ne peut pas sortir du profil
   deja paye : `AuthProfile.models` est une curation stricte
   (`packages/auth/src/profile-types.ts:130`). Le routeur ne propose un modele
   que si le profil retenu le facture.
4. **Le plafond.** Une cible dont le cout estime depasse le plafond restant
   de la fenetre n est pas proposee. Le plafond de nuit est un `costBudget`
   de profil sur une fenetre horaire ; le cout deja depense vient du
   `usage-rollup`.
5. **Le precedent `decision-profile.ts`.** `validateSpawnTarget` (`:186`)
   refuse deja, fail-closed, tout adapter/modele non entitled, y compris les
   cibles de rotation. Le routeur doit s inspirer de sa forme (un profil
   d execution, une liste de cibles, un verdict par cible) plutot que d
   inventer un deuxieme vocabulaire.

## 5. Design minimal

### 5.1 Les trois datamodeles

```ts
// (a) harnais actifs
interface HarnessActivationConfig {
  /** "all" = comportement actuel (tout adapter installe est actif). */
  mode: "all" | "list"
  /** Slugs actifs. En mode "list", un slug absent est INACTIF. */
  active?: string[]
}

// (b) politique de prereglages
type PresetPolicy = "free" | "default-harness" | "presets-only"
interface PresetPolicyConfig {
  policy: PresetPolicy
  /** Regles de cout additionnelles, ecrites par l operateur. */
  allowPaidTargets?: string[]
}

// (c) routeur
interface RouterConfig {
  enabled: boolean
  /** Reperes de classification de la tache. */
  taskTypes?: string[]
  /** Seuil de degrade (pourcent de quota restant). */
  degradedBelowPct?: number
  /** Modeles de repli deterministes, du moins cher au plus cher. */
  fallbackChain?: Array<{ adapter: string; model: string; profileRef?: string }>
  /** Cibles payantes autorisees explicitement. */
  paidTargets?: string[]
}
```

### 5.2 Les trois points d insertion

| Sujet | Module propose | Point d insertion |
| --- | --- | --- |
| (a) | `packages/runtime/src/harness-activation.ts` (pure : `isHarnessActive(slug, ctx)`) + filtre cote lister (`agent-tools.ts` `adapter_list`, `GET /adapters`) + refus au spawn (`session-spawn.ts`, avant `:3522`) | 3 points |
| (b) | `packages/runtime/src/preset-policy.ts` (pure : `validateAgainstPolicy(resolved, policy)`) + point de branchement dans `spawnAgentSession` apres les couches de precedence, avant la resolution d adapter | 1 point |
| (c) | `packages/runtime/src/model-router.ts` (choix pur) + `packages/runtime/src/model-router-classifier.ts` (appel Jev, optionnel) + branchement dans la couche "defaut de harnais" (`session-spawn.ts:2169`) | 1 point + 2 modules |

### 5.3 Les lectures de configuration

Le routeur et la politique ont besoin de la meme chose : la config du daemon
(`~/.agentproto/config.json`) ET la config du workspace (`<repo>/agentproto.json`).
Il existe deja un lecteur de la couche workspace pour le bloc `models`
(`packages/runtime/src/model-roles-tools.ts:72`, `loadWorkspaceModels`). Il
faudrait un lecteur generique de section pour `harnesses`, `spawn.presetPolicy`
et `router`, avec la meme precedence (workspace > daemon) et le meme
discriminant de source que `resolveModelRole` (qui rapporte toujours la couche
gagnante).

Les trois reglages sont des REGLAGES, pas des pointeurs : ils vont dans la
config, pas dans `harness-presets.json` ni dans `presets.json`.

## 6. Decoupage en PR

PR independants, dans l ordre de dependance. Chaque PR porte ses tests.

| PR | Sujet | Contenu | Dependances |
| --- | --- | --- | --- |
| P1 | (a) | Store + schema `harnesses` (config daemon + `agentproto.json`), lectures en priorite workspace > daemon, tests de precedence | aucune |
| P2 | (a) | Filtrage des LISTES : `adapter_list` (+ `adapter_models`), `GET /adapters`, ce qui regle du meme coup l arbre Harnesses, le panneau webview, le picker de spawn et le `runner-select` des app UIs | P1 |
| P3 | (a) | Refus de LANCEMENT : code `harness_inactive`, point unique dans `spawnAgentSession` avant la resolution d adapter, mapping 400, verification au create de cron, signalement `harnessInactive` sur les lignes de `harness_preset_list` et `profileDisabled` deja present | P1, P2 |
| P4 | (b) | Module pur `preset-policy.ts` + schema de config `spawn.presetPolicy` (3 etats), defaut `free` (retrocompatible) | P1 |
| P5 | (b) | Branchement dans `spawnAgentSession` (fail-closed, code `preset_policy_violation`, message qui nomme la policy et le preset) + mapping HTTP + tests par surface (MCP, REST, cron) | P4 |
| P6 | (c) | Module de choix pur `model-router.ts` : entrees (etat des profils, quotas, credits, cout, plafond), sorties (triplet + raison), regles deterministes, garde-fou "jamais plus cher sans accord". Tests unitaires sans reseau | P1 |
| P7 | (c) | Classifieur de tache : appel Jev type question fermee, avec repli deterministe quand le classifieur est indisponible, reglage `router.enabled` (desactive par defaut) | P6 |
| P8 | (c) | Branchement dans la couche "defaut de harnais" (`session-spawn.ts:2169`) : le routeur propose, le preset confirme, la politique tranche. Journalisation de la decision | P6, P7, P5 |
| P9 | (c) | Trace persistee des decisions (JSONL ou table), format commun avec la trace de bascule du bot du plan r2 (section 13.5) | P8 |

Ordre importe : P2 avant P3 (masquer avant d interdire, pour que l UI ne
propose pas un harnais qui sera refuse), P4 avant P5, P6 avant P7 avant P8.

## 7. Risques

1. **Un harnais actif masque mais non interdit, ou l inverse.** C est le
   risque principal de (a). Le cas grave : un operateur croit avoir desactive
   un harnais (il disparait des listes) alors que le daemon le lance encore.
   D'ou la regle "masquer et interdire dans le meme PR, ou ne pas masquer".
2. **Un harnais desactive casse un cron ou une session vivante.** Le refus au
   tir d un cron est un echec bruyant a 3h du matin. Le listage `harness_preset_list`
   doit signaler l incoherence AVANT.
3. **Une politique trop stricte casse les usages legitimes.** `presets-only`
   sur un daemon ou les agents s auto-lancent (orchestrateur, superviseur,
   crons) peut les empeindre de demarrer. Le defaut `free` limite la casse,
   mais le passage en `presets-only` doit etre documente comme une decision
   d operateur, pas un defaut de configuration.
4. **La surcharge workspace peut relacher la politique globale.** C est une
   montee de privilege silencieuse. Regle proposee : la surcharge workspace
   peut RESSERRER la politique globale, jamais la relacher, sauf drapeau
   explicite dans la config du daemon.
5. **Un routeur qui bascule vers plus cher.** Le risque principal de (c). Le
   garde-fou (accord ecrit, comparaison au modele de reference, allowlist du
   profil, plafond) est deja dans le plan, mais sa mise en oeuvre est
   delicate : une erreur d estimation de cout suffit a faire basculer. Le
   routeur doit donc comparer des COUTS ORDONNES (rang), pas des estimations
   en USD, tant que le prix par modele n est pas disponible de facon fiable.
6. **Un routeur qui casse la conversation.** Changer de modele en cours de
   session n est pas anodin (et n est pas possible pour un adapter en mode
   `arg`). D'ou la decision de ne pas faire de (c) un routeur par tour.
7. **Le routeur depend du reseau pour une decision de depense.** La regle
   deterministe (section 4.6) doit suffire seule : le classifieur Jev est un
   bonus, jamais une dependance.
8. **La derive des sources de verite.** Trois stores de reglages
   (`config.json`, `agentproto.json`, `harness-presets.json`) et deux stores de
   prereglages (`presets.json`, `harness-presets.json`). Le plan r2 signale
   deja ce risque (section 10, point 5). Chaque regle de la tache 17 doit avoir
   UN proprietaire de fichier, sinon on reproduit le probleme.
9. **Un routeur et un bot de bascule qui se contredisent.** Le bot (plan r2)
   veut basculer en crise, le routeur ne veut pas monter en cout. Si les deux
   sont actives sans entente, le bot peut vouloir ecrire un preset que le
   routeur refuse, ou l inverse. D ou le recoupement propose en section 4.7 :
   le bot classe, le routeur propose, le preset porte l accord.
10. **Un harnais inactif mais un role de modele qui l impose.** `adapterForModelId`
    (`model-roles.ts:107`) peut pointer vers un harnais inactif. Signalement
    necessaire, sinon les jobs de review echouent sans explication.

## 8. Decisions a trancher

Sujet (a) - harnais actifs :

1. Allowlist stricte (un adapter absent est inactif) ou liste d exclusions ?
   Le design propose la forme 3 (`mode: "all" | "list"`), mais le defaut
   `all` doit etre confirme : un daemon ou rien n est configure doit-il
   continuer a lister et lancer tous les adapters ?
2. "Non liste" signifie "inactif" ou "liste non configuree" ? Une liste vide
   en mode `list` : zero harnais actif, ou retour a `all` ?
3. La liste est-elle un CONTROLE (interdit de lancer) ou une CONVENANCE
   (masque seulement) ? Le design propose les deux, masquage et refus, mais
   la decision doit etre explicite, car elle change le caractere du
   reglage (securite contre ergonomie).
4. Substitution ou refus ? Le design propose le refus (fail-loud), la
   substitution silencieuse changerait de wallet sans demande.
5. Perimetre de la surcharge workspace : la workspace peut-elle ajouter des
   harnais actifs que le global n autorise pas, ou seulement restreindre ?
6. Le refus doit-il etre porte par `agent_start` seul, ou aussi par le create
   de cron, le create de preset de harnais et la creation de session via REST ?
7. Les adaptateurs "supported" (non installes, mais connus) restent-ils
   visibles dans l arbre Harnesses pour permettre l installation ?

Sujet (b) - politique de prereglages :

8. Trois etats fixes (`free`, `default-harness`, `presets-only`) ou une liste
   de policies extensibles ?
9. Sous `presets-only`, un `agent_start` qui nomme un adapter sans modele ni
   profil est-il permis (resultat deterministe par le defaut de harnais) ou
   refuse (forme plutot que resultat) ?
10. Qui gagne quand la policy et le preset se contredisent ? Le design
    propose fail-closed (la policy gagne), avec un message qui nomme les deux.
11. La surcharge workspace peut-elle RELACHER la politique globale ? Le
    design propose non (resserrer seulement).
12. La politique s applique-t-elle aux sessions de decision (workflow, avec
    leur propre profil d execution) et aux spawns cloud AIP-66 ?
13. Un caller de confiance (l operateur humain via le CLI) peut-il
    contourner la politique, et avec quelle trace ?

Sujet (c) - routeur :

14. Le routeur est-il ACTIF par defaut, ou desactive par defaut comme le
    classifieur Jev du profil gratuit (`decision-profile.ts:71`) ? Le design
    propose desactive par defaut.
15. Le routeur choisit-il un PRESET (donc harnais + modele + wallet), ou
    seulement un MODELE sur le harnais demande ? Le design propose le preset,
    mais cela lui donne le pouvoir de changer de wallet.
16. Le classifieur de tache est-il un appel Jev, un appel LLM via le daemon,
    ou une heuristique deterministe (taille du prompt, presence de fichiers,
    type de commande) ? Le design propose Jev en option, avec repli
    deterministe obligatoire.
17. Le "type de travail" est-il une liste fermee ( comme les verdicts du
    steward) ou un score continu ? Une liste fermee est testable et
    journalisable.
18. La comparaison de cout se fait-elle par RANG (une table declaree par
    l operateur) ou par PRIX reel (le catalogue modele a-t-il des prix
    fiables et a jour) ?
19. Le plafonnement de nuit est-il un `costBudget` de profil (fenetre
    horaire) ou une nouvelle primitive de fenetre de nuit dans le daemon ?
20. Le routeur a-t-il le droit de changer de profil (wallet) ? Le design
    propose non par defaut : il classe et propose, il ne bascule pas de
    wallet sans accord, ce qui est coherent avec le garde-fou et avec le
    bot de bascule du plan r2.
21. La trace des decisions est-elle un JSONL sous `~/.agentproto/` ou une
    table du daemon ? Le plan r2 demande une trace de bascule persistee :
    les deux traces doivent partager un format.
22. Les surfaces du routeur sont-elles les memes que celles du bot de
    bascule (un outil de lecture de l etat des profils), ce qui evita
    d ecrire deux fois la lecture de sante ?

## 9. Sources consultees

- `packages/provider-kit/src/discover.ts`, `list-resolve.ts`, `status.ts`,
  `creds-store.ts`, `ledger.ts` ;
- `packages/cli/src/registry/resolve.ts` (`listInstalledAdapters`,
  `listAdaptersWithCatalog`, `resolveAdapter`), `packages/cli/src/registry/harness.ts`,
  `packages/cli/src/commands/adapters.ts`, `packages/cli/src/commands/harness.ts`,
  `packages/cli/src/commands/preset.ts`, `packages/cli/src/commands/sessions.ts` ;
- `packages/runtime/src/agent-tools.ts` (`adapter_list`, `adapter_models`,
  `harness_capabilities`, resolution de `presetId`), `agent-start-schema.ts` ;
- `packages/runtime/src/session-spawn.ts` (couches de precedence : preset
  utilisateur, defaut de harnais, `adapter_not_found`, eligibilite du profil) ;
- `packages/runtime/src/harness-preset-store.ts`, `harness-preset-tools.ts`,
  `user-presets.ts`, `user-preset-tools.ts` ;
- `packages/runtime/src/turn-retry-policy.ts`, `turn-retry.ts`,
  `model-cooldowns.ts` ;
- `packages/runtime/src/decision-profile.ts`, `decision-escalation.ts`,
  `decision-tools.ts`, `decision-workflow-tools.ts`, `decision-policy.ts`,
  `jev-client.ts` ;
- `packages/runtime/src/model-roles.ts` (roles et presets #1892),
  `model-roles-tools.ts` (couche workspace) ;
- `packages/runtime/src/quota-status-tool.ts`, `remaining-quota.ts`,
  `remaining-quota-store.ts`, `account-credits.ts`, `usage-rollup.ts`,
  `usage-rollup-service.ts` ;
- `packages/auth/src/profile-types.ts` (curation `models`, `costBudget`,
  `disabled`), `packages/auth/src/eligibility.ts` ;
- `packages/runtime/src/config.ts`, `config-schema.ts` (registre `CONFIG_KEYS`) ;
- `packages/model-routing/src/types.ts`, `resolve.ts`, `pack.ts`, `env.ts`
  (AIP-57) ;
- `packages/vscode/src/views/harnessesTree.ts`, `harnessesTree.logic.ts`,
  `packages/vscode/src/webview/harnessesWebviewPanel.ts`,
  `packages/vscode/src/commands/spawn.ts`, `spawn.logic.ts`,
  `packages/vscode/src/commands/configurationLab.logic.ts`,
  `packages/vscode/src/webview/authExplorerPanel.ts`,
  `packages/vscode/src/webview/authModelMindmapPanel.ts` ;
- `packages/app-client/src/runner-select.ts` (picker des app UIs) ;
- `origin/night/t16-agent-presets-swap-r2` : `PLAN-r2.md` (presets, harnais
  par defaut, bot de bascule, garde-fous de cout) ;
- `origin/night/t16-agent-presets-swap` : `PLAN.md` (plan v1) ;
- `origin/main` au commit `fb025f0b`.
