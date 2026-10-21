# TACHE 16 r2 - Prereglages d agent a changer d un coup (swap de superviseur)

Document de lecture seule cote daemon : aucun code de production n est modifie
ici. Reference : etat de `origin/main` au commit `fb025f0b` (feat(sandbox):
reap orphan computer boxes in sandbox gc (#2164)).

Cette version reprend le plan v1 (`night-deliverables/agent-presets/PLAN.md`,
branche `night/t16-agent-presets-swap`, commit `f72d8f9d`) et developpe les
deux points demandes en priorite :

- point 6 : ce que couvre deja `presetId` (et les harnais par defaut), et ce
  qui manque pour qu une session VIVANTE suive aussi son prereglage ;
- point 7 : un bot de surveillance qui bascule le prereglage vers le suivant
  d une liste de repli, avant l erreur, avec un garde-fou de cout.

Plan lie : `night-deliverables/agent-identity/PLAN.md` (TACHE 15, branche
`night/t15-agent-identity-plan`).

## 0. Sommaire

1. [Probleme](#1-probleme)
2. [Ce que porte le manifeste AIP-42, et ce qu il ne porte pas](#2-ce-que-porte-le-manifeste-aip-42-et-ce-quil-ne-porte-pas)
3. [Prereglage = manifeste enfant qui extends un agent de base](#3-reponse-prereglage--manifeste-enfant-qui-extends-un-agent-de-base)
4. [La commande unique de swap](#4-reponse-la-commande-unique-de-swap)
5. [Generation au build ou au runtime](#5-reponse-generation-au-build-ou-au-runtime)
6. [Prereglages utiles](#6-reponse-prereglages-utiles)
7. [Ce que ca change cote conventions de l app Pygmalion](#7-ce-que-ca-change-cote-conventions-de-lapp-pygmalion)
8. [Prototype gen-presets.ts](#8-prototype--gen-presets-ts-table--agentmd)
9. [Decoupage propose](#9-decoupage-propose)
10. [Risques et points a trancher](#10-risques-et-points-a-trancher)
11. [POINT 6 - Les deux primitives de prereglage qui existent deja](#11-point-6--les-deux-primitives-de-prereglage-qui-existent-deja)
12. [POINT 6 - Ce qui manque pour qu une session vivante suive son prereglage](#12-point-6--ce-qui-manque-pour-qu-une-session-vivante-suive-son-prereglage)
13. [POINT 7 - Le bot de bascule globale](#13-point-7--le-bot-de-bascule-globale)
14. [Sources consultees](#14-sources-consultees)

## 1. Probleme

Passer un superviseur (ou un PM) d un reglage a un autre se fait aujourd hui a
la main, axe par axe. Le 21/10 au soir : trois restarts de suite pour trouver
le bon profil d acces, et les follows perdus au passage.

Les axes qui bougent ensemble sont :

| Axe | Ou il vit aujourd hui | Survit a un restart ? |
| --- | --- | --- |
| Profil d acces (wallet) | `access.profileRef` du descripteur + profil nomme dans `@agentproto/auth` | oui, reporte par le restart |
| Modele | `model` du descripteur | oui |
| Harnais | `harness` / `adapterSlug` | oui |
| Posture | `posture` | oui |
| contextProfile | `contextProfile` | oui |
| keepAlive | `SessionDescriptor.keepAlive` | oui (`session-restart-core.ts:1541`) |
| turnRetry (+ `rotate`) | `SessionDescriptor.turnRetry` | oui (`session-restart-core.ts:1545`) |
| Follows | `selector.sessionIds` du store de follows | **non** (ids de session) |
| Crons | cible `agent:<label>` ou id de session | oui si `agent:<label>`, **non** si id brut |
| Memoire a relire | hors daemon (convention studio : on relit les rapports) | sans objet |
| Prompt de reprise | chemin de relance du daemon | oui, mais non parametrable |

Le point dur n est donc pas le restart lui meme (qui reporte deja presque
tout), mais le fait qu un restart **change l id de session** et que tout ce
qui est ancre sur un id de session (follows, crons a id brut, adresses
`message_send`) devient faux.

## 2. Ce que porte le manifeste AIP-42, et ce qu il ne porte pas

### 2.1 Ce que le manifeste AIP-42 porte

Le frontmatter valide par `packages/agent/src/schema.ts:16`
(`agentFrontmatterSchema`) accepte : `schema`, `id`, `description`, `version`,
`extends`, `model`, `identity`, `persona`, `runner`, `tools`, `actions`,
`skills`, `workflows`, `routines`, `delegates_to`, `memory`, `governance`,
`policy`, `traits`, `autonomy`, `boundaries`, `on`, `publish`, `tags`,
`metadata`. Le type correspondant est `packages/agent/src/types.ts:48`
(`AgentDefinition`), et `defineAgent` (`packages/agent/src/define-agent.ts:29`)
valide puis fige la definition.

Ce que le daemon sait en faire au spawn (projection
`packages/runtime/src/agent-projection.ts:110`, appelee par
`packages/runtime/src/spawn-agent-manifest.ts:115`) :

- `model` : le cerveau, surcharge prioritaire sur le modele du spawn ;
- `tools` : allowlist du gateway daemon (`?allowTools=`) ;
- le corps du manifeste, `persona`, `boundaries`, `traits` : compose en
  instructions, livrees en `systemPrompt` si le harnais a la chaine, sinon en
  prefixe du premier prompt (avec avertissement) ;
- `skills` : precharges si le harnais sait les livrer ;
- `metadata.hooks.clerk` : crochet de turn-end au niveau AGENT.

Le `metadata` est un `record` libre (`types.ts:203`) : c est le seul endroit
du frontmatter ou un prereglage peut loger sans modifier le schema AIP-42.

### 2.2 Ce que le manifeste ne porte pas

Rien de ce qui est de la session ou du daemon :

- profil d acces / wallet : `access.profileRef` (`session-config.ts:132`) ;
- harnais : `harness` (`session-config.ts:164`) ;
- rail de facturation : `route` (gateway + baseUrl, `session-config.ts:134`) ;
- posture : `posture` (`session-config.ts:136`) ;
- effort : `effort` (`session-config.ts:126`) ;
- contextProfile : `contextProfile` (`session-config.ts:138`) ;
- turnRetry et sa liste `rotate` : `packages/runtime/src/turn-retry-policy.ts` ;
- keepAlive : `SessionDescriptor.keepAlive` (`sessions.ts:1898`), bascule
  ensuite par le verbe `session_set_keepalive` ;
- sandbox, mcpServers, costBudget, contextContinuity ;
- follows, crons, resume prompt : ce sont des objets du daemon, hors du
  cycle de vie du manifeste.

Autrement dit : **le manifeste decrit qui est l agent, pas comment il est
runne cette fois-ci.** Un prereglage est de la seconde categorie.

### 2.3 Le trou le plus structurel : `extends` ne herite de rien

AIP-42 dit `extends`: "Parent AGENT this extends. Inherits all fields; child
overrides win" (`types.ts:63`). En pratique :

- `loadAgent` (`packages/agent/src/load-agent.ts:31`) ne fait que **valider**
  la chaine (profondeur <= 5, pas de cycle, via
  `packages/agent/src/validate-extends-chain.ts:51`) ;
- la projection runtime (`agent-projection.ts:110`) ne lit que le handle de
  l enfant : **aucun merge des champs du parent n est fait**.

Donc un manifeste enfant `extends` un agent de base ne recoit rien du parent.
C est le premier manque a combler pour la strategie "prereglage = manifeste
enfant".

## 3. Reponse : prereglage = manifeste enfant qui extends un agent de base

### 3.1 Faisabilite aujourd hui

Partiellement, et pas par le chemin evident :

- **Ce qui marche** : ecrire un manifeste par prereglage (ou un
  `metadata.agentproto.preset` dans un manifeste unique), le valider avec
  `defineAgent`, le rendre avec `renderAgentManifest`
  (`packages/app-kit/src/emit.ts:104`), et le lancer au spawn avec
  `agent_start.agentId` / `agentPath` (REST `http-server.ts:5743`, CLI
  `sessions --agent`, resolution `spawn-agent-manifest.ts:51`).
- **Ce qui ne marche pas** :
  1. l heritage `extends` n existe pas au runtime (section 2.3) : il faut
     soit fusionner dans le generateur (le prototype de la section 8 le
     fait), soit implementer le merge cote daemon ;
  2. le frontmatter AIP-42 n a pas de champ pour un prereglage : il faut
     passer par `metadata` ;
  3. meme avec `metadata.agentproto.preset` present, le daemon ne sait pas
     le lire : `loadAgentManifestDefaults` ne lit que `model`, `tools`,
     instructions, `skills`, `options` et `metadata.hooks.clerk`
     (`spawn-agent-manifest.ts:133-153`) ;
  4. le MCP `agent_start` n expose ni `agentId` ni `agentPath`
     (`packages/runtime/src/agent-start-schema.ts` : aucune occurrence), alors
     que le REST et le CLI les exposent : surface non homogene ;
  5. le restart n a pas d axe `turnRetry` ni `keepAlive` en override, et la
     route REST `POST /sessions/:id/restart` (`http-server.ts:8227`) n accepte
     ni `harness` ni `turnRetry` (le verbe MCP `session_restart` accepte
     `harness`, pas `turnRetry` non plus).

### 3.2 Ce qu il manque cote daemon pour lancer/relancer un agent avec un prereglage

Trois briques, dans cet ordre :

1. **Un merge `extends` au runtime** (ou une resolution de prereglage dediee).
   Un module du type `packages/runtime/src/agent-extends.ts` qui, pour un
   handle enfant, charge le parent (meme convention de chemin que
   `load-agent.ts:48`) et fusionne champ par champ : l enfant gagne, le
   parent fournit le manque, la fusion des listes est "enfant remplace
   parent" sauf pour `tools`/`skills` ou l union triee est preferable. Le
   generateur de la section 8 en est le prototype de semantique.
2. **Un prereglage declare et lu par le daemon**. Choix retenu : un bloc
   `metadata.agentproto.preset` dans le manifeste, parce que `metadata` est
   deja le namespace des reglages propres au daemon (precedent :
   `metadata.hooks.clerk`). Contenu propose :

   ```yaml
   metadata:
     agentproto:
       preset:
         name: go
         harness: opencode-go
         model: zhipuai/glm-5.3-flash
         access: { profileRef: DeveloperWs003 }
         posture: default
         effort: medium
         contextProfile: lean
         keepAlive: true
         turnRetry: { on: [rate_limit], maxRetries: 2 }
         resumeNote: "Reprise apres swap : relire rapports/ avant d agir."
   ```

   Le daemon le lit au spawn, le replie sur les axes de `SessionConfig`, et
   l applique comme un `presetId` deja existant
   (`packages/runtime/src/user-presets.ts:35`, `UserPreset`) : le prereglage
   d agent est un `UserPreset` enrichi (keepAlive + resumeNote + provenance
   manifeste).
3. **Un chemin de relance par prereglage**. Le chemin existant
   `restartAgentSession` (`packages/runtime/src/session-restart-core.ts`) est
   le bon : il reporte `operatorLabel`, `meta.cloud`, `keepAlive`,
   `turnRetry`, la filiation (`resumedFrom`, `continuedTo`,
   `continuationGeneration`, `sessions.ts:2510-2525`). Il manque :
   - `turnRetry` et `keepAlive` comme axes d override ;
   - `harness` et `resumeNote` sur la route REST ;
   - le report de `meta.agentId` / `meta.agentManifestPath` (perdu au
     restart aujourd hui, cf. TACHE 15 section 3.2), sans quoi le prereglage
     n est plus associe a un agent stable apres le swap.

## 4. Reponse : une commande unique de swap

Commande visee :

```
agentproto agents swap <agent> --preset <nom> [--dry-run] [--yes]
```

ou, en variante plus sobre, `agentproto sessions swap-preset <session> --preset <nom>`.

Deroule, en s appuyant sur la TACHE 15 (identifiant d agent stable,
`resolveAgentTarget`, resolution `agent:<x>`) :

1. **Resoudre l agent** : `<agent>` est un `agentId` stable, un
   `operatorLabel` du type `pygmalion-agent-*`, ou un id/slug de session. Le
   resultat est la session vivante (ou son successeur, ou une relance).
2. **Resoudre le prereglage** : soit un `UserPreset` de
   `~/.agentproto/presets.json`, soit le bloc `metadata.agentproto.preset`
   d un manifeste, soit les deux (le manifeste gagne sur les axes qu il
   porte, le preset gagne sur les autres).
3. **Relancer** : `POST /sessions/:id/restart` avec les axes du prereglage
   (model, effort, access, route, posture, contextProfile, harness,
   mcpServers, plus les nouveaux turnRetry / keepAlive). Le daemon reporte
   la filiation, donc l agent garde sa lignee (aucune nouvelle racine).
4. **Deporter les follows** : les follows dont le `selector.sessionIds`
   contient l ancien id sont re-pointes vers le nouvel id. Aujourd hui il
   n existe pas d API de re-point d une cible : le store ne sait re-pointer
   que le *follower* (`session-follow-store.ts:120` `setFollower`), et l
   predicat de couverture ne teste que l id exact
   (`packages/runtime/src/session-follow.ts:258` `sel.sessionIds?.includes(sessionId)`).
   Le re-point d un follow par cible est donc une brique a ajouter (un
   `retargetFollow(followId, fromId, toId)` cote store, expose en MCP et en
   REST `POST /follows`).
   Rappel de la TACHE 15 : la solution durable est `selector.agentIds`, pas
   un re-point manuel a chaque swap.
5. **Deporter les crons** : un cron cible `agent:<label>` survit deja (cible
   resolue au moment du tir, `cron-scheduler.ts:885-950`). Un cron cible un
   id de session brut doit etre re-ecrit, soit vers le nouvel id, soit vers
   `agent:<label>` (recommandation : vers `agent:<agentId>`, ce qui rend le
   cron insensible aux prochains swaps). L ecriture existe deja : verbe
   `cron_update`, route REST `POST /cron/<id>`.
6. **Reappliquer keepAlive et le prompt de reprise** : `keepAlive` est
   reporte par le restart, mais un prereglage "nuit" peut vouloir l eteindre
   ou l allumer explicitement : le preset porte `keepAlive`, et la commande
   appelle `session_set_keepalive` apres le restart. Le `resumeNote` du
   prereglage est injecte dans le premier prompt apres relance (chemin
   `sendPrompt` de la session neuve), ce qui evite le "prompt de reprise"
   ecrit a la main.
7. **Rappeler la memoire a relire** : hors daemon. La commande affiche la
   liste des sources a relire (convention studio : la memoire se relit depuis
   les rapports) et, si l agent porte une declaration de memoire dans son
   manifeste (`memory` AIP-42), les chemins de rapports associes.

En cas d echec, la commande ne doit pas laisser l agent a moitie change :
ordre "restart d abord, re-point ensuite", et chaque re-point est
idempotent (rejouable). Si le restart echoue, rien n a bouge.

Point de vigilance : le re-point des follows doit se faire sur l ancien id
ET le nouvel id, parce que la commande peut etre rejouee apres un echec
partiel. Le store de follows a une cle d UPSERT (`key`,
`session-follow-store.ts:69-98`) : un follow rejoue avec la meme cle est
mis a jour sur place, c est le mecanisme de surete.

## 5. Reponse : generation au build ou au runtime

Les deux, avec une separation claire :

- **Au build (recommande) un generateur de manifestes** : une table
  (agent x prereglage) en entree, des `AGENT.md` en sortie, produits par
  `defineAgent` (validation) + `renderAgentManifest` (rendu canonique, le
  meme chemin que `agentproto agent create` et `emitApp`). Les manifestes
  generes sont commites dans le depot studio : ils sont relusables, diffables
  et revisables. Le prototype de la section 8 est ce generateur.
- **Au runtime (le daemon) un lecteur de prereglage** : le daemon ne
  *genere* rien, il *applique* : il lit le bloc `metadata.agentproto.preset`
  du manifeste (ou un `UserPreset`), le replie sur les axes de session, et
  l applique au spawn ou au restart.

Le runtime ne doit pas devenir un generateur : un agent dont le manifeste est
genere a la main doit rester utilisable tel quel. Regle proposee : le
generateur est un outil de developpement, le daemon ne lit que des
declarations.

## 6. Reponse : prereglages utiles

Table de depart (les valeurs exactes des profils et des modeles sont a
couter sur la convention de l app Pygmalion ; les ids de profils cites sont
ceux de l atelier) :

| Preset | Harnais | Modele | Profil d acces | Posture | effort | contextProfile | keepAlive | turnRetry | Usage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gratuit` | Zen | ws03 (route Zen) | profil gratuit | default | low | lean | false | desactive | nuit longue, veille, rien de couteux |
| `go` | Go | glm-5.3-flash | DeveloperWs003 | default | medium | lean | true | rate_limit, rotate vers gratuit | travail normal, cout maitrise |
| `abonnement` | claude-code | sonnet 5.5 | abonnement Claude | accept-edits | high | full | true | rate_limit | travail de fond qui merite la qualite |
| `economie` | Go | glm-5.3-flash | DeveloperWs003 | read-only | low | lean + autocompact bas | true | rate_limit, seuils de reveil reduits | surveillance, relecture, rapport |
| `nuit` | Go | gratuit (ws03) | profil gratuit | default | low | lean | false | desactive, reveils rares | 02h-07h, rien qui parle a personne |
| `jour` | Go | glm-5.3-flash | DeveloperWs003 | default | medium | full | true | rate_limit, rotate | journee normale |

Regles de composition :

- un prereglage ne fixe qu un sous-ensemble d axes ; les axes absents
  restent ceux de l agent (heritage du manifeste de base) ;
- `turnRetry.rotate` ne peut tourner que vers des modeles libres quand le
  modele courant est gratuit (controle deja existant :
  `packages/runtime/src/turn-retry-policy.ts:158`, applique a l
  enregistrement d un `UserPreset` via `validateTurnRetryRotate`) ;
- les profils d acces nommes doivent exister et etre eligibles pour le rail
  choisi, sinon le swap echoue en 400 explicite (regle deja en place pour
  l override `access`, `session-restart-core.ts:294` `override_invalid`) ;
- `nuit` et `jour` sont des prereglages d horloge, pas des prereglages de
  qualite : ils se distinguent par `keepAlive`, les seuils de reveil et la
  sparse des reveils (le `resumeNote` porte la consigne de reprise).

## 7. Ce que ca change cote conventions de l app Pygmalion

- Les agents permanents portent une ligne de la forme
  `pygmalion-agent-<role>` (operatorLabel, immuable). C est deja la clef de
  grant (`allowPromptFrom`) et la cible de cron (`agent:<label>`). Un swap ne
  doit pas toucher a cette ligne : elle est l identite de l agent, le
  prereglage est son reglage.
- La memoire se relit depuis les rapports : un swap change de modele, donc
  les rapports produits avant et apres ne sont pas homogenes. La commande
  `swap` doit donc rappeler la relecture, et le prereglage `nuit`/`economie`
  porte un `resumeNote` qui l impose.
- Un agent permanent porte typiquement plusieurs crons et plusieurs follows.
  Les crons en `agent:<label>` survivent ; ceux en id brut et les follows
  par cible ne survivent pas : c est le besoin immediat de la commande
  unique.

## 8. Prototype : `gen-presets.ts` (table -> AGENT.md)

Fichier : `night-deliverables/agent-presets/gen-presets.ts` (livre dans le plan
v1, branche `night/t16-agent-presets-swap`).

Ce que fait le prototype :

1. declare une table de prereglages (les six de la section 6) ;
2. declare des agents de base (superviseur, PM, concepteur) ;
3. pour chaque couple (agent, prereglage) fusionne la definition de base avec
   les axes du prereglage (le prototype fait le merge que le daemon ne fait
   pas encore, section 2.3), pose `extends: <id de base>` et un bloc
   `metadata.agentproto.preset` ;
4. valide avec `defineAgent` (AIP-42) et rend avec `renderAgentManifest`
   (le rendu canonique) ;
5. ecrit l agent de base (`<out>/.agents/<agent>/AGENT.md`) puis une variante
   par prereglage (`<out>/.agents/<agent>-<preset>/AGENT.md`), et affiche un
   tableau recapitulatif ;
6. relit le dernier manifeste ecrit avec le chargeur AIP-42 (`loadAgent`) et
   verifie que la chaine `extends` resout, ce qui prouve que les manifestes
   produits sont utilisables tels quels.

Exemple qui tourne :

```sh
pnpm install --filter "@agentproto/agent..." --filter "@agentproto/app-kit..."
pnpm --filter "@agentproto/agent..." --filter "@agentproto/app-kit..." build
node --experimental-strip-types night-deliverables/agent-presets/gen-presets.ts --out /tmp/presets
```

Le script lit les dist construites (`packages/agent/dist/index.mjs`,
`packages/app-kit/dist/index.mjs`) : il n a pas besoin du reste du
monorepo. Il est volontairement hors de tout package publie (il ne modifie
aucun `src/**` d un package publie, donc pas de changeset).

Sortie observee : 21 manifestes (3 agents de base + 18 variantes), et une
rellecture qui confirme le prereglage et la chaine `extends`.

Limites assumees du prototype :

- le merge est fait a la generation, pas au runtime ;
- les valeurs de profil d acces sont des exemples a recaler sur l atelier ;
- les crons et les follows ne sont pas encore deplaces (c est la partie
  daemon de la section 4).

## 9. Decoupage propose (PR a venir, hors de cette tache lecture seule)

| PR | Contenu | Dependance |
| --- | --- | --- |
| P1 | Merge `extends` au runtime (`agent-extends.ts`) + tests | aucune |
| P2 | Lecture du bloc `metadata.agentproto.preset` au spawn et au restart (`turnRetry`, `keepAlive` en overrides) | P1 |
| P3 | Re-point des follows par cible (`retargetFollow`) + re-point des crons a id brut | TACHE 15 PR 1 et 2 (agentId porte) |
| P4 | Commande `agentproto agents swap <agent> --preset <nom>` (CLI + MCP) | P2, P3 |
| P5 | Affichage : preset courant dans `session_list`, dans l entete VS Code et dans session-chat | P2 |
| P6 | Provenance de preset sur le descripteur + re-resolution du preset au restart et au restartPolicy | P2 |
| P7 | Chaine de repli dans le prereglage (`fallback`) + garde-fou de cout | P6 |

Ordre importe : sans P3, la commande de swap reproduit le probleme qu elle
est censee resoudre (des follows perdus au passage).

## 10. Risques et points a trancher

1. **Un prereglage qui change de wallet sans controle** : le prereglage
   porte `access.profileRef`. Le controle existant (profil inconnu ou
   ineligible = 400) doit s appliquer a l override de preset, et le swap
   doit journaliser l ancien et le nouveau profil.
2. **Un prereglage qui change de posture** : passer en `bypass` par un
   preset est une montee de privilege. Recommandation : interdire `bypass`
   dans un prereglage portable, ou exiger une option explicite
   `--allow-privilege`.
3. **`extends` non merge** : si le merge arrive (P1), un manifeste enfant peut
   heriter de `tools`, donc elargir ou restreindre les outils du gateway.
   Regle proposee : l enfant herite des outils mais ne peut pas en ajouter
   au-dela de l union, et le merge est trace.
4. **`metadata` comme espace de prereglage** : `metadata` est libre, donc
   n importe quel manifeste peut declarer un prereglage. C est voulu (le
   manifeste est la source), mais un manifeste non signe pourrait faire
   basculer un agent vers un wallet different. Recommandation : un prereglage
   qui porte un `access.profileRef` exige une option operateur au swap
   (`--yes` ou confirmation), meme pour l operateur du daemon.
5. **Double source de verite** : `UserPreset` (fichier local) et bloc de
   manifeste. Recommandation : le manifeste gagne sur les axes qu il porte,
   l utilisateur voit le diff avant application (`--dry-run`).
6. **Le prototype fusionne, le runtime non** : tant que P1 n est pas landed,
   le merge n existe que dans le generateur. Les manifestes produits par le
   prototype sont donc complet (tous les champs ecrits), pas des enfants
   partiels : c est ce qui les rend utilisables tels quels.
7. **Un bot qui bascule le preset sans garde-fou** : c est le sujet du
   point 7 (section 13). Le risque central est la montee de cout
   automatique : la regle "free reste free" doit etre appliquee au niveau du
   bot, pas seulement au niveau de `turnRetry.rotate`.

## 11. POINT 6 : les deux primitives de prereglage qui existent deja

Le daemon possede deja deux primitives de prereglage distinctes. Il faut
les nommer correctement, parce qu elles ne se repondent pas.

### 11.1 Primitive A : les harnais par defaut (`harness-presets.json`)

Store : `packages/runtime/src/harness-preset-store.ts`, fichier
`~/.agentproto/harness-presets.json` (`harnessPresetsPath()`,
`harness-preset-store.ts:110`), format versionne, ecriture `0600`.

Une entree `HarnessPreset` (`harness-preset-store.ts:47`) lie :

| Champ | Role |
| --- | --- |
| `id` | id stable, unique |
| `harnessSlug` | le harnais (adapte a `spawn.harness ?? spawn.adapter`) |
| `name` | libelle |
| `profileRef` | le profil d acces facturé (doit exister et etre actif, verifie a l ecriture) |
| `defaultModel` | le modele applique quand l appelant n en nomme pas |
| `isDefault` | au plus UN default par `harnessSlug` (invariant verifie a l ecriture) |
| `turnRetry` | politique de retry du spawn qui resout CE preset (avec `rotate`) |

Outils MCP : `harness_preset_list`, `harness_preset_create`,
`harness_preset_delete`, `harness_preset_set_default`
(`packages/runtime/src/harness-preset-tools.ts:107`, `:144`, `:190`, `:210`).

**Ou c est applique** : au spawn uniquement, dans la couche de plus basse
precedence de `spawnAgentSession` (`session-spawn.ts:2158` et suivantes) :
si ni la requete ni un prereglage utilisateur n a nomme de
`access.profileRef`, le default du harnais remplit `access.profileRef`, puis
`model` si le modele n est pas nomme, puis `turnRetry` si absent. Si le profil
du preset a disparu ou est desactive, le spawn echoue explicitement avec le
code `harness_preset_profile_unavailable` (`session-spawn.ts:2170-2185`).

Point cle : le default de harnais ne s applique **qu au spawn**. Il n est
pas relu au restart, et il n est pas adressable par `presetId`.

### 11.2 Primitive B : les prereglages de lancement (`presets.json`, `presetId`)

Store : `packages/runtime/src/user-presets.ts`, fichier
`~/.agentproto/presets.json` (`userPresetsPath()`, `user-presets.ts:110`).
Un `UserPreset` (`user-presets.ts:35`) porte les axes :
`adapter` / `harness`, `model`, `route` (gateway + baseUrl),
`access.profileRef`, `posture`, `effort`, `contextProfile`, `cwd`, `skills`,
`bundles`, `browser`, `turnRetry`, plus `id`, `label` et `lastUsedAt`
(timestamp de dernier usage, pose par `touchUserPreset`, `user-presets.ts:166`).

Surfaces :

- CLI : `agentproto preset list|show|add|delete`
  (`packages/cli/src/commands/preset.ts`) ;
- MCP : `user_preset_list`, `user_preset_save`, `user_preset_delete`
  (`packages/runtime/src/user-preset-tools.ts`) ;
- REST : `GET /user-presets`, `POST /user-presets`,
  `DELETE /user-presets/:id` (`http-server.ts:4488-4531`).

### 11.3 Ou `presetId` est accepte aujourd hui

| Surface | Code | Resolution |
| --- | --- | --- |
| MCP `agent_start` | `agent-tools.ts:443` (`getUserPreset(input.presetId)`) | un presetId inconnu = erreur explicite, avant tout contact avec l adaptateur (`agent-tools.ts:444-448`) |
| REST `POST /sessions/agent` | `http-server.ts:6919` | id inconnu = 400 `preset_not_found` |
| REST `POST /sessions/chat` | `http-server.ts:7013` | idem |
| Cron, action `kind: "agent"` | `cron-scheduler.ts:1057` (`fields.presetId`) | le preset fournit l adaptateur et les axes du spawn de tick |
| CLI `sessions --preset <id>` | `packages/cli/src/commands/sessions.ts:1126` | corps `presetId` |
| VS Code, spawn picker | `packages/vscode/src/commands/spawn.ts:243` | idem |

Precedence des couches, du plus fort au plus faible :

1. la requete explicite (spawn, `agent_start`, cron) ;
2. le `UserPreset` resolu par `presetId` (`session-spawn.ts:2136-2160` :
   chaque axe non explicite prend la valeur du preset) ;
3. le default du harnais (`harness-presets.json`, `session-spawn.ts:2158`).

Une precision qui compte pour le swap : `presetId` ne resout **que** un
`UserPreset`. Un id de harnais par defaut passe par `presetId` et n est pas
trouve : `getUserPreset` ne lit que `presets.json`
(`agent-tools.ts:443`, `user-presets.ts:137`). Les deux stores sont donc
distincts, et le default de harnais n a pas d id adressable par `presetId`
malgre son champ `id`.

### 11.4 Ce que "Jeremy change la valeur du preset UNE fois" couvre deja

Si Jeremy edite `~/.agentproto/presets.json` (ou appelle
`user_preset_save`) :

- **tous les lancements futurs qui nomment ce `presetId`** suivent la
  nouvelle valeur : `agent_start`, `POST /sessions/agent`,
  `POST /sessions/chat`, cron `kind: "agent"`, CLI, VS Code. Le preset est
  relu a chaque spawn, il n est pas fige dans un cache ;
- **tous les spawns qui tombent sur le default du harnais** suivent aussi la
  nouvelle valeur, pour les memes raisons (lecture du store a chaque spawn) ;
- **rien d autre** : ni une session vivante, ni un restart, ni un
  auto-restart.

## 12. POINT 6 : ce qui manque pour qu une session vivante suive son prereglage

Cinq trous precis, du plus structurel au plus conjoncturel.

### 12.1 Aucune provenance : le descripteur ne retient pas le prereglage

`SessionDescriptor` ne porte aucun champ de preset (relecture de
`sessions.ts` : ni `presetId`, ni `presetRef`, ni hash de preset ; les seules
mentions de "preset" dans `sessions.ts` sont des commentaires sur les skills
`explicit ∪ preset ∪ config-defaults`, lignes 2267 et 5388). Consequence
directe : au moment du restart, le daemon ne sait pas quel prereglage a
produit la session. Il ne peut donc pas re-resoudre ce prereglage, meme si la
commande de swap lui passait l information.

Brique proposee : un champ `preset?: { id: string; kind: "user" | "harness"; hash: string }`
sur le descripteur, pose au spawn (`spawnAgentSession`) et reporte par le
restart (comme `keepAlive` et `turnRetry` le sont deja,
`session-restart-core.ts:1541` et `:1545`), plus un affichage dans
`session_list` (PR P5).

### 12.2 Le restart lit des champs figes, pas un prereglage

Le coeur du restart (`session-restart-core.ts:1099-1131`) calcule un
`effective` par superposition : `overrides` (ce que le caller demande) >
`prev` (les champs figes de la session precedente). Le modele, l effort, la
posture, le contextProfile, le harnais et l `access` viennent donc de la
session, jamais d un prereglage.

Les axes `keepAlive` et `turnRetry` sont reportes tels quels
(`session-restart-core.ts:1541`, `:1545` et `:2201`, `:2205`) : ils sont
recopies depuis `prev`, donc figes eux aussi. C est exactement le symptome
signale : "relance a chaud depuis son prereglage" et "restart qui relit le
prereglage au lieu des champs figes de la session" demandent la meme chose.

Surfaces a etendre :

- MCP `session_restart` (`packages/runtime/src/session-tools.ts:5228`) :
  accepte aujourd hui `model`, `effort`, `access.profileRef`, `route`,
  `posture`, `contextProfile`, `mode`, `mcpServers`. Il faut ajouter
  `presetId`, `keepAlive`, `turnRetry`, et `harness` cote REST (le MCP a
  deja `harness`, le REST non) ;
- REST `POST /sessions/:id/restart` (`http-server.ts:8227-8330`) : meme
  liste d overrides a elargir. Les codes d erreur existants
  (`override_invalid`, 400) sont reutilisables pour un preset invalide ;
- la resolution : si `presetId` est fourni, le preset est resolu **au moment
  du restart** (pas au moment du spawn), et ses axes overlays le `prev`
  fige, avec la meme precedence que le spawn (requete > preset > prev) ;
- si la session avait ete lancee par le default du harnais (et pas par un
  `UserPreset`), le restart doit re-resoudre le default du harnais a ce
  moment-la, sinon l ancien profil reste fige.

### 12.3 L auto-restart ressuscite sur le vieux wallet

`restart-scheduler.ts` (politique `restartPolicy` sur le descripteur :
`crashed`, `killed-mid-turn`, `sandbox-gone`) ressuscite une session morte
depuis le meme descripteur. Consequence : un superviseur qui a crashe apres
un changement de preset (ou apres l epuisement du credit qui a provoke le
crash) revient sur l ancien profil et l ancien modele. C est un cas reel du
21/10.

Brique proposee : au moment de la decision de revival, si le descripteur
porte une provenance de preset, le restart-policy reapplique le preset
courant (meme semantique que 12.2). La decision doit rester explicite dans
le journal : "revive avec le preset X", pas "revive tel quel".

### 12.4 Le swap a chaud n existe que par axe, et pas pour le wallet

Ce que le daemon sait faire a chaud sur une session VIVANTE :

| Axe | Surface | Limite |
| --- | --- | --- |
| Modele | `POST /sessions/:id/model` -> `registry.setModel` (`http-server.ts:8192`) | modele seul, meme profil |
| Effort | route `/sessions/:id/effort` (`http-server.ts` apres le bloc model) | idem |
| Posture | `setPosture` : mode natif du harnais | posture native seulement, pas un changement de harnais |
| Profil d acces | aucun | **impossible a chaud** : le wallet est lie au processus de facturation du harnais |
| Harnais | aucun a chaud | il faut un restart |

Il n existe donc aucune operation "appliquer un prereglage a une session
vivante". Le seul chemin complet est le restart, et le restart today relit
des champs figes (12.2).

Brique proposee : un verbe `session_apply_preset` (MCP + REST
`POST /sessions/:id/apply-preset`) qui :

1. resout le preset ;
2. calcule le diff axe par axe contre le descripteur vivant ;
3. pour les axes hot (model, effort, posture native), applique a chaud et
   journalise ;
4. pour le reste (wallet, harnais, contextProfile), fait un
   restart-with-overrides, donc avec le re-point des follows et des crons
   (section 4) ;
5. refuse par defaut tout changement de wallet sans confirmation operateur
   (section 10, point 4).

Ce verbe est le point d accroche du bot de la section 13.

### 12.5 Aucun binding "preset" vers "agent" ou "session"

Rien ne dit "le superviseur X utilise le preset Y". La resolution est
toujours implicite :

- soit le lanceur passe `presetId` a chaque spawn (et le forget quand le
  preset change) ;
- soit le cron passe `presetId` dans son action (`cron-scheduler.ts:1057`) ;
- soit le default du harnais s applique par defaut.

Consequence pour le swap "d un coup" : si Jeremy edite le preset, rien ne
rattache ce preset au superviseur vivant ; le superviseur ne le suivra que si
le chemin de relance lit le preset (12.2) ou si un binding explicite
existe.

Briques proposees :

- un binding par agent stable (TACHE 15 : `agentId`), porte par le
  descripteur ou par une table `agent -> presetId` ;
- ou, plus simple et sans nouvel objet : le preset porte une liste
  `targets: ["agent:<label>"]` et le daemon s en sert au swap pour
  re-pointer les sessions concernees.

Sans ce binding, "changer le preset UNE fois" ne veut dire "changer pour
les prochains lancements" que, pas "changer pour cet agent la".

### 12.6 Synthese du point 6

| Question | Reponse |
| --- | --- |
| `presetId` couvre quoi ? | Les axes du spawn : harnais, modele, route, profil d acces, posture, effort, contextProfile, cwd, skills, bundles, browser, turnRetry |
| Ou ? | `agent_start`, `POST /sessions/agent`, `POST /sessions/chat`, cron `kind: "agent"`, CLI, VS Code |
| Un changement du preset est-il vu par les lancements suivants ? | Oui, immediatement : le store est relu a chaque spawn |
| Est-il vu par une session VIVANTE ? | Non : aucun axe de la session vivante n est couple au preset, et le descripteur ne retient meme pas l id du preset |
| Est-il vu par un restart ? | Non : le restart reporte les champs figes de `prev` ; `presetId`, `keepAlive` et `turnRetry` ne sont pas des overrides acceptes |
| Est-il vu par un auto-restart ? | Non : `restartPolicy` ressuscite depuis le descripteur, donc sur l ancien wallet |
| Est-il vu par un cron `agent:<label>` ? | Non pour le preset, oui pour la cible : le cron re-resout le label a chaque tir (`cron-scheduler.ts:885-950`) et re-prompt la session vivante, mais ne change pas ses axes |
| Ce qu il manque, en une phrase | Une provenance de preset sur le descripteur, plus une re-resolution du preset au restart et a l auto-restart, plus un binding preset/agent, plus un verbe d application a chaud |

## 13. POINT 7 : le bot de bascule globale

### 13.1 Le cas reel du 21/10

Cle Zen expiree, credit API a zero, abonnement presque epuise : trois
signaux qui se combinent. Aucun n declenche une bascule aujourd hui. Le
`turnRetry.rotate` ne declenche rien non plus, parce qu il n a de declencheur
que l erreur d un tour, et qu il ne touche qu au modele d une session.

### 13.2 Ce que fait deja `turnRetry.rotate`

Source : `packages/runtime/src/turn-retry.ts` (politique) et
`packages/runtime/src/turn-retry-policy.ts` (formes).

- **Declencheur** : une erreur de tour d une classe couverte par `on` /
  `rotateOn` (`rate-limit`, `upstream-5xx`, `no-output-stall`), donc
  **APRES** l erreur, et seulement si le tour a echoue.
- **Portee** : **une session**. `rotateIfConfigured` (`turn-retry.ts:515-560`)
  appelle `registry.setModel(id, target.model)` sur la session concernee.
- **Ce qui change** : le modele, sur le **profil courant** de la session. La
  regle v1 est explicite : un target qui nomme un `profileRef` different du
  profil courant est rejete   (`turn-retry.ts:405-411`,
  `rotationTargetRejection`). Donc **le wallet ne change jamais** par
  rotation.
- **Garde-fou** : "free reste free". Un modele OpenCode gratuit ne peut
  tourner que vers un id gratuit (`validateTurnRetryRotate`,
  `turn-retry-policy.ts:158`, et sa re-application au moment de la rotation,
  `turn-retry.ts:406`). Une session payante n a pas de liste de rotation par
  defaut (`defaultTurnRetryForSpawn`).
- **Memoire** : une carte de refroidissement **daemon-wide par modele**
  (`model-cooldowns.ts`), ce qui evite de reboucler sur un modele throttle.
- **Silence** : si aucune cible n est eligible, le retry retombe sur un
  simple retry, sans escalade ni notification.

Ce que `turnRetry.rotate` ne fait donc pas : ne change pas de preset, ne
change pas de profil, ne change pas de harnais, ne touche pas aux autres
sessions, ne fait rien avant l erreur.

### 13.3 Ce que ferait le bot

Le bot est un agent de surveillance (cron ou sentinelle) sur un modele
**gratuit**, qui re-analyse la situation **avant** que l erreur n arrive et
bascule le prereglage **globalement** vers le suivant d une liste de repli.

| | `turnRetry.rotate` | Bot de bascule |
| --- | --- | --- |
| Declencheur | Erreur de tour, apres coup | Etat de sante des profils, avant coup |
| Portee | Une session | Le prereglage, donc tous les lancements et relances |
| Ce qui bouge | Le modele de la session | Le preset : profil d acces, modele, harnais, turnRetry |
| Wallet | Jamais (profil courant impose) | Oui, c est le point : on change de wallet |
| Garde-fou cout | Free reste free, par session | Free reste free, globalement, et jamais de montee de cout sans accord |
| Memoire | Carte de refroidissement par modele | Etat de sante par profil + historique de bascule |

### 13.4 Signaux disponibles cote daemon

| Signal | Source | Etat |
| --- | --- | --- |
| Quota live d un profil | outil MCP `quota_status` (`packages/runtime/src/quota-status-tool.ts`), lecteurs OpenRouter et Moonshot (`createQuotaReaderRegistry`) | existe ; renvoie un negatif explicite (`profile_not_found`, `no_reader`) plutot qu un zero fabrique |
| Credits prepaid restants | `packages/runtime/src/account-credits.ts` (`balanceUsd`, base `provider`) | existe cote daemon, mais **pas expose en outil MCP** |
| Quota glissant Anthropic | `packages/runtime/src/remaining-quota.ts` + `remaining-quota-store.ts` | existe, utilise en enrichment de spawn |
| Profil absent ou desactive | `auth_profile_list`, `auth_profile_set_enabled` (noms d outils dans `daemon-tool-names.generated.ts:65-73`) ; detection au spawn via `harness_preset_profile_unavailable` (`session-spawn.ts:2170`) | existe |
| Expiration du credential | `packages/auth/src/broker.ts` (renouvellement proactive, `EXPIRY_SKEW_MS`) ; le store de profils ne porte pas de champ d expiration | **angle mort** : rien ne dit "cette cle expire le 21/10" avant l echec |
| Modeles en refroidissement | carte daemon-wide `model-cooldowns.ts`, alimentee par le controleur de turn-retry | existe mais **non interrogeable** par un tiers |

Trous a combler pour que le bot ait une image complete : un outil de lecture
"etat d un profil" qui agrege expiration du credential, credits restants et
quota, et une lecture de la carte de refroidissement. Sans cela, le bot voit
les symptoms (le spawn qui echoue) et non les causes.

### 13.5 Design du bot

Trois etapes, dans cet ordre.

1. **Collecte et verdict.** Le bot (cron, action `kind: "agent"`, cible
   `agent:<label>` du superviseur ou un `agent:` dedie, sur un preset
   gratuit) interroge l etat de sante : pour chaque profil du prereglage
   courant, `quota_status`, expiration, credits, et l etat du harness
   default. Il rend un verdict parmi `ok`, `degrade`, `sec`. Un profil dont
   la cle est expiree ou dont le credit est a zero est `sec` ; un profil sous
   un seuil (par exemple 20 % de quota restant, ou une expiration dans
   moins de 48 h) est `degrade`.
2. **Choix de la cible.** Le prereglage porte une chaine de repli, par
   exemple `fallback: ["gratuit", "nuit"]` : le bot descend la chaine et
   s arrete sur le premier prereglage dont les profils sont `ok`. Si aucun
   prereglage de la chaine n est sain, le bot **ne bascule pas** et escalade
   (il ne descend pas vers un prereglage paye non approuve).
3. **Application et trace.** Le bot applique le prereglage retenu en ecrivant
   le prereglage de l agent (par exemple `user_preset_save` ou
   `harness_preset_set_default`, avec la convention du point 13.7), puis
   propose ou lance les relances (le verbe `session_apply_preset` de la
   section 12.4, ou un simple message dans le canal de l agent). Chaque
   bascule est journalisee : profil precedent, profil nouveau, raison,
   horodatage, verdict.

Le bot tourne sur un modele gratuit et ne consomme donc pas ce qu il
supervise : c est la condition pour qu il reste disponible quand tout le
reste est a sec.

### 13.6 Garde-fous (le point non negociable)

1. **Jamais de montee de cout sans accord.** Une cible de repli dont le
   modele est payant (ou dont le profil est un abonnement payant) n est
   appliquee que si Jeremy l a prealablement approuvee. Deux formes
   possibles :
   - une liste `fallbackApproved` explicite dans le prereglage, que seule
     une action operateur peut ecrire (le bot n a pas le droit de l
     ecrire) ;
   - ou une regle plus simple : le bot ne bascule qu vers des prereglages
     gratuits, et *propose* (message, follow, rapport) le passage a un
     prereglage payant, sans l appliquer.
   La regle technique de base est deja dans le code : "free reste free"
   (`isOpencodeFreeModel`, `validateTurnRetryRotate`,
   `turn-retry-policy.ts:145-170`). Le bot doit reutiliser cette
   verification, et l etendre a l axe du profil d acces, que la rotation
   ne touche pas.
2. **Jamais de bascule en boucle.** Le bot memorise la derniere bascule
   (preset, horodatage, raison) et respecte un delai minimum entre deux
   bascules, plus la carte de refroidissement par modele deja existante.
3. **Bascule idempotente et rejouable.** Reecrire le meme preset est un
   no-op ; le bot doit pouvoir rejouer son cycle sans effet de bord.
4. **Aucune bascule silencieuse.** Toute bascule est tracee et notifiee, avec
   le motif en clair (cle expiree, credit a zero, quota bas, abonnement
   epuise).
5. **Le bot ne fait pas le travail.** Il bascule et propose ; l execution
   du travail relu reste une decision humaine ou du superviseur, sinon on
   tombe dans le pile-up de nuit decrit en section 7.

### 13.7 Ou le bot ecrit la bascule

Deux origines possibles, et il faut trancher :

- **Ecrire le prereglage de l agent** (le preset `superviseur` ou
  `pm` passe de `{access: {profileRef: A}}` a `{access: {profileRef: B}}`) :
  le changement est visible par tous les lancements, y compris ceux d
  aujourd hui, mais les sessions deja vivantes ne bougent pas (il faut
  ensuite la relance).
- **Reecrire le default du harnais** (`harness_preset_set_default`) : plus
  radical, il touche tous les spawns de ce harnais, pas seulement l agent
  vise.

Recommandation : la premiere (preset de l agent), avec le binding
preset/agent de la section 12.5 pour que "le preset de l agent" soit
nomme et non devine. Le default du harnais reste une reserve pour les
spawns sans agent identifie.

### 13.8 Etat de l art cote daemon pour un premier bot

Un premier bot est faisable **sans aucune modification du daemon** :

- cron `kind: "agent"`, `presetId` = un preset gratuit, `sessionId` =
  `agent:<label>` du bot ou d un superviseur, `prompt` = la consigne
  d analyse (les outils du daemon sont exposes a la session via le gateway
  MCP) ;
- outils deja disponibles : `quota_status`, `auth_profile_list`,
  `user_preset_list`, `user_preset_save`, `harness_preset_list`,
  `harness_preset_set_default`, `session_restart` ;
- le bot ecrit le preset cible avec `user_preset_save` et propose la
  relance.

Ce qui manque pour la version serieuse :

- un outil "etat d un profil" (expiration + credits + quota) : le bot ne voit
  pas aujourd hui la cause (cle expiree, credit a zero) ;
- la lecture de la carte de refroidissement ;
- le binding preset/agent (12.5) et le verbe `session_apply_preset` (12.4),
  pour que la bascule s applique aussi aux sessions vivantes et non
  seulement aux lancements futurs ;
- une trace de bascule persistee (fichier sous `~/.agentproto/`, ou table du
  daemon) pour le garde-fou anti-boucle et l audit.

## 14. Sources consultees

- `packages/agent/src/define-agent.ts`, `schema.ts`, `types.ts`,
  `manifest/index.ts`, `load-agent.ts`, `validate-extends-chain.ts` ;
- `packages/runtime/src/agent-projection.ts`, `spawn-agent-manifest.ts`,
  `session-config.ts`, `user-presets.ts`, `user-preset-tools.ts`,
  `harness-preset-store.ts`, `harness-preset-tools.ts`,
  `turn-retry-policy.ts`, `turn-retry.ts`, `model-cooldowns.ts`,
  `session-restart-core.ts`, `session-continue-fresh.ts`, `restart-scheduler.ts`,
  `sessions.ts`, `session-follow-store.ts`, `session-follow.ts`,
  `cron-scheduler.ts`, `agent-start-schema.ts`, `agent-tools.ts`,
  `quota-status-tool.ts`, `remaining-quota.ts`, `account-credits.ts`,
  `http-server.ts` (routes `/sessions/agent`, `/sessions/chat`,
  `/sessions/:id/restart`, `/user-presets`), `session-tools.ts` (verbes
  `session_restart`, `session_set_keepalive`), `session-follow-tools.ts` ;
- `packages/auth/src/types.ts`, `profile-types.ts`, `broker.ts` ;
- `packages/app-kit/src/emit.ts` (`renderAgentManifest`), `packages/cli/src/
  commands/agent.ts` (`agentproto agent create`), `packages/cli/src/commands/
  preset.ts` (`agentproto preset`, CRUD de `UserPreset`),
  `packages/cli/src/commands/sessions.ts` (`--preset`), `packages/vscode/src/
  commands/spawn.ts` ;
- `night-deliverables/agent-identity/PLAN.md` (TACHE 15) ;
- `origin/night/t15-agent-identity-plan`, commit `bca28a88` ;
- `origin/night/t16-agent-presets-swap`, commit `f72d8f9d` (plan v1).
