# TACHE 16 - Prereglages d agent a changer d un coup (swap de superviseur)

Lecture seule cote daemon : aucun code de production n est modifie par ce
document. Reference : etat de `origin/main` au commit `fb025f0b` (feat(sandbox):
reap orphan computer boxes in sandbox gc (#2164)).

Le seul code livre ici est un prototype hors paquete :
`night-deliverables/agent-presets/gen-presets.ts` (table agent x prereglage ->
AGENT.md), avec un exemple qui tourne (voir section 8).

Plan lie : `night-deliverables/agent-identity/PLAN.md` (TACHE 15, branche
`night/t15-agent-identity-plan`). Ce plan s appuie sur lui pour la filiation :
identifiant d agent stable, resolution agent -> session vivante, adressage
`agent:<x>`.

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

## 2. Reponse (1) : ce que porte AGENT.md / defineAgent, et ce qu il ne porte pas

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

- profil d acces / wallet : `access.profileRef` (session-config.ts:132) ;
- harnais : `harness` (session-config.ts:164) ;
- rail de facturation : `route` (gateway + baseUrl, session-config.ts:134) ;
- posture : `posture` (session-config.ts:136) ;
- effort : `effort` (session-config.ts:126) ;
- contextProfile : `contextProfile` (session-config.ts:138) ;
- turnRetry et sa liste `rotate` : `packages/runtime/src/turn-retry-policy.ts` ;
- keepAlive : `SessionDescriptor.keepAlive` (`sessions.ts:1898`), bascule
  ensuite par le verbe `session_set_keepalive` ;
- sandbox, mcpServers, costBudget, contextContinuity ;
- follows, crons, resume prompt : ce sont des objets du daemon, hors du
  cycle de vie du manifeste.

Autrement dit : **le manifeste decrit qui est l agent, pas comment il est
runne cette fois-ci.** Un prereglage est de la seconde categorie.

### 2.3 Le trou le plus.Structurel : `extends` ne herite de rien

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

## 3. Reponse (2) : un prereglage = manifeste enfant qui extends un agent de base

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
  2. le frontmatter AIP-42 n'a pas de champ pour un prereglage : il faut
     passer par `metadata` ;
  3. meme avec `metadata.agentproto.preset` present, le daemon ne sait pas
     le lire : `loadAgentManifestDefaults` ne lit que `model`, `tools`,
     instructions, `skills`, `options` et `metadata.hooks.clerk`
     (`spawn-agent-manifest.ts:133-153`) ;
  4. le MCP `agent_start` n'expose ni `agentId` ni `agentPath`
     (`packages/runtime/src/agent-start-schema.ts` : aucune occurrence), alors
     que le REST et le CLI les exposent : surface non homogene ;
  5. le restart n'a pas d'axe `turnRetry` ni `keepAlive` en override, et la
     route REST `POST /sessions/:id/restart` (`http-server.ts:8222`) n'accepte
     ni `harness` ni `turnRetry` (le verbe MCP `session_restart` accepte
     `harness`, pas `turnRetry` non plus).

### 3.2 Ce qu il manque cote daemon pour lancer/relancer un agent avec un prereglage

Trois briques, dans cet ordre :

1. **Un merge `extends` au runtime** (ou une resolution de prereglage dediee).
   Un module du type `packages/runtime/src/agent-extends.ts` qui, pour un
   handle enfant, charge le parent (meme convention de chemin que
   `load-agent.ts:48`) et fusionne champ par champ : l'enfant gagne, le
   parent fournit le manque, la fusion des listes est "enfant remplace
   parent" sauf pour `tools`/`skills` ou l'union triee est preferable. Le
   generateur de la section 8 en est le prototype de semantique.
2. **Un prereglage declare et lu par le daemon**. Choix retenu : un bloc
   `metadata.agentproto.preset` dans le manifeste, parce que `metadata` est
   deja le(namespace des reglages propres au daemon (precedent :
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
   l'applique comme un `presetId` deja existant
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
     n'est plus associe a un agent stable apres le swap.

## 4. Reponse (3) : une commande unique de swap

Commande visee :

```
agentproto agents swap <agent> --preset <nom> [--dry-run] [--yes]
```

ou, en variante plus sobre, `agentproto sessions swap-preset <session> --preset <nom>`.

Deroule, en s'appuyant sur la TACHE 15 (identifiant d agent stable,
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
   contient l ancien id sont re-pointes vers le nouvel id. Today il n'existe
   pas d'API de re-point d'une cible : le store ne sait re-pointer que le
   *follower* (`session-follow-store.ts:120` `setFollower`), et l' predicat
   de couverture ne teste que l'id exact
   (`packages/runtime/src/session-follow.ts:262` `sel.sessionIds?.includes(sessionId)`).
   Le re-point d'un follow par cible est donc une brique a ajouter (un
   `retargetFollow(followId, fromId, toId)` cote store, expose en MCP et en
   REST `POST /follows`).
   Rappel de la TACHE 15 : la solution durable est `selector.agentIds`, pas
   un re-point manuel a chaque swap.
5. **Deporter les crons** : un cron cible `agent:<label>` survit deja (cible
   resolue au moment du tir, `cron-scheduler.ts:746-812` et `:885-950`). Un
   cron cible un id de session brut doit etre re-ecrit, soit vers le nouvel
   id, soit vers `agent:<label>` (recommandation : vers `agent:<agentId>`,
   ce qui rend le cron insensible aux prochains swaps). L'ecriture existe
   deja : verbe `cron_update`, route REST `POST /cron/<id>`.
6. **Reappliquer keepAlive et le prompt de reprise** : `keepAlive` est
   reporte par le restart, mais un prereglage "nuit" peut vouloir l'eteindre
   ou l'allumer explicitement : le preset porte `keepAlive`, et la commande
   appelle `session_set_keepalive` apres le restart. Le `resumeNote` du
   prereglage est injecte dans le premier prompt apres relance (chemin
   `sendPrompt` de la session neuve), ce qui evite le "prompt de reprise"
   ecrit a la main.
7. **Rappeler la memoire a relire** : hors daemon. La commande affiche la
   liste des sources a relire (convention studio : la memoire se relit depuis
   les rapports) et, si l'agent porte une declaration de memoire dans son
   manifeste (`memory` AIP-42), les chemins de rapports associes.

En cas d'echec, la commande ne doit pas laisser l'agent a moitie change :
ordre "restart d'abord, re-point ensuite", et chaque re-point est
idempotent (rejouable). Si le restart echoue, rien n'a bouge.

Point de vigilance : le re-point des follows doit se faire sur l'ancien id
ET le nouvel id, parce que la commande peut etre rejouee apres un echec
partiel. Le store de follows a une cle d'UPSERT (`key`,
`session-follow-store.ts:69-98`) : un follow rejoue avec la meme cle est
mis a jour sur place, c'est le mecanisme de surete.

## 5. Reponse (4) : generation au build ou au runtime

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
  l'applique au spawn ou au restart.

Le runtime ne doit pas devenir un generateur : un agent dont le manifeste est
genere a la main doit rester utilisable tel quel. Regle proposee : le
generateur est un outil de developpement, le daemon ne lit que des
declarations.

## 6. Reponse (5) : prereglages utiles

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

- un prereglage ne fixe qu'un sous-ensemble d'axes ; les axes absents
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
  `pygmalion-agent-<role>` (operatorLabel, immuable). C'est deja la clef de
  grant (`allowPromptFrom`) et la cible de cron (`agent:<label>`). Un swap ne
  doit pas toucher a cette ligne : elle est l'identite de l agent, le
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

Fichier : `night-deliverables/agent-presets/gen-presets.ts`.

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
- les crons et les follows ne sont pas encore deplaces (c'est la partie
  daemon de la section 4).

## 9. Decoupage propose (PR a venir, hors de cette tache lecture seule)

| PR | Contenu | Dependance |
| --- | --- | --- |
| P1 | Merge `extends` au runtime (`agent-extends.ts`) + tests | aucune |
| P2 | Lecture du bloc `metadata.agentproto.preset` au spawn et au restart (`turnRetry`, `keepAlive` en overrides) | P1 |
| P3 | Re-point des follows par cible (`retargetFollow`) + re-point des crons a id brut | TACHE 15 PR 1 et 2 (agentId porte) |
| P4 | Commande `agentproto agents swap <agent> --preset <nom>` (CLI + MCP) | P2, P3 |
| P5 | Affichage : preset courant dans `session_list`, dans l'entete VS Code et dans session-chat | P2 |

Ordre importe : sans P3, la commande de swap reproduit le probleme qu elle
est censee resoudre (des follows perdus au passage).

## 10. Risques et points a trancher

1. **Un prereglage qui change de wallet sans controle** : le prereglage
   porte `access.profileRef`. Le controle existant (profil inconnu ou
   ineligible = 400) doit s'appliquer a l'override de preset, et le swap
   doit journaliser l'ancien et le nouveau profil.
2. **Un prereglage qui change de posture** : passer en `bypass` par un
   preset est une montee de privilege. Recommandation : interdire `bypass`
   dans un prereglage portable, ou exiger une option explicite
   `--allow-privilege`.
3. **`extends` non merge** : si le merge arrive (P1), un manifeste enfant peut
   heriter de `tools`, donc elargir ou restreindre les outils du gateway.
   Regle proposee : l'enfant herite des outils mais ne peut pas en ajouter
   au-dela de l'union, et le merge est trace.
4. **`metadata` comme espace de prereglage** : `metadata` est libre, donc
   n'importe quel manifeste peut declarer un prereglage. C'est voulu (le
   manifeste est la source), mais un manifeste non signe pourrait faire
   basculer un agent vers un wallet different. Recommandation : un prereglage
   qui porte un `access.profileRef` exige une option operateur au swap
   (`--yes` ou confirmation), meme pour l operateur du daemon.
5. **Double source de verite** : `UserPreset` (fichier local) et bloc de
   manifeste. Recommandation : le manifeste gagne sur les axes qu il porte,
   l 'utilisateur voit le diff avant application (`--dry-run`).
6. **Le prototype fusionne, le runtime non** : tant que P1 n'est pas landed,
   le merge n'existe que dans le generateur. Les manifestes produits par le
   prototype sont donc complet (tous les champs ecrits), pas des enfants
   partiels : c'est ce qui les rend utilisables tels quels.

## 11. Sources consultees

- `packages/agent/src/define-agent.ts`, `schema.ts`, `types.ts`,
  `manifest/index.ts`, `load-agent.ts`, `validate-extends-chain.ts` ;
- `packages/runtime/src/agent-projection.ts`, `spawn-agent-manifest.ts`,
  `session-config.ts`, `user-presets.ts`, `turn-retry-policy.ts`,
  `session-restart-core.ts`, `session-continue-fresh.ts`, `sessions.ts`,
  `session-follow-store.ts`, `session-follow.ts`, `cron-scheduler.ts`,
  `agent-start-schema.ts`, `http-server.ts` (routes `/sessions/:id/restart`,
  `/follows`, `/cron`), `session-tools.ts` (verbes `session_restart`,
  `session_set_keepalive`), `session-follow-tools.ts` ;
- `packages/app-kit/src/emit.ts` (`renderAgentManifest`), `packages/cli/src/
  commands/agent.ts` (`agentproto agent create`), `packages/cli/src/commands/
  preset.ts` (`agentproto preset`, CRUD de `UserPreset`) ;
- `night-deliverables/agent-identity/PLAN.md` (TACHE 15) ;
- `origin/night/t15-agent-identity-plan`, commit `bca28a88`.
