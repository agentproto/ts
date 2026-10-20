# D8 - Installation à froid de deux apps AgentProto (2026-10-20)

Test demandé par Jeremy (décision D8) : un nouvel utilisateur peut-il installer
les apps `@agentik/session-chat` et `@pygmalion/app` sans aide ?

Exécution : superviseur dans une sandbox E2B, deux exécuteurs `opencode` lancés
dans la même box avec le modèle gratuit `opencode/deepseek-v4.1-flash-free`.
Aucun modèle payant, aucun sous-agent supplémentaire.

Rapports bruts :

- `reports/d8-session-chat.md`
- `reports/d8-pygmalion.md`

## 1. Verdict

| App | Verdict | Résumé |
|---|---|---|
| `@agentik/session-chat` | **OK avec contournements** | Installée en v0.1.4, listée, UI servie en HTTP 200, bridge MCP fonctionnel. Deux blocages non documentés ont dû être levés : trouver `agentproto app install`, puis installer `mastra-agent` avec `sudo`. |
| `@pygmalion/app` | **KO bloquant** | L'app n'existe pas dans le catalogue public ni dans `agentproto/apps`. Elle n'existe que comme exemple de spec AIP-53. De plus, le runtime et le CLI ne savent pas exécuter `setup[]`. |

Le titre « première app du catalogue avec `setup[]` » n'est pas vérifiable :
le catalogue public ne contient qu'une app distante, `@agentik/session-chat`,
et celle-ci ne déclare pas de `setup[]`.

## 2. Limites du test à froid

Le test est utile mais n'est pas un vrai démarrage sur machine vierge :

- le CLI `agentproto` 1.29.0 était déjà installé globalement ;
- un daemon tournait déjà sur `127.0.0.1:18790` ;
- les exécuteurs travaillaient dans le checkout du dépôt, ce qui permet à
  `resolveAdapter` de voir les adaptateurs du monorepo ;
- l'utilisateur `user` dispose de `sudo` sans mot de passe ;
- le préfixe npm global est `/usr`, non inscriptible par `user`.

Conséquence importante : `agentproto install mastra-agent` a répondu « already
installed (version 24.22.0) » parce que le `version_check` de cet adaptateur
exécute `node --version`. Le paquet n'était pourtant pas résolvable par le
daemon. Sur une vraie machine vierge, le chemin serait probablement le
bootstrap npm global, avec le même `EACCES`.

## 3. `@agentik/session-chat`

### 3.1 Chronologie

| Étape | Commande | Résultat |
|---|---|---|
| Documentation | `README.md`, `docs/cli/guides/install-apps.md`, `agentproto app --help` | La bonne commande est `agentproto app install <appId>`. |
| Commande littérale de la mission | `agentproto install session-chat` | **EXIT 1**. Traité comme un adaptateur. Message trompeur : installer `@agentproto/adapter-session-chat`, paquet inexistant. |
| État de l'hôte | `agentproto daemon status` | **EXIT 1**, affiche `process: not running` alors que `/health` répond OK. |
| Diagnostic | `agentproto doctor` | 9 ok, 9 warn, 1 missing (aucun workspace). EXIT 1. |
| Catalogue | `agentproto app catalog` | Une app distante, 9 panneaux builtin marqués `installed`. |
| Liste locale | `agentproto app list` | `No apps installed.` Contradiction avec le catalogue. |
| Premier install | `agentproto app install @agentik/session-chat` | **EXIT 1**. `agent adapter "mastra-agent" could not be resolved`. |
| Install adaptateur | `agentproto install mastra-agent` | **EXIT 243**. `npm i -g` en `EACCES` sur `/usr/lib/node_modules`. |
| Contournement | `sudo npm i -g @agentproto/adapter-mastra-agent` | **EXIT 0**, 416 paquets en 17 s. |
| Install finale | `agentproto app install @agentik/session-chat` | **EXIT 0** en environ 3 s, v0.1.4. Bundle de 518 086 octets. |
| Vérification | `agentproto app list` | `@agentik/session-chat -> ~/.agentproto/apps/agentik-session-chat`. |
| UI | `curl http://127.0.0.1:18790/apps/@agentik/session-chat/ui` | HTTP 200, 1 780 498 octets. |
| Bridge | `POST /__agentproto/tool-call` avec `session_list` | HTTP 200, réponse JSON valide. |

Aucun login ni jeton humain n'a été demandé pour cette app. L'état installé a
été laissé en place, sans désinstallation.

### 3.2 Frictions et correctifs

#### Bloquant

**B1. `app install` exige `mastra-agent` pour toute app contenant un agent.**

`app_install` vérifie inconditionnellement l'adaptateur par défaut dès que
`handle.agents.length > 0`, même si l'app est principalement une UI et même si
aucun de ses agents ne route vers cet adaptateur. `session-chat` embarque
`@agentik/chat-scribe` (modèle `z-ai/glm-5.3-flash`) et échoue donc à
l'installation.

- `packages/runtime/src/app-tools.ts:1458-1464` : vérification globale de
  `DEFAULT_AGENT_ADAPTER`.
- `packages/runtime/src/app-tools.ts:138` : `DEFAULT_AGENT_ADAPTER = "mastra-agent"`.

Correctif : ne vérifier que les adaptateurs réellement résolus par les agents
de l'app (`resolveAgentSpawnAdapter` par agent), ou déplacer ce contrôle à
`app_run` pour l'agent concerné, avec un avertissement non bloquant à
l'installation.

**B2. Le remède proposé échoue en `EACCES` sans indiquer `sudo`.**

`agentproto install mastra-agent` lance `npm i -g` sur un préfixe global
root-owned. Le message final ne propose ni `sudo`, ni un préfixe npm
utilisateur.

- `packages/cli/src/registry/adapter-bootstrap.ts:150-151` : message
  `Install it manually: npm i -g ...`.
- `packages/cli/src/commands/install.ts:150-212` : bootstrap puis
  réessai, sans gestion du préfixe non inscriptible.

Correctif : détecter `EACCES` et proposer soit `sudo npm i -g`, soit
`npm config set prefix ~/.npm-global` puis re-run. Documenter le prérequis
dans `docs/cli/guides/install-apps.md` (section `## Install one`, autour des
lignes 28-36).

#### Majeur

**M1. `agentproto install <app>` est une impasse trompeuse.**

Le verbe racine ne connaît que les adaptateurs et les runtime-profiles. Pour
une app, il conseille un paquet npm inexistant au lieu de renvoyer vers
`agentproto app install`.

- `packages/cli/src/cli.ts:5` et `:83-88` : usage du verbe `install`.
- `packages/cli/src/commands/install.ts` : message d'échec de résolution.
- `packages/cli/src/registry/resolve.ts` : `could not load adapter`.

Correctif : si le slug ne correspond à aucun adaptateur connu mais ressemble à
un id d'app (`@scope/name` ou entrée de catalogue), ajouter un hint explicite
vers `agentproto app install`.

**M2. `agentproto daemon status` contredit `/health` et sort en 1.**

En mode pidfile, `ok` ne dépend que du PID enregistré. Un daemon démarré par un
autre chemin (ici le superviseur) est pourtant joignable.

- `packages/cli/src/commands/daemon.ts:2179-2184` : `ok = alive` en mode
  pidfile, sans utiliser le résultat de `probe()`.

Correctif : si `/health` répond, considérer le daemon comme joignable et
sortir 0, même sans pidfile ; afficher alors `process: unknown (health ok)`.

**M3. Le catalogue marque des builtins `installed` alors que `app list` est vide.**

Deux notions d'« installé » se recouvrent : panneau builtin toujours présent,
et app enregistrée dans `~/.agentproto/apps.json`.

- `packages/runtime/src/builtin-apps.ts:203` et `:336` : `installed: true` en
  dur pour les builtins.
- `packages/runtime/src/app-tools.ts:3246` : même chose dans `app_catalog`.
- `packages/cli/src/commands/app.ts:389` : `app list` ne lit que le registre
  persistant.

Correctif : renommer la notion pour les builtins (`builtin: true`,
`available: true`) ou aligner `app list` sur le catalogue, et réserver
`installed` aux apps du registre.

**M4. `agentproto install mastra-agent` dit « already installed » sans rendre
l'adaptateur disponible au daemon.**

`version_check` exécute `node --version` et `interpretVersionCheck` accepte
cette version comme preuve d'installation de l'adaptateur.

- `adapters/mastra-agent/src/index.ts:44-49` : `version_check` sur
  `node --version`.
- `packages/cli/src/commands/install.ts:228-233` : le résultat positif saute
  l'installation.
- `packages/cli/src/commands/install.ts:679-729` : `runVersionCheck` et
  `interpretVersionCheck` ne vérifient pas le paquet.

Correctif : `version_check` doit tester la présence et la version du paquet
adaptateur (`npm ls -g @agentproto/adapter-mastra-agent` ou lecture du
`package.json` global), pas la version de Node.

#### Mineur

**m1. `agentproto app --help` écrit sur stderr et sort en 2.**
`packages/cli/src/commands/app.ts:236-240`. Correctif : traiter `--help` et
`-h` comme une aide normale sur stdout, exit 0.

**m2. L'aide racine sous-documente `app install`.**
`packages/cli/src/cli.ts:216-220` affiche `agentproto app install <appDir>`
alors que le verbe accepte aussi `url`, `.agentapp` et `appId`. `app catalog`
et `app update` n'y figurent pas.

**m3. `hasUi` est faux avant installation.**
`packages/runtime/src/app-tools.ts:3188` et `:3233` renvoient
`installed?.ui !== undefined` : le champ décrit l'instance installée, pas le
bundle disponible. Pour `session-chat`, `hasUi: false` avant install alors que
le bundle contient une UI.

**m4. `unvalidatedAgentTools` n'est pas expliqué.**
Le champ apparaît dans la sortie JSON d'installation et dans `apps.json`
(`packages/runtime/src/app-tools.ts`, résultat d'`app_install`) sans
avertissement ni documentation.

**m5. `agentproto adapters list` dit « no adapters enabled » alors que des
adaptateurs sont installés.**
Observé alors que `doctor` voit Claude Code et OpenCode et que
`/usr/lib/node_modules/@agentproto/adapter-*` existe. La notion d'« enabled »
n'est pas définie dans l'aide.

#### Cosmétique

- `app install` imprime du JSON brut par défaut, sans `--json`
  (`packages/cli/src/commands/app.ts`, `runAppInstall`).
- Le README affiche `Status: 1.10.0` alors que le CLI installé est 1.29.0
  (`README.md:29`).
- `doctor` sort en 1 à cause de warnings alors que le daemon et les harnais
  sont fonctionnels.

## 4. `@pygmalion/app`

### 4.1 Chronologie

| Étape | Commande | Résultat |
|---|---|---|
| Commande littérale | `agentproto install pygmalion` | **EXIT 1**. Cherche `@agentproto/adapter-pygmalion`, paquet inexistant. |
| Catalogue daemon | `agentproto app catalog` | Une seule app distante : `@agentik/session-chat`. Aucune Pygmalion. |
| Catalogue public | `curl https://agentproto.sh/catalog/v1/apps.json` | HTTP 200, 5 300 octets, un seul appId : `@agentik/session-chat`. |
| Dépôt source | `github.com/agentproto/apps/entries` | Un seul fichier d'entrée : `@agentik/session-chat.json`. |
| Install app | `agentproto app install @pygmalion/app` | **EXIT 1**. `no catalog entry named '@pygmalion/app'`. |
| Id nu | `agentproto app install pygmalion` | **EXIT 2**. Traité comme chemin local, `.agentproto/APP.md` manquant. |
| Verbe setup | `agentproto app setup @pygmalion/app` | **EXIT 2**. `unknown sub-command 'setup'`. |
| Aide | `agentproto app --help` | **EXIT 2**. `unknown sub-command.` sur stderr. |
| Spec | AIP-53 locale et `EXAMPLES.md` §5 | Pygmalion est un exemple de spec, pas une app publiée. |

### 4.2 Frictions et correctifs

#### Bloquant

**P1. L'app n'est pas publiée.**

Aucune entrée `@pygmalion/app` dans le catalogue public, le dépôt
`agentproto/apps` ou le catalogue du daemon. C'est un exemple de spec AIP-53
(`specs/resources/aip-53/draft/EXAMPLES.md` §5) resté à l'état de fixture
app-kit.

Correctif : construire et publier l'app (`agentproto app pack --release
--entry`), pousser le `.agentapp` en release GitHub, ajouter
`entries/@pygmalion/app.json` dans `agentproto/apps`, régénérer
`catalog/v1/apps.json`. Sans cela, aucun test d'installation n'est possible.

**P2. Le verbe `agentproto app setup` n'existe pas.**

Le dispatch de `packages/cli/src/commands/app.ts:190-215` ne connaît pas
`setup`. L'usage (`app.ts:51`) ne le liste pas. La spec AIP-53 le décrit
pourtant comme le point d'entrée de reconfiguration.

Correctif : ajouter la sous-commande au dispatcher et un `runAppSetup`
respectant `agentproto app setup <appId> [--force] [--dry-run] [--only
<id>]...`, adossé à un outil daemon `app_setup`.

**P3. Le runtime ne consomme pas `setup[]`.**

`packages/app-kit` modélise, émet et recharge `setup[]`
(`packages/app-kit/src/types.ts:283`, `:325`, `:451-458`, `:645-652` ;
`packages/app-kit/src/emit.ts:225-227`). Mais `app_install` et `app_run`
ignorent `setup` : aucun `setupState`, aucun `app_setup`, aucun refus
`setup_required`.

Correctif : dans `packages/runtime/src/app-tools.ts` (handler `app_install`
puis `app_run`), ajouter l'état `setupState`, un ledger par app et par
workspace, le refus `setup_required` avec la liste des étapes en attente, et
un outil `app_setup`. Réutiliser l'expérience AIP-29 de
`packages/cli/src/commands/setup.ts`.

#### Majeur

**P4. Même ambiguïté `install` vs `app install` que pour session-chat.**
Voir M1. Le message parle d'un adaptateur npm, pas d'une app.

**P5. `agentproto app --help` sort en 2 et écrit sur stderr.**
Voir m1.

**P6. Un id sans scope est traité comme un chemin local.**
`agentproto app install pygmalion` renvoie `missing
/home/user/agentproto/pygmalion/.agentproto/APP.md` au lieu de « id inconnu,
essayez `agentproto app catalog` ». Correctif dans `runAppInstall`
(`packages/cli/src/commands/app.ts:244+`) : si l'argument ne commence ni par
`@`, ni par `.`, `/`, `~`, ni par un schéma d'URL, émettre un message d'id
inconnu.

**P7. Le message « no catalog entry » est correct mais sec.**
Il renvoie vers `app catalog` sans expliquer qu'une app doit être publiée ni
comment. Ajouter un lien vers le guide de distribution.

#### Mineur

**P8. La prose AIP-53 et `EXAMPLES.md` ne sont pas dans ce dépôt.**
`specs/aip-53.mdx` et `specs/resources/aip-53/draft/EXAMPLES.md` sont absents ;
seul `APP.schema.json` est présent. Le test
`packages/app-kit/src/__tests__/setup-steps.test.ts:375` cite pourtant
`EXAMPLES.md` §5 comme source de sa fixture.

Correctif : vendorer `EXAMPLES.md`, ou corriger la référence du test.

**P9. `setup[]` est dans le JSON Schema local mais pas dans l'exécution.**
Incohérence schéma/runtime qui laisse croire que la fonctionnalité est
disponible.

## 5. Ce que la box a permis ou empêché

### Réseau

- HTTPS sortant OK : GitHub Releases, `raw.githubusercontent.com`,
  `api.github.com`, `agentproto.sh`, npm registry.
- Téléchargement du bundle `session-chat` (518 Ko) en environ 3 s.
- Aucun `gh` installé. Les appels GitHub ont été faits avec `curl` et le
  `AGENTPROTO_GIT_TOKEN` présent dans l'environnement.
- Les ports locaux fonctionnent : daemon sur 18790, `app serve` sur 18999,
  `curl` local en HTTP 200.

### CPU, mémoire, disque

- 4 vCPU, 7,8 Gio de RAM, 4 Gio de swap, 4,4 Gio libres sur 16 Gio.
- Deux sessions `opencode` simultanées, le daemon et les installations npm
  ont tenu sans pression mémoire visible.
- L'installation globale de `mastra-agent` a ajouté 416 paquets en 17 s.

### Temps

- Deux exécuteurs lancés à 00:18:39 et 00:18:47, tous deux au repos vers
  00:21:43. Environ 3 minutes pour les deux tests en parallèle.
- Installation de `session-chat` : environ 3 s une fois l'adaptateur présent.
- Le temps de supervision et de consolidation est venu s'ajouter, sans
  dépassement notable.

### Outils manquants ou particuliers

- `gh` absent : pas de `gh pr`, `gh api`, `gh run`. Le token Git a compensé
  pour les lectures GitHub.
- `systemctl` présent mais aucun bus utilisateur : le daemon tombe en mode
  pidfile, ce qui a produit la friction M2.
- `sudo` sans mot de passe : a permis le contournement `sudo npm i -g`, mais
  ce n'est pas représentatif d'un poste utilisateur verrouillé.
- Préfixe npm global `/usr` root-owned : source directe du `EACCES`.
- Pas de systemd utilisateur, pas de `gh`, pas de navigateur graphique testé.

### Orchestration d'enfants depuis la box

- `agent_start` a fonctionné pour deux enfants `opencode` dans le même `cwd`,
  avec le modèle gratuit demandé.
- Les deux enfants ont écrit leurs rapports sans se marcher dessus.
- Aucun worktree isolé n'a été utilisé : c'était volontaire, les enfants ne
  devaient pas modifier le code.
- La supervision a utilisé `session_monitor` et `agent_output`. Les enfants
  n'ont pas eu besoin de `message_parent` pour aboutir.
- Limite observée : `session_monitor` plafonne à 49 s ; pour une attente plus
  longue, un `agentproto sessions wait` en processus détaché serait préférable.

### Limites des modèles gratuits

- `opencode/deepseek-v4.1-flash-free` a tenu les deux tâches : 50 appels
  d'outil pour `session-chat`, 39 pour `pygmalion`, un seul tour chacun.
- Aucun rate-limit, aucune rotation vers `mimo-v2.6-flash-free` ou
  `glm-5.3-flash-free` n'a été déclenchée.
- Qualité : les rapports sont exploitables, mais certaines références de
  fichier/ligne étaient approximatives. Les points structurants ont été
  revérifiés dans le code avant consolidation.
- Le modèle gratuit n'a pas inventé de contournement pour Pygmalion : il s'est
  arrêté au KO, ce qui était la consigne.

## 6. Recommandations par priorité

1. **P0, Pygmalion** : soit publier réellement l'app, soit retirer la
   formulation « première app du catalogue avec `setup[]` ». En l'état, c'est
   un exemple de spec, pas une app installable.
2. **P0, `setup[]`** : implémenter le runtime et le verbe `app setup`, sinon
   aucune app avec `setup[]` ne pourra être configurée par un utilisateur.
3. **P0, `app_install`** : ne plus exiger `mastra-agent` pour toute app ayant
   un agent. Vérifier les adaptateurs réellement nécessaires, ou déplacer le
   contrôle à `app_run`.
4. **P1, installation de l'adaptateur** : corriger le `version_check` de
   `mastra-agent`, qui teste Node au lieu du paquet, et guider `EACCES` vers
   `sudo` ou un préfixe utilisateur.
5. **P1, dispatcher** : ajouter un hint `app install` quand `agentproto
   install <slug>` ne correspond à aucun adaptateur.
6. **P1, `daemon status`** : faire confiance à `/health` quand le pidfile est
   absent.
7. **P2, cohérence catalogue** : clarifier `installed` pour les builtins,
   documenter `hasUi` et `unvalidatedAgentTools`, corriger `app --help`.

## 7. Conclusion

`session-chat` est installable et fonctionnelle, mais pas par un utilisateur
strictement froid : il faut connaître `app install`, puis disposer de `sudo`
pour une dépendance d'adaptateur invisible. `Pygmalion` n'est pas testable :
l'app n'est pas publiée et la moitié runtime de `setup[]` manque. Le contrat
AIP-53 est donc implémenté côté authoring (app-kit) mais pas côté hôte.
