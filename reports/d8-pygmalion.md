# d8  -  Pygmalion : test « utilisateur froid » (installation d'app AIP-53)

Rapport de test. Aucun fichier du dépôt modifié hormis ce rapport. Aucun commit.
Aucune app fabriquée, aucun faux `APP.md`, aucune URL de bundle inventée.

## 1. Environnement

- CWD / racine du contrat AGENTS.md : `/home/user/agentproto` (dépôt git).
- `agentproto` : `/usr/bin/agentproto`, version **1.29.0** (`b2d8908b`, build 2026-10-19T22:57:22Z).
- Node `v24.22.0`, pnpm `10.4.1`.
- Daemon : **non lancé explicitement** ; `agentproto app catalog` a répondu (EXIT 0), donc un daemon est joignable ou la commande a un repli local.
- Documenté lu avant test : `AGENTS.md`, `README`, `docs/cli/guides/build-your-own-agent-app.md`, `docs/cli/guides/install-apps.md`, `docs/cli/guides/app-store.md`.
- Spec AIP-53 : **absente en prose du dépôt local** (`specs/aip-53.mdx` n'existe pas ; `specs/resources/aip-53/draft/` ne contient que `APP.schema.json`). Récupérée depuis le dépôt canonique `agentproto/agentproto` :
  - `specs/aip-53.mdx` (§ « Setup steps (`setup[]`) »).
  - `specs/resources/aip-53/draft/EXAMPLES.md` §5  -  « Setup steps: Pygmalion as the reference app ».
- La forme attendue par la spec est bien : `agentproto app install @pygmalion/app`, puis pipeline `setup[]`, et re-run `agentproto app setup <appId> [--force] [--dry-run] [--only <id>]`.

## 2. Chronologie exacte des commandes (sorties + codes retour)

### 2.1 `agentproto install pygmalion`

```
$ agentproto install pygmalion
EXIT=1
agentproto: Error: agentproto: could not load adapter 'pygmalion'. Tried '@agentproto/adapter-pygmalion'. Install it with: npm i -g @agentproto/adapter-pygmalion
  cause: Cannot find package '@agentproto/adapter-pygmalion' imported from /usr/lib/node_modules/@agentproto/cli/dist/cli.mjs
    at resolveAdapter (.../cli.mjs:214960:11)
    at async runInstall2 (.../cli.mjs:235691:15)
```

Le verbe racine `install` cible un **adaptateur** (AIP adapter), pas une app. La commande de l'énoncé (« `agentproto install pygmalion` ») est donc une mauvaise piste pour installer une **app** : le seul verbe app est `agentproto app install`.

### 2.2 `agentproto app catalog`

```
$ agentproto app catalog
EXIT=0
@agentik/session-chat  v0.1.4  bundle  not installed  default
@agentproto/sessions-panel  installed  local
@agentproto/agents-overview  installed  local
@agentproto/bureau-sessions  installed  local
@agentproto/session-story  installed  local
@agentproto/live-session  installed  local
@agentproto/session-chat-widget  installed  local
@agentproto/work-board  installed  local
@agentproto/review-panel  installed  local
@agentproto/store  installed  local
```

Une seule entrée distante (`@agentik/session-chat`) + les panneaux builtin. **Aucune entrée Pygmalion.**

### 2.3 `agentproto app install @pygmalion/app`

```
$ agentproto app install @pygmalion/app
EXIT=1
agentproto app install: no catalog entry named '@pygmalion/app'.
Browse what's available: agentproto app catalog
```

### 2.4 `agentproto app install pygmalion` (nu)

```
$ agentproto app install pygmalion
EXIT=2
agentproto app install: /home/user/agentproto/pygmalion is not an agentproto app (missing /home/user/agentproto/pygmalion/.agentproto/APP.md).
```

Un argument non-`@scope/name` et non-chemin existant est traité comme un chemin local → échec.

### 2.5 `agentproto app setup @pygmalion/app`

```
$ agentproto app setup @pygmalion/app
EXIT=2
agentproto app: unknown sub-command 'setup'.
<usage complet du verbe app  -  aucune mention de `setup`>
```

### 2.6 `agentproto app --help`

```
$ agentproto app --help
EXIT=2
agentproto app: unknown sub-command.
<usage  -  sous-commandes listées : pack, unpack, install, resync, catalog,
 uninstall, update, store, list, tunnel, serve, build, dev, init, validate.
 PAS de sous-commande `setup`.>
```

Le `--help` renvoie un code 2 et un message d'erreur `unknown sub-command` au lieu d'un affichage d'aide propre.

### 2.7 Vérification d'existence réelle de Pygmalion

- Catalogue public : `curl https://agentproto.sh/catalog/v1/apps.json` → **HTTP 200**, 5300 octets, JSON valide. Liste des appId : `['@agentik/session-chat']` uniquement. **Aucune occurrence de « pygmalion ».**
- Dépôt `https://github.com/agentproto/apps` : `entries/` contient `entries/.gitkeep` et `entries/@agentik/` (arbre récursif `main` : **un seul** `entries/@agentik/session-chat.json`). **Aucun dossier/entrée Pygmalion.**
- `agentproto app catalog --json` (EXIT 0) : 1 entrée distante + builtins ; pas de Pygmalion.

Conclusion : **Pygmalion n'existe pas dans le catalogue** (public, ni dépôt source). C'est un exemple de spec, pas une app publiée.

### 2.8 Support `setup[]` (AIP-53) dans le code

Recherches effectuées :

- `packages/app-kit/src/types.ts` : `AppSetupStep` (union discriminée sur `kind`) et `AppDefinition.setup` définis (`types.ts:283`, `types.ts:325`, `types.ts:451-458`, `types.ts:645-652`).
- `packages/app-kit/src/emit.ts:225-227` : `setup[]` écrit verbatim dans `APP.md`, validé par `loadAppHandle`.
- `packages/app-kit/src/__tests__/setup-steps.test.ts:372-465` : fixture de référence « Pygmalion (EXAMPLES.md §5) »  -  construction, emit, round-trip load. **app-kit supporte entièrement `setup[]`.**
- `specs/resources/aip-53/draft/APP.schema.json` : propriété `setup` + `$defs.setupStep` présents (schema local OK).
- **Runtime / CLI : aucun support.**
  - `packages/cli/src/commands/app.ts` : dispatch des sous-commandes sans `setup` (`app.ts:190-215`) ; aucune chaîne `setup` liée à l'installation.
  - `packages/cli/src/cli.ts:389` : le cas `setup` racine appelle `runSetupCommand` (assistant AIP-29 d'**adaptateur**), pas une app.
  - `packages/runtime/src/app-tools.ts` : le handler `app_install` (lignes ~530, ~758) ne référence jamais `setup` ; `packages/runtime/src/app-registry.ts` importe les types app-kit mais ne touche pas à `setup`.
  - Grep global `packages/` (hors tests) sur `setupState` / `setup_required` / `app_setup` / `setup_unsupported_step` / `setup_failed` : **aucun hit runtime**. Seuls des commentaires/types dans `packages/app-kit` et une mention de commentaire dans `packages/driver/agent-cli/src/schema.ts:129`.

**Constat clé** : la partie **app-kit (schéma/emit/load) supporte `setup[]`**, mais la partie **runtime/CLI de l'AIP-53 (pipeline de setup, `setupState`, `app_run` gating `setup_required`, verbe `app setup`) est absente**. Il n'y a même pas de consommation runtime de `setup[]` à l'installation.

## 3. Résultat global

**KO bloquant.**

Deux KO indépendants et cumulés :

1. **KO-1 (bloquant)  -  l'app n'existe pas.** Aucune entrée `@pygmalion/app` dans le catalogue public, le dépôt source, ni le catalogue du daemon. Impossible d'installer une app non publiée.
2. **KO-2 (bloquant)  -  le pipeline `setup[]` n'est pas exécutable.** Même si l'app existait, ni le CLI (`agentproto app setup` → `unknown sub-command`) ni le runtime (`app_install`, pas de `setupState`) ne savent exécuter/valence `setup[]`. Seul `app-kit` le modélise.

Un testeur « utilisateur froid » ne peut pas installer Pygmalion, et un fournisseur d'app ne pourrait pas non plus faire exécuter son `setup[]` par l'hôte actuel.

## 4. Frictions classées

### Bloquant

- **F1  -  Entrée catalogue Pygmalion absente.** `@pygmalion/app` n'est publiée nulle part (ni `agentproto.sh/catalog/v1/apps.json`, ni `github.com/agentproto/apps/entries`). L'exemple AIP-53 §5 est resté à l'état de spec/fixture app-kit.
- **F2  -  Verbe `agentproto app setup` absent.** `unknown sub-command 'setup'` (app.ts:190-215). Référencé pourtant explicitement par l'AIP-53 §Lifecycle point 4.
- **F3  -  Aucun support runtime de `setup[]`.** Pas de `setupState`, pas de `app_setup`, pas de refus `app_run` avec `setup_required`. `app_install` (app-tools.ts) ignore `setup`. L'hôte n'est pas conforme à l'AIP-53 côté exécution.

### Majeur

- **F4  -  Ambiguïté `install` vs `app install`.** `agentproto install pygmalion` échoue en cherchant l'adaptateur `@agentproto/adapter-pygmalion` (EXIT 1). Un nouvel utilisateur qui suit l'énoncé « installe l'app » peut tomber sur ce message qui parle d'adaptateur npm et croire que l'app est un paquet npm. Le message ne suggère pas `agentproto app install`.
- **F5  -  `agentproto app --help` renvoie EXIT 2 avec « unknown sub-command. »** au lieu d'afficher l'aide. `--help`/`-h` sur un verbe devrait être un affichage d'aide à code 0.
- **F6  -  `agentproto app install <mot-nu>` traité comme chemin local.** `pygmalion` → erreur « missing /.../pygmalion/.agentproto/APP.md » (EXIT 2) au lieu de « id inconnu, essayez `agentproto app catalog` ». Message trompeur pour un id sans scope.
- **F7  -  Message « no catalog entry named '@pygmalion/app' » correct mais sec.** Renvoie vers `catalog` (EXIT 1) ; ne dit pas que l'app n'est pas publiée ni quelles étapes de publication existent. Acceptable mais frictional.

### Mineur

- **F8  -  Spec AIP-53 prose absente du dépôt local.** `specs/aip-53.mdx` et `specs/resources/aip-53/draft/EXAMPLES.md` n'existent pas localement ; seul `APP.schema.json` est présent. Le test `packages/app-kit/src/__tests__/setup-steps.test.ts:375` cite pourtant « specs/resources/aip-53/draft/EXAMPLES.md §5 » comme source « verbatim ». Un lecteur local ne peut pas vérifier la fixture.
- **F9  -  `setup[]` présent dans le JSON Schema local (`APP.schema.json`) mais non consommé runtime** : incohérence schéma↔exécution, source de confusion.

### Cosmétique

- **F10  -  Usage de `agentproto app` : la sous-commande `setup` n'apparaît nulle part**, donc un utilisateur qui a lu l'AIP-53 ne peut pas découvrir l'écart entre spec et implémentation sans grep le code.
- Le message `agentproto app catalog` liste les builtins en premier, l'unique app distante en tête de liste sans en-tête distinct « Available/Featured » (la mention `default`/`local` sert de tier).

## 5. Correctifs proposés (fichier + ligne si localisable)

- **C1 (F1)**  -  Publier Pygmalion : construire le bundle (`agentproto app pack --release --entry`) puis pousser le `.agentapp` en release GitHub `pygmalion@0.4.0` et l'entrée `entries/@pygmalion/app.json` dans `agentproto/apps` ; rebâtir `catalog/v1/apps.json`. Sans cela, rien d'autre ne peut être testé.
- **C2 (F2)**  -  Ajouter la sous-commande `setup` au dispatch de `packages/cli/src/commands/app.ts` (bloc `if (subVerb === "...")` vers `app.ts:190-215`) et implémenter `runAppSetup` selon `agentproto app setup <appId> [--force] [--dry-run] [--only <id>]...` (déléguer à un nouveau tool daemon `app_setup`, cf. C3). Mettre à jour la constante `USAGE` (`app.ts:51`) et l'aide racine `cli.ts:83-94`.
- **C3 (F3)**  -  Côté runtime : ajouter à `packages/runtime/src/app-tools.ts` (handler `app_install`, ~`app-tools.ts:530`/`:758`) l'exécution du pipeline `setup[]` après l'enregistrement de l'install, l'état `setupState: "required"|"ready"` et le refus `app_run` avec `error.code = "setup_required"`. Ajouter un registre/ledger (per `(app.id, workspace.id, user.id)`) et l'exposition `answers` read-only. S'inspirer de l'implémentation AIP-29 existante (`agentproto setup`, `cli.ts:389` → `commands/setup.ts`).
- **C4 (F4)**  -  Dans `runInstall` (top-level adapter install), quand l'argument ne correspond à aucun adaptateur connu et ressemble à une app (`@scope/name` ou id de catalogue), afficher un hint : « `pygmalion` is not an adapter; for an app try `agentproto app install @pygmalion/app` ». Localisable dans le message d'erreur de `resolveAdapter` (probablement `packages/cli/src/commands/install.ts`).
- **C5 (F5)**  -  Gérer `--help`/`-h` (et l'absence de sous-commande) dans `packages/cli/src/commands/app.ts` en affichant `USAGE` sur stdout et en retournant 0, au lieu du `unknown sub-command` (code 2) actuel.
- **C6 (F6)**  -  Dans `runAppInstall` (`packages/cli/src/commands/app.ts:244+`), si l'argument ne commence ni par `@`, ni par `.`/`/`/`~`, ni par un schéma d'URL, émettre le message « no catalog entry named '<x>'  -  did you mean an `@scope/name` id? run `agentproto app catalog` » plutôt que le message de chemin manquant.
- **C7 (F8)**  -  Commiter `specs/resources/aip-53/draft/EXAMPLES.md` (et éventuellement `specs/aip-53.mdx` en prose) dans ce dépôt, pour que la fixture citée par `setup-steps.test.ts:375` soit vérifiable localement.

## 6. Ce qu'un humain aurait dû faire

Pour que Pygmalion soit installable et testable de bout en bout, il fallait :

1. **Publier l'app** : créer le dossier app réel (`@pygmalion/app`, version 0.4.0) conforme à l'exemple EXAMPLES.md §5, le builder en `.agentapp` (`agentproto app pack --release --entry`), pousser le bundle en GitHub Release et son entrée JSON dans `github.com/agentproto/apps/entries`, puis régénérer `https://agentproto.sh/catalog/v1/apps.json`.
2. **Fournir/activer le bundle** : sans release ni entrée catalogue, aucune commande d'installation ne peut aboutir.
3. **Activer `setup[]` côté hôte** : implémenter le pipeline runtime + le verbe `agentproto app setup` (C2/C3)  -  sinon même une app publiée avec `setup[]` installerait mais resterait non-`ready`, et l'hôte prétendrait installer une app qu'il ne sait pas configurer.
4. **Documenter le chemin réel** : le README / `docs/cli/guides/install-apps.md` devraient préciser que `agentproto install <slug>` = adaptateur, et `agentproto app install <appId>` = app, et pointer `setup` une fois implémenté.
5. Sinon, **ne pas présenter Pygmalion comme « la première app du catalogue »** : dans l'état actuel, c'est un exemple de spec (fixture app-kit), pas une app installable. Le catalogue public n'en contient qu'une : `@agentik/session-chat`.
