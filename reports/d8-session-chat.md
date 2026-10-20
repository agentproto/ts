# D8  -  Installation « utilisateur froid » de `@agentik/session-chat`

Date : 2026-10-20 (UTC)
Hôte : sandbox Linux, utilisateur `user` (uid 1000, membre de `sudo`)
Répertoire de travail : `/home/user/agentproto`
Rapporteur : agent exécuteur, aucun autre agent spawné, aucune modification du
dépôt en dehors de ce rapport.

## Environnement initial

| Élément | Valeur |
|---|---|
| `agentproto --version` | `agentproto 1.29.0 (b2d8908b, built 2026-10-19T22:57:22.123Z)` |
| Binaire | `/usr/bin/agentproto` (installation globale npm : `/usr/lib/node_modules/@agentproto/cli`) |
| Node.js | `v24.22.0` |
| OS | `linux/x64` |
| Daemon | `/health` OK sur `http://127.0.0.1:18790`, up ~4 min 39 s |
| Workspace enregistré | aucun (`doctor` : « no workspace registered ») |
| Adaptateurs « enabled » | aucun (`agentproto adapters list` → « no adapters enabled ») |
| `~/.agentproto/apps/` | inexistant au départ |
| `~/.agentproto/apps.json` | inexistant au départ |

## Chronologie des commandes

### 1. Lecture de la documentation

Fichiers lus :

- `README.md`  -  le Quick start montre `agentproto install claude-code`
  (sémantique **adaptateur**) ;
- `docs/cli/guides/build-your-own-agent-app.md`  -  décrit le cycle
  `app_install` / `app_apply` / `app_run`, pas la commande d'installation
  grand public ;
- `docs/cli/guides/install-apps.md`  -  donne la bonne commande :
  `agentproto app install @agentik/session-chat`, avec la phrase « Installs
  from the catalog, a URL or a file go through the running daemon, so start it
  first (`agentproto serve`) » ;
- `agentproto --help` et `agentproto app --help`.

Remarque de lecture : rien dans `install-apps.md` n'annonce qu'une app peut
exiger un adaptateur précis (ici `mastra-agent`) avant de s'installer.

### 2. Commande littérale de la mission (échec)

```text
$ agentproto install session-chat
agentproto: Error: agentproto: could not load adapter 'session-chat'. Tried '@agentproto/adapter-session-chat'. Install it with: npm i -g @agentproto/adapter-session-chat
  cause: Cannot find package '@agentproto/adapter-session-chat' imported from /usr/lib/node_modules/@agentproto/cli/dist/cli.mjs
...
EXIT=1
```

Le dispatcher `install` ne connaît que les adaptateurs. Le message conseille
d'installer un paquet npm **qui n'existe pas** (`@agentproto/adapter-session-chat`)
au lieu d'orienter vers `agentproto app install`.

### 3. Vérifications d'environnement

```text
$ agentproto --version
agentproto 1.29.0 (b2d8908b, built 2026-10-19T22:57:22.123Z)          EXIT=0

$ agentproto daemon status
agentproto daemon status
  mode:      pidfile fallback (no usable systemd user session)
  pidfile:   absent (/home/user/.agentproto/agentproto-daemon.pid)
  process:   not running
  /health:   ok · v1.29.0 (published, b2d8908b, ...) · workspace=/home/user · up 4m39s  (http://127.0.0.1:18790)
  release:   up to date
                                                                       EXIT=1
```

Le daemon répond réellement sur `/health`, mais `status` affiche « not
running » et sort en code 1, car le mode pidfile ne considère vivant que le
PID du fichier.

```text
$ agentproto doctor
Preflight      ✓ Node, OS, CLI version, state dir, node-pty
Workspace      ✗ Registered workspaces  no workspace registered
Daemon         ✓ Daemon /health …   ! Detached serve (pidfile) …
Agent harnesses ✓ Claude Code · ✓ OpenCode · - hermes, openclaw
Auth           ! Auth profiles  none configured
Coding clients ! Claude Code / OpenCode : MCP server not registered
Rendezvous     ! not reachable (direct)  -  HTTP 400
Skills         ! claude-code plugin not installed
Apps           - Ops Panel not bundled in this CLI build
9 ok · 9 warn · 1 missing · 0 broken                                EXIT=1
```

Aucune étape « rouge cassée » ; le seul `✗` est l'absence de workspace
enregistré. Le code retour 1 vient de ce `missing`.

```text
$ agentproto app catalog
@agentik/session-chat  v0.1.4  bundle  not installed  default
@agentproto/sessions-panel  installed  local
... (8 panneaux builtin marqués « installed »)                      EXIT=0

$ agentproto app list
No apps installed. Browse: agentproto app store  (or: agentproto app catalog)  EXIT=0
```

Contradiction immédiate : le catalogue dit 9 apps « installed », `app list`
dit qu'aucune app n'est installée.

### 4. Installation de l'app (premier essai : échec)

```text
$ agentproto app install @agentik/session-chat
agentproto app install: app_install: agent adapter "mastra-agent" could not be resolved  -  run `agentproto install mastra-agent` first.
real 0m2.061s                                                        EXIT=1
```

L'app embarque un agent (`@agentik/chat-scribe`) et l'installateur valide sa
présence en exigeant l'adaptateur par défaut `mastra-agent`, absent de cette
machine.

### 5. Installation de l'adaptateur requis (deuxième friction)

```text
$ agentproto install mastra-agent
agentproto install: [bootstrap] running: npm i -g @agentproto/adapter-mastra-agent
npm error code EACCES
npm error syscall mkdir
npm error path /usr/lib/node_modules/@agentproto/adapter-mastra-agent
...
agentproto install: npm i -g @agentproto/adapter-mastra-agent failed (exit 243).
Install it manually: npm i -g @agentproto/adapter-mastra-agent
real 0m16.618s                                                       EXIT=243
```

L'installation globale npm est refusée (le préfixe npm est `/usr`, non
inscriptible par `user`). Aucun indice sur `sudo` ni sur un préfixe
utilisateur.

Contournement manuel (l'utilisateur a `sudo` sans mot de passe) :

```text
$ sudo npm i -g @agentproto/adapter-mastra-agent
added 416 packages in 17s
real 0m17.611s                                                       EXIT=0
```

### 6. Installation de l'app (succès)

```text
$ agentproto app install @agentik/session-chat
{"appId":"@agentik/session-chat","dir":"/home/user/.agentproto/apps/agentik-session-chat",
 "dataDir":"/home/user/.agentproto/app-data/%40agentik%2Fsession-chat",
 "version":"0.1.4","name":"Session Chat",
 "agents":[{"id":"@agentik/chat-scribe", ...}],
 "workflows":[{"id":"review-session", ...}],
 "unvalidatedAgentTools":["conversation_read","session_list"],
 "ui":{"path":".../.agentproto/ui/index.html","title":"Session Chat  -  MCP native","tools":[...]},
 "source":{"kind":"agentapp","url":"https://github.com/agentproto/apps/releases/download/session-chat%400.1.4/session-chat-0.1.4.agentapp","sha256":"07d8d321...","version":"0.1.4",...},
 "installedAt":"2026-10-20T00:20:07.051Z", ...}
real 0m2.990s                                                        EXIT=0
```

Durée approximative : **~3,0 s** (téléchargement du bundle de 518 086 octets
inclus). Sortie JSON brute, même sans `--json`. Le champ
`unvalidatedAgentTools` n'est expliqué nulle part.

### 7. Vérification

```text
$ agentproto app list
@agentik/session-chat -> /home/user/.agentproto/apps/agentik-session-chat
  data dir: /home/user/.agentproto/app-data/%40agentik%2Fsession-chat
                                                                     EXIT=0

$ cat ~/.agentproto/apps.json
{ "apps": [ { "appId": "@agentik/session-chat", "dir": "...", "dataDir": "...",
  "version": "0.1.4", "agents": [...], "workflows": [...],
  "unvalidatedAgentTools": ["conversation_read","session_list"], "ui": {...},
  "source": {...}, "stateDir": "...", "installedAt": "...", "updatedAt": "..." } ],
  "runs": [], "applied": [] }
```

Le dossier `~/.agentproto/apps/agentik-session-chat/` contient bien
`.agentproto/APP.md`, `.agentproto/agents/chat-scribe/`, `.agentproto/workflows/review-session/`,
`.agentproto/ui/index.html` et `.agentproto/ui/assets/`.

```text
$ agentproto app serve --app @agentik/session-chat --port 18999
{"url":"http://127.0.0.1:18999/","appDir":".../agentik-session-chat",
 "daemonMcpUrl":"http://127.0.0.1:18790/mcp"}                         EXIT=0 (serveur)

$ curl -sS -o /tmp/ui.html -w "HTTP=%{http_code} size=%{size_download} type=%{content_type}\n" http://127.0.0.1:18999/
HTTP=200 size=1767473 type=text/html; charset=utf-8                   EXIT=0
```

L'UI contient bien le bridge `window.McpApp` (`/__agentproto/tool-call`).
Test fonctionnel du bridge :

```text
$ curl -X POST http://127.0.0.1:18999/__agentproto/tool-call \
    -H 'content-type: application/json' -d '{"name":"session_list","args":{}}'
HTTP=200
{"content":[{"type":"text","text":"{\"sessions\":[{\"id\":\"sess_986f3f51\",...}]}"}]}
```

L'UI servie par le daemon répond aussi :

```text
GET http://127.0.0.1:18790/apps/@agentik/session-chat/ui   -> HTTP=200 size=1780498
GET http://127.0.0.1:18790/apps/%40agentik%2Fsession-chat/ui -> HTTP=200 size=1780498
GET http://127.0.0.1:18790/store                           -> HTTP=302
GET http://127.0.0.1:18790/health                          -> HTTP=200
```

Après installation, `app catalog --json` donne
`{"installed":true,"hasUi":true,...}` pour `@agentik/session-chat`.

## Résultat

**OK**  -  l'application `@agentik/session-chat` v0.1.4 est installée, listée,
servie en HTTP 200, et le bridge MCP de son UI répond à un appel
`session_list`. L'installation a toutefois requis **deux contournements non
documentés** (découvrir `app install`, puis installer un adaptateur avec
`sudo`). Aucun login/token humain n'a été nécessaire.

État final laissé en place (pas de désinstallation, pas de commit) :
`~/.agentproto/apps/agentik-session-chat`, `~/.agentproto/apps.json`,
`~/.agentproto/app-data/%40agentik%2Fsession-chat`.

## Frictions classées

### Bloquant

**B1. L'app exige l'adaptateur `mastra-agent`, non déclaré, et son
installation échoue en EACCES.**
`agentproto app install @agentik/session-chat` échoue tant que
`mastra-agent` n'est pas résolu. La doc (`docs/cli/guides/install-apps.md`)
et l'entrée de catalogue ne mentionnent aucune dépendance d'adaptateur. Le
remède proposé (`agentproto install mastra-agent`) échoue lui-même en
`EACCES` sur `/usr/lib/node_modules`, sans suggérer `sudo` ni un préfixe npm
utilisateur ; il faut deviner `sudo npm i -g @agentproto/adapter-mastra-agent`.
Fichiers probables :
- `packages/runtime/src/app-tools.ts:138` (`DEFAULT_AGENT_ADAPTER = "mastra-agent"`)
- `packages/runtime/src/app-tools.ts:1459-1464` (précondition d'install)
- `packages/cli/src/registry/adapter-bootstrap.ts:151` (message « Install it manually »)
- `docs/cli/guides/install-apps.md:28-36` (pas de mention de l'adaptateur)
- `packages/runtime/src/app-catalog.ts` / entrée catalogue (pas de champ `requires` exploité ici)

### Majeur

**M1. `agentproto install <appId>` est ambigu et le message d'erreur est
trompeur.**
La commande littérale `agentproto install session-chat` part dans le
dispatcher des adaptateurs et propose d'installer un paquet inexistant
(`@agentproto/adapter-session-chat`) au lieu de dire « pour une app :
`agentproto app install` ». Le `--help` racine décrit `install <slug>` comme
« adapter-slug | runtime-profile/<name> » sans renvoi vers `app install`.
Fichiers probables :
- `packages/cli/src/cli.ts:83-88` (usage de `install`)
- `packages/cli/src/cli.ts:375-385` (dispatch `case "install"`)
- `packages/cli/src/registry/resolve.ts:854-857` (message « could not load adapter »)

**M2. `agentproto daemon status` contredit `/health` et sort en 1.**
Daemon joignable sur `http://127.0.0.1:18790/health`, mais `process: not
running` et exit 1 parce que le mode pidfile ne teste que le fichier PID. Un
utilisateur froid peut croire qu'il doit (re)lancer un daemon déjà actif.
Fichier probable :
- `packages/cli/src/commands/daemon.ts:2178-2190` (`ok = alive` en mode
  pidfile, sans tenir compte du probe `/health` réussi)

**M3. Le catalogue dit « installed » pour des apps que `app list` ignore.**
`agentproto app catalog` marque les 9 panneaux builtin `installed  local`
alors que `agentproto app list` répond « No apps installed ». Le mot
« installed » recouvre deux notions (panneau builtin toujours présent vs app
enregistrée dans `~/.agentproto/apps.json`).
Fichiers probables :
- `packages/runtime/src/builtin-apps.ts:203` et `:336` (`installed: true` en dur)
- `packages/cli/src/commands/app.ts:387-389` (`app list` ne lit que le registre)
- `packages/runtime/src/app-tools.ts:3247` (`installed: true` pour les builtins)

### Mineur

**m1. `agentproto app --help` écrit sur stderr, annonce « unknown
sub-command » et sort en 2.**
`agentproto app --help` produit `agentproto app: unknown sub-command.` puis
l'usage complet sur **stderr**, avec exit 2 ; `--help` n'est pas traité comme
une aide normale (stdout, exit 0).
Fichier probable : `packages/cli/src/commands/app.ts:237-241`.

**m2. Le `--help` racine sous-documente `app install`.**
Il affiche `agentproto app install <appDir>` (ligne 218) alors que
`agentproto app --help` accepte `<appDir|url|file.agentapp|appId>`. L'usage
racine omet aussi `app catalog`, `app update`, `app uninstall`, `app init`,
`app validate`.
Fichier probable : `packages/cli/src/cli.ts:216-220`.

**m3. `hasUi` est faux pour une app non installée qui a une UI.**
Avant installation, le catalogue renvoie `"hasUi": false` pour
`@agentik/session-chat` alors que son bundle contient
`.agentproto/ui/index.html` ; le champ signifie en fait « l'instance
installée a une UI ». Après installation il passe à `true`.
Fichier probable : `packages/runtime/src/app-tools.ts:3188` et `:3233`

**m4. `unvalidatedAgentTools` apparaît dans la sortie d'install sans
explication.**
La valeur `["conversation_read","session_list"]` est livrée brute dans le
JSON d'installation et dans `~/.agentproto/apps.json`, sans avertissement ni
doc sur ce qu'il faut en faire.
Fichier probable : `packages/runtime/src/app-tools.ts:1466-1469`.

**m5. `agentproto adapters list` dit « no adapters enabled » alors que des
adaptateurs sont installés.**
`agentproto doctor` voit Claude Code et OpenCode, et
`/usr/lib/node_modules/@agentproto/adapter-*` existe, mais `adapters list`
répond « no adapters enabled ». La notion d'« enabled » n'est pas expliquée.
Fichier probable : commande `adapters list` (sortie observée ; pas de
localisation certaine).

### Cosmétique

**c1. `app install` émet du JSON brut par défaut.**
Sans `--json`, la sortie est un objet JSON d'une ligne (lisible mais peu
« CLI humaine »).
Fichier probable : `packages/cli/src/commands/app.ts` (`runAppInstall`).

**c2. Le README annonce le statut « 1.10.0 » alors que le CLI installé est
1.29.0.**
Fichier probable : `README.md:39`.

**c3. `doctor` sort en 1 à cause de 9 avertissements / 1 manque.**
Comportement probablement voulu, mais un nouvel utilisateur peut lire le code
1 comme « installation cassée » alors que le daemon et les harnais sont OK.
Fichier probable : `packages/cli/src/commands/doctor.ts` (calcul du code
retour, non localisé précisément).

## Ce qu'un humain aurait dû faire

1. Lire `docs/cli/guides/install-apps.md` et utiliser directement
   `agentproto app install @agentik/session-chat`  -  donc savoir déjà que
   `agentproto install` est réservé aux adaptateurs.
2. Vérifier que le daemon tourne avec `curl http://127.0.0.1:18790/health`
   plutôt que de se fier au `process: not running` de `daemon status`.
3. Installer l'adaptateur manquant avec les droits root :
   `sudo npm i -g @agentproto/adapter-mastra-agent` (ou configurer un préfixe
   npm inscriptible), puisque `agentproto install mastra-agent` échoue en
   `EACCES` et que la doc ne le signale pas.
4. Relancer `agentproto app install @agentik/session-chat`, puis vérifier avec
   `agentproto app list` et `curl http://127.0.0.1:18790/apps/@agentik/session-chat/ui`.
5. Pour servir l'UI hors daemon : `agentproto app serve --app @agentik/session-chat`
   et ouvrir l'URL affichée.

En d'autres termes : un humain déjà familier d'agentproto et disposant de
`sudo` y arrive en ~5 minutes ; un utilisateur strictement froid se heurte
d'abord à la confusion `install` vs `app install`, puis à une dépendance
d'adaptateur invisible et à un `EACCES` npm.
