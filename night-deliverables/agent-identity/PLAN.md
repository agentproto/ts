# TACHE 15 - Plan d identite d agent stable (au-dessus des sessions)

Lecture seule. Aucun code, aucune PR. Reference : etat de `origin/main` au commit
`fb025f0b` (feat(sandbox): reap orphan computer boxes in sandbox gc (#2164)).

## 1. Objet

Les agents permanents (cerveau, PM, superviseurs, concepteur-redacteur, agents
Pygmalion) changent d identifiant de session a chaque restart, compaction ou
changement de profil. Chaque changement impose de deplacer a la main les
follows, les crons, les adresses `message_send`, les grants `allowPromptFrom`,
les liens parent/enfant.

Objectif : introduire un identifiant d agent STABLE, distinct du slug de
session, parent logique des sessions successives d un meme agent, reserve aux
agents pre-declares (manifeste AIP-42, agents Pygmalion). Les surfaces
existantes (follows, crons, `message_send`, `allowPromptFrom`, permissions,
affichage) s adressent alors a l agent, et le daemon resout vers la session
vivante.

Ce document est un plan, pas une implementation. Il dit ce qui existe deja, ce
qui manque, propose un design minimal, decoupe en PR avec ordre et dependances,
et signale les recouvrements avec les PR ouvertes (#2163, #2165, #2167, #2168).

## 2. Ce qui existe deja

### 2.1 Le slug de session (#1980) : un handle unique, mais lie a la session

- `packages/runtime/src/session-ref.ts:169-179` `mintSlug(desired, isTaken, fallbackId)`
  : slug unique, kebab-case, dedupe par suffixe numerique.
- `packages/runtime/src/sessions.ts:1949-1961` champ `slug` du `SessionDescriptor`,
  plus `name` en alias legacy deprecie (`:1940-1948`), accessor `getSlug` (`:2731-2741`).
- Resolution : `packages/runtime/src/session-ref.ts:84-118` `resolveSessionRef`
  : ordre fige id exact, puis slug exact, puis `name` legacy ; ambiguite = echec
  bruyant (`ambiguous`).
- Le slug est un handle d ADRESSAGE d une session, pas une identite d agent. Il
  est explicitement absent de la chaine d affichage (cf. commit `f8088c32`).

### 2.2 Le manifeste AIP-42 (#1997) : il existe deja un id d agent stable, mais mal exploite

- `packages/agent/src/load-agent.ts:33-51`, `packages/agent/src/spec.ts:16-25`
  : layout canonique `<workspace>/.agents/<id>/AGENT.md` (variante app
  `.agentproto/agents/<id>/AGENT.md`).
- `packages/runtime/src/spawn-agent-manifest.ts:25-32` : `AgentManifestRef
  { agentId?, agentPath? }`, resolution pure `resolveAgentManifestPath` (`:52-74`).
- L'id de manifeste est un identifiant STABLE et partageable : il survit aux
  sessions. Il est aujourd'hui persiste uniquement dans la map libre `meta` :
  `packages/runtime/src/session-spawn.ts:5099` (`meta.agentId`, prefixe owner
  retire via `stripOwner`, `:2687`), `:5103` (`meta.agentManifestPath`),
  `:5107/5109` (`meta.agentRoleHash`, `meta.agentToolsHash`).
- Surface d'entree : le spawn interne (`session-spawn.ts:1475-1482`) et le corps
  REST (`packages/runtime/src/http-server.ts:5743-5746`), CLI
  `packages/cli/src/commands/sessions.ts:1196-1204` (`--agent <id|chemin>`).
  Le schema MCP `agent_start` (`packages/runtime/src/agent-start-schema.ts`) ne
  l'expose PAS. `app_run` forge ses propres ids (`packages/runtime/src/app-tools.ts:2585`,
  label `app:<appId>:<agentId>`).

Conclusion partielle : oui, un id d agent stable existe deja (l'id du manifeste
AIP-42), mais il n'est ni adresse, ni resolu, ni porte, ni affiche.

### 2.3 Le label operateur : le quasi-agent-id d aujourd'hui

- `packages/runtime/src/sessions.ts:1918-1926` `operatorLabel` : immuable,
  estampille par le daemon, sessions racines seulement, non modifiable par un
  outil. Ecriture : `packages/runtime/src/agent-tools.ts:550-563` (uniquement
  si le spawn n'a pas de session appelante).
- C'est la seule cle de grant stable qui existe, et elle est deja utilisee :
  - `allowPromptFrom` par label (#2103) : `packages/runtime/src/session-owner.ts:77-134`,
    regle 5 ; `label:<exact>` et `label:<prefixe>*`, uniquement pour un appelant
    racine, uniquement contre `operatorLabel` (jamais contre le `label`
    mutable, pour qu'un `session_rename` ne puisse pas s'octroyer un grant).
  - cron par label d agent (#2157) : `packages/runtime/src/cron-scheduler.ts:144`
    (`CRON_AGENT_TARGET_PREFIX = "agent:"`), `:746-812` resolution au moment du
    tir, `:890-900` dispatch. CLI `packages/cli/src/commands/cron.ts:225-250`,
    MCP `packages/runtime/src/orchestration-tools.ts:2729-2781`.

Les deux semantiques sont deliberement differentes et non factorisees :
le cron matche `label` OU `operatorLabel` (casse insensible) ; le grant
`allowPromptFrom` matche `operatorLabel` seul et exige un appelant racine.
C'est la source de confusion numero un a resorber.

### 2.4 La filiation et les relances : la chaine de lignee existe

- Champs persistes sur `SessionDescriptor` : `parentSessionId` (`sessions.ts:2383`),
  `depth` (`:2596`), `continuedFrom` / `continuedTo` / `continuationGeneration`
  (`:2510-2525`), `succeeds` / `succeededBy` (`:2526-2538`), `resumedFrom` /
  `resumeVia` (`:2584-2604`), `handoff` (`:2539-2546`), `remoteParent` (`:2394-2404`).
- Filiation au revival (#1564) : `sessions.ts:6814-6838` (resumedFrom +
  continuedFrom + generation), applique sur les trois chemins de relance.
- Handover de lignee (#2152) : `packages/runtime/src/lineage-handover.ts` (248
  lignes) ; `handoverLineage` (`:96-172`), `setLineageSuccessor`
  (`sessions.ts:4722-4728`), `reassignParent` (`:4729-4738`), verb
  `session_adopt` (`packages/runtime/src/lineage-tools.ts:35-120`).
- Resolution de successeur deja presente et reutilisable :
  `packages/runtime/src/session-retirement.ts:48` `resolveSuccessor`, `:25`
  `isRetired`. C'est la brique qui manque pour resoudre agent -> session vivante.

### 2.5 Identite de l appelant (#2161) et relais parent (#2162)

- `packages/runtime/src/sessions.ts:862-881` `CALLER_SESSION_ID_HEADER`,
  `packages/runtime/src/session-spawn.ts:1030-1061` `buildDaemonSelfMountEntry`
  (stamp `?callerSessionId=` + header), `:1139-1165` `stampDaemonCallerSessionId`.
- Lecture gateway : `packages/runtime/src/http-server.ts:2020-2057`
  (`resolveCallerSessionId`).
- Relais `message_parent` box -> hote : `packages/runtime/src/parent-relay.ts`
  (grant en memoire seulement, `:97-105`, TTL glissante `:85-86`),
  hote `http-server.ts:3108-3176`. Le destinataire vient du GRANT, jamais du
  payload.

Ces deux briques sont les modeles a copier pour une identite agent : une
identite elle aussi daemon-attestee, jamais posee par l appelant.

### 2.6 Les surfaces d adressage aujourd'hui

| Surface | Adressage actuel | Reference |
| --- | --- | --- |
| Follows | `selector.sessionIds` (ids de session), `all`, `cwdPrefix`, `boardId` ; exclusion par `labels` seulement | `packages/runtime/src/session-follow-store.ts:48-67`, `:69-98` ; couverture `packages/runtime/src/session-follow.ts:244-272` |
| Crons | `agent:<label>` (label ou operatorLabel) ou id de session | `packages/runtime/src/cron-scheduler.ts:746-812` |
| `message_send` | `"parent"` ou **id de session** du voisin ; le slug n'est PAS accepte | `packages/runtime/src/message-tools.ts:122-198` (`registry.get(toId)`), `:214-235` |
| `allowPromptFrom` | ids de session, `"any"`, `label:<...>` | `packages/runtime/src/session-owner.ts:105-121` |
| Permissions / ACL messagerie | voisinage arbre parent/enfant, freres optionnels | `packages/runtime/src/session-message.ts:75-106` (`resolveRelation`, `isMessageAllowed`) |
| Affichage | `sessionDisplayName` = label renomme > titre > label de spawn > adaptateur | `packages/runtime/src/session-title.ts:110-140` ; VS Code `packages/vscode/src/client/sessionName.ts:60-68`, arbre `packages/vscode/src/views/sessionsTree.logic.ts:186` ; session-chat = app `@agentik/session-chat` servie par le daemon (`packages/vscode/src/commands/sessionView.logic.ts:17`) |

### 2.7 Le stockage cote daemon

- Registre en memoire : `packages/runtime/src/sessions.ts:5814`
  `createSessionsRegistry` (Map par id de session).
- Persistance : `~/.agentproto/workspaces/<bucket>/sessions.json`
  (`packages/runtime/src/workspace-buckets.ts:81-100`, ecrivain
  `sessions.ts:7093`, `:7200-7225`).
- Follows : `~/.agentproto/follows.json` (`session-follow-store.ts:133`), store
  avec cle d'UPSERT `key` (`:69-98`) mais `follower` en **id de session**.
- Sidecar par session : `~/.agentproto/sessions/<id>/index.json`
  (`packages/runtime/src/session-index.ts:52-96`), qui ne contient **pas** le slug.
- Aucun registre d'agents durable n'existe cote daemon : ni fichier
  `agents.json`, ni table dediee. Les ids d'agents d'apps vivent dans les
  manifestes d'app (`packages/runtime/src/app-registry.ts:160`).

## 3. Ce qui manque (diagnostic)

1. **Aucun id d agent adresse.** L'id de manifeste AIP-42 est stable mais
   confines a `meta.agentId`, n'est ni resolu ni resolvable, et n'est pas
   accepte par `message_send`, les follows, les crons (au sens `agent:`),
   ni `allowPromptFrom`.
2. **L'id d agent n'est pas porte a travers les relances.** Le chemin de
   restart ne recopie que `meta.cloud` et l'app-boundary
   (`packages/runtime/src/session-restart-core.ts:1372-1400`, `:1510`) :
   `meta.agentId` est PERDU au restart. Le chemin continue-fresh ne le porte pas
   non plus (`packages/runtime/src/session-continue-fresh.ts:276-294`).
   Consequence : l'agent stable devient instable exactement au moment ou il
   change de session.
3. **Aucune resolution agent -> session vivante.** Le seul resoluteur
   label -> session est prive au cron (`cron-scheduler.ts:794-812`) et n'est
   ni exporte ni factorise. La resolution par lignee existe (`resolveSuccessor`)
   mais n'est pas exploitee pour une identite de niveau agent.
4. **`message_send` n'accepte que des ids de session** (`message-tools.ts:142`).
   Adresser un agent permanent oblige a connaitre son id de session courant.
5. **Les follows sont ancrees sur des ids de session.** `selector.sessionIds`
   devient faux au restart de la cible. Le store sait re-pointer un *follower*
   revive (`setFollower`, `session-follow-store.ts:120`) et l'engine detecte les
   sucesseurs de follower morts (`session-follow.ts`, via `continuedTo` et
   `resolveSuccessor`), mais rien ne fait le meme travail pour les **cibles**.
6. **`allowPromptFrom` ne connait que `label:`**, donc `label:` reste
  En pratique, c'est le seul quasi-agent-id, avec une semantique fragile (label mutable
   pour le cron, operatorLabel immuable pour les grants) et une contrainte
   "appelant racine" qui ne colle pas au cas "un agent permanent donne des
   ordres a un autre agent permanent".
7. **Aucun registre d'agents durable** : pas de lieu ou dire "l'agent X est
   declare dans ce workspace, son manifeste est ici, sa session vivante est
   la".
8. **L'affichage ignore l'identite d'agent** : ni VS Code, ni session-chat, ni
   la liste de sessions ne montrent ni n'acceptent un id d'agent.
9. **Le `agent_start` MCP n'expose pas `agentId`/`agentPath`**
   (`packages/runtime/src/agent-start-schema.ts`), alors que REST et CLI le
   font : surface non homogene.

## 4. Design minimal propose

### 4.1 Un identifiant, deux portes

- **Nom de champ** : `agentId`, promote en champ de premier niveau du
  `SessionDescriptor` (aujourd'hui dans `meta`), imuable et estampille par le
  daemon, jamais pose par l appelant.
- **Deux sources, une seule identite** :
  1. le manifeste AIP-42 : `agentId` = `stripOwner(manifest.id)`, deja
     calcule au spawn (`session-spawn.ts:2687`). C'est la source par defaut,
     et elle est deja stable ;
  2. une declaration explicite a la naissance d'un agent permanent, pour les
     agents sans manifeste : `agentId` en kebab-case, portee par un appel
     d'operateur (CLI/REST), refusee sur un appel de session non operateur.
- **Portee** : reserve aux agents pre-declares. Une session de code ordinaire
  ne porte pas d'`agentId`. C'est le garde-fou de securite central : l'identite
  agent est une **capacite**, pas un cosmetique.

### 4.2 Ou vit l'identite

Un registre d'agents durable, cote daemon, un fichier par bucket de workspace
(pour epouser la partition des sessions, `workspace-buckets.ts:81-100`) :

```
~/.agentproto/workspaces/<bucket>/agents.json
{
  "agents": {
    "<agentId>": {
      "agentId": "<agentId>",
      "workspace": "<workspace path>",
      "manifestPath": "<abs .agents/<id>/AGENT.md>",   // optionnel
      "label": "<operatorLabel>",                        // optionnel, libelle humain
      "kind": "manifest" | "declared",
      "currentSessionId": "<sess_...>",                 // majore a chaque spawn/relance
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
}
```

Le registre est un **cache d'adressage**, pas la source de verite : la source de
verite reste le descripteur de session (`agentId`) plus la chaine de lignee
(`resumedFrom` / `continuedFrom` / `succeeds`). Si le registre est perdu ou
perime, la resolution par lignee rebatit le meme resultat. C'est ce qui evite
un registre qui devient un point de verite divergent.

### 4.3 Resolution agent -> session vivante

Un module unique, `packages/runtime/src/agent-identity.ts`, qui factorise la
semantique du cron (`cron-scheduler.ts:794-812`) et l'etend :

```
resolveAgentTarget(agentId) ->
  | { kind: "live", desc }            // session vivante la plus recente portant agentId
  | { kind: "successor", desc, from }  // la lignee d'un agent mort a un successeur vivant
  | { kind: "restart", desc }          // agent mort non retraite : revival par le chemin de relance
  | { kind: "missing" }                // agent inconnu
```

Ordre de resolution (identique au cron, donc pas de changement de semantique
pour les crons) :
1. registre : `currentSessionId` vivant -> `live` ;
2. sinon, sessions du registre portant l'`agentId`, triees du plus recent au
   plus ancien, et pour chacune chaine de succession (`resolveSuccessor`,
   `session-retirement.ts:48`) jusqu'a une session vivante -> `successor` ;
3. sinon, derniere session non retiree et morte -> `restart` (le daemon relance
   avec le meme `agentId`, qui doit donc etre **porte** par le restart, cf. 3.2) ;
4. sinon `missing`, avec un message qui nomme l'agent et l'espace de recherche.

Le point 3 impose que `agentId` survive a la relance (section 3.2). On ajoute
donc au chemin de restart et de continue-fresh le report de `agentId` et
`agentManifestPath`, sur le modele exact du report de `operatorLabel`
(`session-restart-core.ts:1563`, `session-continue-fresh.ts:290`).

### 4.4 Adressage par agent, surface par surface

Toutes les surfaces acceptent une **forme syntaxique unique**, prefixee, pour
ne jamais confondre un id d'agent avec un id de session :

| Forme | Sens |
| --- | --- |
| `agent:<agentId>` | adresse un agent (son id stable) |
| `agent:<label>` | forme historique du cron : conservee, mappee sur l'`operatorLabel` puis le `label` (compatibilite) |
| `sess_...` / slug | adresse une session (inchange) |

Regle de resolution unique, partagee par toutes les surfaces : `agent:<x>`
resout via `resolveAgentTarget`, puis on applique les regles metier de la
surface sur la session **resolue** (donc pas de contournement de l'ACL).

- **Follows** : `FollowSelector.agentIds?: string[]` (resolu a l'evenement, la
  cible pouvant disparaitre entre-temps) et `FollowExclude.agentIds?: string[]`.
  Le predicat de couverture (`session-follow.ts:244-272`) gagne une regle :
  la session dont l'`agentId` est dans `selector.agentIds` est couverte. Comme
  les ids sont stables, un follow sur l'agent suit toutes ses sessions, y
  compris celles creees apres la creation du follow. Resolution par lignee
  egalement acceptee (une session retiree dont le successeur porte le meme
  `agentId`).
- **Crons** : `agent:<x>` accepte desormais un `agentId` stable en plus du
  label. Preference : si `x` correspond a un `agentId` connu, il gagne ; sinon
  on retombe sur la semantique label actuelle. Le prefixe `agent:` reste
  inchange, donc les crons existants continuent de fonctionner a l'identique.
- **`message_send` / `message_reply`** : `to: "agent:<agentId>"` est resolu en
  session, puis la ACL de voisinage (`session-message.ts:94-106`) s'applique
  **sur la session resolue**. Un agent permanent qui n'est ni parent ni enfant
  direct reste donc refuse : l'adressage par agent ne cree pas de droit
  nouveau, il evite seulement de connaitre l'id de session. C'est le point de
  friction a trancher avec #2163 et #2167 (section 5).
- **`allowPromptFrom`** : nouvelle entree `agent:<agentId>` qui matche
  l'`agentId` du **caller** (au lieu de son `operatorLabel`). Les entrees
  `label:` existantes restent inchangees et non ambigues. Regle a poser
  explicitement : un grant `agent:` ne vaut que si l'appelant porte
  reellement cet `agentId`, ce qui est plus fort qu'un label puisque l'`agentId`
  est immuable et porte par le daemon.
- **Permissions / ACL** : un grant `agent:` designe une identite, pas une
  session. Les sessions d'un agent sont alors pilotables par qui a le droit
  sur l'agent. C'est le recouvrement majeur avec #2165 (section 5).

### 4.5 Affichage

- `SessionDescriptor.agentId` remonte dans la projection compacte
  (`sessions.ts:2956`), dans `session_list`, dans la sortie REST
  `GET /sessions`, et dans le sidecar `index.json`
  (`session-index.ts:52-84`, qui ne porte aujourd'hui pas le slug : on y ajoute
  `slug` et `agentId`).
- VS Code : badge `agentId` dans l'arbre et la tooltip
  (`packages/vscode/src/views/sessionsTree.logic.ts:186`, `:744-820`), et
  resolution d'argument d'acces par `agent:<id>`
  (`packages/vscode/src/commands/sessionActions.logic.ts`, `resolveSessionArg`).
- Session-chat : acceptation d'un `agent:<id>` comme cible, et affichage de
  l'agent dans l'entete de conversation.
- Le slug reste un handle de session, l'`agentId` un nom d'agent : les deux
  apparaissent, distincts, dans l'UI.

### 4.6 Cote studio (Pygmalion)

Les agents permanents Pygmalion ne sont pas observables depuis la box
(`~/.pygmalion/data/agents/<slug>` hors d'atteinte). On raisonne donc depuis le
code et les labels `pygmalion-agent-*` :

- Ces labels sont aujourd'hui des `operatorLabel` (immuables) sur des sessions
  racines, et servent de cles `allowPromptFrom` (`session-owner.ts:110-121`) et
  de cibles cron (`cron-scheduler.ts:754-760`).
- Le plan propose de **remplacer progressivement** ces labels par des
  `agentId` declaratifs : le manifeste AIP-42 de l'agent permanent porte son
  `id` (source deja stable), et le studio passe d'un `label:` a un
  `agent:<id>`.
- Format d'identite recommande pour la studio : `pygmalion-agent-<role>` en
  kebab-case, ce qui reste lisible dans un message d'erreur et dans un
  `allowPromptFrom`. Le prefixe `pygmalion-agent-` est deja la convention
  observee dans les tests (`packages/runtime/src/__tests__/session-owner-gate.test.ts:151-153`).
- Point de vigilance studio : les agents permanents sont des sessions racines
  (donc `operatorLabel` les rend grantables), et la regle "un grant `label:` ne
  vaut que pour un appelant racine" (`session-owner.ts:107`) doit etre reexaminee
  pour un grant `agent:` (voir 4.4).

## 5. Recouvrements avec les PR ouvertes

### #2165 (design des permissions, identite global / workspace / session)

- Point de contact principal : un `agentId` stable est une **identite de
  niveau global**, plus large que la session et plus etroite que le workspace.
  Le modele de #2165 doit donc prevoir une troisieme portee, ou un agent
  comme sujet de droits.
- Recommandation : ne pas dependre de #2165 pour la PR fondation. Definir
  aujourd'hui la semantique minimale des grants `agent:` (grant porte par un
  `agentId` immuable, resolu par le daemon, non transmissible a un tiers) de
  facon compatible avec une future portee "agent". Later, #2165 peut elargir
  (grant porte par un agent, applique a toutes ses sessions) sans casser la
  PR fondation.
- Point de vigilance securite : elargir un grant de session a un grant d'agent
  change le blast radius. Il faut que le grant `agent:` soit explicite dans
  l'UI/CLI et journalise, sinon une faute de frappe sur un `agentId` ouvre une
  session entiere.

### #2167 (`decide()` unique + ACL de messagerie)

- `message_send` par agent touche directement l'ACL : resoudre `agent:<id>` ne
  doit pas devenir un passe-droit.
- Recommandation : le patch d'adressage (#2163/#2167) et le patch d'identite
  agent doivent se rejoindre sur un **point de resolution unique**
  (`resolveAddressable(handle)` : `parent` | `agent:` | id | slug), appele par
  les deux, avec la decision d'ACL prise **apres** resolution sur la session
  resolue.
- Si #2167 land avant nous, notre PR d'adressage n'introduit qu'une forme de
  handle de plus et reutilise son point de resolution. Si nous landons avant,
  la PR #2167 doit Tenir compte de `agent:<id>` dans son unique `decide()`.

### #2168 (jeton de relais parent)

- Le jeton de relais (`parent-relay.ts:97-105`) est en memoire, par session
  box. Il est lie a une session, donc il se casse au restart de la session
  box (l'erreur est explicite : `agent-tools.ts:900`).
- Recoupement : si un agent permanent tourne dans une box, son identite stable
  permet de re-delivrer un message vers "l'agent" plutot que vers "la session
  box qui a cesse de vivre". C'est un gain, mais cela suppose que le relais
  soit re-autorise par agent, pas par session : **hors perimetre de la TACHE
  15**, a traiter dans une PR dediee apres #2168. On note la dependance, on ne
  la prend pas.

### #2163 (`message_send` meme workspace)

- #2163 elargit l'ACL de messagerie au meme workspace. Notre adressage par
  agent et son elargissement se recouvrent sur `message_send`.
- Ordre recommande : traiter #2163 (ou #2167) **d'abord**, en gardant
  `resolveAddressable` comme point d'extension ; notre PR d'adressage par
  agent arrive ensuite et n'ouvre aucun droit nouveau.
- Alternative : si l'ACL "meme workspace" est retenue, l'adresse d'agent est
  surtout un confort d'adressage ; l'identite stable garde son interet pour
  follows, crons, grants et affichage, qui ne dependent pas de l'ACL.

### #2157 (cron `agent:<label>`) et #2103 (`allowPromptFrom` par label)

- Ce sont les deux antecedents directs. Notre plan **ne les remplace pas** : il
  ajoute une forme d'adresse et un mecanisme de resolution partage, en
  conservant les formes existantes. Les PR concernes doivent etre modifiees
  (ou une PR les succede) pour utiliser le resoluteur partage, afin qu'il n'y
  ait qu'une semantique "agent:" dans le daemon.

## 6. Decoupage en PR

Sequence, dependances, et ce que chaque PR livre.

### PR 1 - Fondation : `agentId` en champ de premier niveau (dependance: aucune)

- `SessionDescriptor.agentId?: string` (imuable, estampille par le daemon).
- Persistance dans `meta` conservee en lecture (retrocompatibilite) ; ecriture
  au niveau du descripteur ; report dans le sidecar `index.json` (avec `slug`).
- `agent_start` MCP expose `agentId` / `agentPath` (alignement avec REST et
  CLI) ; validation kebab-case, refus des ids reserves.
- Report de `agentId` et `agentManifestPath` sur les chemins de restart
  (`session-restart-core.ts:1510`) et de continue-fresh
  (`session-continue-fresh.ts:276-294`), sur le modele du report de
  `operatorLabel`.
- Tests : portage a travers restart / continue-fresh / handover (#2152),
  absence d'`agentId` sur une session de code ordinaire, non-repossession par
  un appelant non operateur.

### PR 2 - Registre d'agents et resolution (dependance: PR 1)

- Nouveau module `packages/runtime/src/agent-identity.ts` :
  types, lecture/ecriture du registre par bucket, `resolveAgentTarget`.
- Factorisation de la resolution de label du cron
  (`cron-scheduler.ts:746-812`) vers le module commun, **sans changement de
  semantique** (le cron continue de matcher `label` et `operatorLabel`).
- Mise a jour du registre a chaque spawn, restart, continue-fresh, sortie de
  session, et lors d'un handover de lignee.
- Tests : agent dont la session est morte et dont le successeur est vivant ;
  agent dont toutes les sessions sont mortes (chemin `restart`) ; agent inconnu ;
  agent sans manifeste ; agent d'un autre workspace (isolement).

### PR 3 - Adressage par agent sur les surfaces de controle (dependance: PR 2)

- `resolveAddressable(handle)` : `"parent"` | `agent:<x>` | id | slug, point
  de resolution unique (prepare pour #2163 / #2167).
- Crons : `agent:<agentId>` en plus de `agent:<label>` (preference a l'id
  connu).
- Follows : `selector.agentIds` et `exclude.agentIds`, resolus a l'evenement.
- `message_send` / `message_reply` : `to: "agent:<agentId>"`, ACL appliquee
  apres resolution.
- `allowPromptFrom` : entree `agent:<agentId>` (grant porte par l'identite
  immuable du caller).
- Tests de non-regression sur les formes existantes (ids, `"any"`, `label:`,
  `label:*`).

### PR 4 - Affichage et surface operateur (dependance: PR 1)

- `agentId` dans `session_list`, la sortie REST, l'index par session.
- VS Code : badge, resolution d'argument `agent:<id>`, tooltip.
- Session-chat : cible `agent:<id>` et en-tete d'agent.
- CLI : `agentproto agents list` / `show <agentId>` (session vivante,
  manifeste, lignee), et `--agent-id` a l'opinion de spawn.

### PR 5 - Recoupements (dependance: PR 3)

- Integration avec la decision d'ACL unique si #2167 a lande ; sinon PR
  prealable a #2167.
- Journalisation des grants `agent:` (qui a pilote quel agent, quand).
- Migration des labels `pygmalion-agent-*` vers des `agentId` (cote studio,
  hors de ce repo, guide de migration documente dans le PR).

### Ce qui n'entre pas dans ce perimetre

- Le **jeton de relais par agent** (#2168) : PR dediee ulterieure.
- La **resolution par workspace** comme identifiant d'agent : trop large,
  hors perimetre.
- L'**auto-resurrection** d'un agent permanent par le daemon (a partir d'une
  declaration) : utile pour la studio, mais c'est une politique
  (`restartPolicy` / `keepAlive` existent deja) et non un mecanisme
  d'identite. A traiter separement, sur la base de ce plan.

## 7. Retrocompatibilite

- **Aucun changement cassant** : tout est additif. `agentId` est absent des
  sessions existantes ; les sessions sans `agentId` se comportent exactement
  comme aujourd'hui.
- Les formes d'adresse existantes restent valides : id de session, slug,
  `parent`, `label:` pour les grants, `agent:<label>` pour les crons.
- `meta.agentId` (PR 1) est lu comme source de compatibilite, puis la valeur
  est elevee au niveau du descripteur a la premiere ecriture. Une migration
  « lecture seule, ecriture au prochain spawn » evite toute migration de
  fichier au demarrage.
- Le registre `agents.json` est un cache : son absence ou sa perte degrade la
  resolution, sans casser les sessions (la resolution par lignee prend le
  relais). Au pire, une resolution `missing` la, ou un agent doit etre
  redemande.
- Les crons existants `agent:<label>` ne changent pas de comportement : la
  resolution par label est conservee a l'identique (meme ordre, meme
  insensibilite a la casse).
- Le role de l'`operatorLabel` n'est pas reecrit : il reste la cle de grant
  historique. `agentId` s'ajoute a cote, avec une semantique distincte et
  documentee.
- Pas de migration de schema AIP : le registre est un fichier de daemon, hors
  `specs/resources`. Si l'on veut un doctype, cela se fera dans un AIP separe
  (AIP-42 reste le referentiel des manifestes).

## 8. Risques

1. **Un `agentId` devient une capacite.** Qui peut poser un `agentId` decide
   qui peut, plus tard, piloter toutes les sessions de cet agent. Mitigations :
   id pose uniquement par le daemon a partir d'un manifeste, ou par un
   appelant operateur ; jamais par une session appelante ; journalisation des
   declarations.
2. **Collision d'id dans un meme workspace** (deux manifestes, meme id ;
   deux workspaces, meme id). Mitigation : le registre est partitionne par
   bucket de workspace, et la resolution refuse un agent d'un autre workspace
   plutot que de deviner.
3. **Deux sessions vivantes pour un meme agent** (relance en cours pendant que
   l'ancienne tourne). Mitigation : la regle "la plus recente vivante" est
   deja celle du cron ; on l'applique partout et on l'expose dans
   `agents show`.
4. **Grant `agent:` trop large.** Un grant qui vaut pour toutes les sessions
   d'un agent est plus puissant qu'un grant de session. Mitigation : grant
   explicite, journalise, et revokeable ; et un agent identifie est en pratique
   un agent unique et connu, donc le blast radius est maitrisable.
5. **Derive entre registre et lignee** (le registre pointe une session morte
   pendant que la lignee a avance). Mitigation : le registre est un cache, la
   lignee est la verite ; resolution en deux temps, et le registre se resync
   a chaque evenement de lignee.
6. **Duplication des semantiques "label"** deja presente dans le code
   (cron vs grants). Risque d'aggraver la confusion. Mitigation : facteur
   unique des lors de la PR 2, et un glossaire label / operatorLabel /
   agentId / slug dans la doc du daemon.
7. **Perte de `agentId` a la relance** si le report du PR 1 est incomplet
   (restart, continue-fresh, handover, revival, re-attach sandbox). Mitigation :
   chemin de report unique, teste sur chaque mode de relance.
8. **Collision de noms avec l'identite de session** dans les messages d'erreur
   et l'UI. Mitigation : forme prefixee `agent:` obligatoire partout, et
   affichage explicite « agent » vs « session ».
9. **Charge de la resolution** : `resolveAgentTarget` parcourt des sessions.
   Mitigation : registre en cache, et bornes (profondeur de lignee) comme
   ailleurs dans le daemon.
10. **Dependance a des PR ouvertes** (#2163, #2165, #2167, #2168). Mitigation :
    la PR 1 et la PR 2 ne dependent d'aucune ; la PR 3 s'accorde au point de
    resolution commun ; les PR 5 et 6 (relais par agent) restent optionnelles.

## 9. Ce qu'il faut decider avant d'ecrire du code

1. **Nom du champ** : `agentId` (aligne sur AIP-42 et sur `app_run`) ou
   `agentKey` (evite la confusion avec `meta.agentId` deja pose). Recommandation
   : `agentId` au niveau du descripteur, avec migration de lecture depuis
   `meta.agentId`.
2. **Portee des grants `agent:`** : un grant `agent:` vaut-il pour toutes les
   sessions de l'agent, ou seulement pour sa session vivante ? Recommandation :
   toutes les sessions de l'agent, c'est la raison d'etre de l'identite stable,
   mais avec journalisation et revocation.
3. **La regle "appelant racine"** qui vaut aujourd'hui pour `label:` doit-elle
   valoir pour `agent:` ? Recommandation : non, un agent permanent parle a un
   agent permanent sans etre racine.
4. **Interaction avec #2163** : l'adressage par agent est-il accepte comme
   elargissement d'ACL, ou uniquement comme confort d'adressage ? Recommandation :
   uniquement comme confort, l'ACL reste la.
5. **Studio** : migration des `pygmalion-agent-*` en `agentId` declaratifs
   dans les manifestes AIP-42, ou maintien des labels avec un mapping
   `label -> agentId` cote daemon ? Recommandation : la migration par les
   manifestes, le mapping cote daemon n'etant qu'un pansement.

## 10. Sources consultees (branche locale, commits deja merges)

`#1980` slug unique ; `#1987`/`#1989` clients et CLI par slug ;
`#1997` manifestes AIP-42 et spawn `agentId`/`agentPath` ;
`#2012` refresh du role ; `#1756` restart qui garde l'identite ;
`#1564` filiation ; `#2152` handover de lignee (`succeeds`, `continue-fresh`,
`session_adopt`) ; `#2145` ;
`#2103` `allowPromptFrom` par label ; `#2157` cron `agent:<label>` ;
`#2159` autocompact le long de la filiation ; `#2161` identite d'appelant
gateway ; `#2162` relais `message_parent` ; `#2163`, `#2165`, `#2167`, `#2168`
ouvertes, traitees par recoupement a partir de leur sujet et non de leur code
(non mergees dans cette branche).
