---
name: adapter-setup-kit
description: >-
  Découvrir, configurer et exposer les briques d'infrastructure d'agentproto via
  le `@agentproto/adapter-kit` : cataloguer les adapters (agents CLI, tunnels,
  navigateurs) avec leur statut supported/available/ready, configurer un
  provider qui demande des credentials (multi-champs, stockés en
  clair-jamais-réaffiché), et ouvrir un tunnel HTTPS public (Cloudflare quick
  éphémère ou named stable) pour exposer le gateway ou un service local à un
  agent distant. Déclenche ce skill quand l'utilisateur veut « voir quels
  adapters/agents sont installés », « configurer cloudflare-named / un provider
  de tunnel », « exposer mon port local / le daemon en HTTPS », « une URL
  publique stable pour un agent distant », ou parler de `adapter_list` /
  `setup_tunnel_provider` / `tunnel_create`. Complète les skills d'orchestration
  (qui SUPPOSENT l'adapter prêt) en couvrant l'amont : inventaire + setup +
  exposition réseau.
---

# Adapter setup kit (catalogue, setup, tunnels)

L'amont de l'orchestration : avant de `agent_start`, il faut un adapter
**ready** ; pour piloter un agent distant ou exposer un service, il faut un
**tunnel**. Ce skill couvre l'inventaire (`list_*`), la config des providers
sensibles (`setup_*`), et l'exposition réseau (`tunnel_create`). Les autres
skills d'orchestration supposent tout ça déjà en place.

## Les trois familles d'adapters

Un même socle (`@agentproto/adapter-kit`) catalogue trois familles, chacune avec
son `list_*` :

- **Agents CLI** — `adapter_list` (claude-code, hermes, opencode, codex,
  openclaw…). Ce que tu spawnes.
- **Tunnels** — `list_tunnel_adapters` (cloudflare-quick, cloudflare-named).
  Comment tu exposes.
- **Navigateurs** — `browser_adapter_list` (agents qui pilotent un navigateur).

Tous renvoient un **statut** uniforme à 3 états :

- **`supported`** = connu mais **pas installé** (ex. opencode, codex →
  `version: "not installed"`). Il faut installer le package
  (`@agentproto/adapter-<slug>`).
- **`available`** = installé mais **setup non fait** (ex. cloudflare-named :
  `requiresAuth` → besoin de credentials).
- **`ready`** = installé **et** configuré, utilisable tout de suite (ex.
  claude-code, hermes, cloudflare-quick).

**Règle d'or : appelle le `list_*` AVANT de spawner/ouvrir.** Ne devine pas ce
qui est installé — un `agent_start` sur un adapter `supported` (pas installé)
échoue.

## Pattern 1 — Cataloguer (le check d'amont)

`adapter_list` renvoie pour chaque agent : `slug`, `name`, `version`, `protocol`
(acp/…), `streaming`, `packageName`, `models` (la liste des modèles connus de
l'adapter), `status`, `hint`. Exemple vécu : `claude-code` et `hermes` sont
`ready` ; `opencode` / `codex` / `openclaw` sont `supported`
(`version: "not installed"`). Utilise `models` pour proposer un choix de modèle
au spawn, et `status` pour ne proposer que le `ready`.

`list_tunnel_adapters` renvoie en plus un bloc **`capabilities`** par provider :
`stableUrl`, `autostart`, `customDomain`, `requiresAuth`, `hasApi` — c'est ce
qui décide quel provider répond au besoin (URL stable ? relance au boot ?).

## Pattern 2 — Configurer un provider sensible (`setup_*`)

Un provider `available` qui demande des creds se configure **sans jamais exposer
le secret** :

```
setup_tunnel_provider({ slug: "cloudflare-named",
  value: "{\"hostname\":\"app.example.com\",\"tunnelId\":\"<id>\",\"credentialsFile\":\"<path?>\"}" })
```

- `value` est une **chaîne JSON** (multi-champs) — le kit gère les credentials
  multi-champs via une seule string sérialisée.
- **Sensible par construction** : stocké en `0600`, **jamais ré-affiché** dans
  un résultat de tool ni loggé. Ne t'attends pas à le relire — si tu dois
  vérifier, regarde le passage `available → ready` via `list_tunnel_adapters`,
  pas la valeur.
- Après setup réussi, le provider passe `available → ready`.

(Le même pattern `setup_*` multi-champs/sensible s'applique aux autres familles
qui demandent des creds — c'est une primitive du kit, pas propre aux tunnels.)

## Pattern 3 — Exposer un port en HTTPS public (`tunnel_create`)

Deux backends, choisis selon que tu veux jetable ou stable :

- **`quick`** (défaut, **zéro credential**) : Cloudflare Quick Tunnel, URL
  éphémère `*.trycloudflare.com` **régénérée à chaque run**. Parfait pour un
  test ponctuel / un webhook receiver jetable.
  ```
  tunnel_create({ targetPort: 3000 })   // → https://xxxx.trycloudflare.com
  ```
- **`named`** (BYO, **stable**) : un tunnel cloudflared que tu as provisionné
  une fois (`cloudflared tunnel create` + `route dns`), lié à un **hostname
  stable qui survit aux restarts**. Passe `hostname` + `tunnelId`, et
  `autostart: true` pour que le daemon le relance au boot.

  ```
  tunnel_create({ targetPort: 8080, provider: "named",
    hostname: "app.example.com", tunnelId: "<id>", autostart: true })
  ```

- `targetHost` défaut `127.0.0.1` (mets `localhost` seulement si la cible est en
  IPv6). `tunnel_create` rend le `TunnelDescriptor` quand cloudflared est prêt
  (typiquement < 10 s).
- Suivi / cycle de vie : `tunnel_list` (avant d'en ouvrir un doublon),
  `tunnel_status({ tunnelId })` (id UUID **ou** le `name` slug donné au create),
  `tunnel_stop`.
- **`tunnel_create` ne gate PAS l'auth** — passthrough pur, le service proxifié
  gère sa propre authn. Si tu veux une couche d'auth devant, c'est
  `remote_enable` (≠ tunnel), pas `tunnel_create`.

Cas d'usage orchestration : exposer le **gateway agentproto** (ou un
sous-gateway) pour qu'un agent **distant** s'y connecte, ou exposer un
**récepteur de webhook** local pour éprouver l'escalade `notifyUrl` (cf.
`durable-supervision`) — un `quick` tunnel suffit pour ce dernier.

## Gotchas (vécus / issus du surface réel)

- **Statut ≠ binaire** : `supported` veut dire « je connais cet adapter » pas «
  il est là ». Vérifie `version` (`"not installed"` = à installer) avant de
  compter dessus.
- **Quick tunnel = URL volatile** : un `quick` relancé a une **nouvelle URL** →
  `autostart` n'a de sens que pour `named`. Pour quoi que ce soit de durable
  (webhook enregistré, agent distant), utilise `named`.
- **Secret one-way** : `setup_*` ne réaffiche jamais la valeur. Ne construis pas
  de flux qui suppose pouvoir la relire ; raisonne sur le statut `ready`.
- **`tunnel_status` accepte le name** : pas besoin de retenir l'UUID si tu as
  passé un `name` au `create_tunnel`.
- **targetHost** : `127.0.0.1` par défaut ; un service bind-IPv6-only ne
  répondra qu'avec `localhost` — sinon le tunnel proxifie dans le vide.

## Checklist setup

- [ ] `list_<famille>` d'abord → repérer `ready` vs `available` vs `supported`
- [ ] Installer le package si `supported` (`@agentproto/adapter-<slug>`)
- [ ] `setup_*` si `available` + `requiresAuth` (value = JSON multi-champs,
      sensible)
- [ ] Confirmer le passage à `ready` via un `list_*` (pas en relisant le secret)
- [ ] Tunnel : `quick` pour jetable, `named` (+`autostart`) pour stable
- [ ] `tunnel_list` avant d'ouvrir un doublon ; `tunnel_stop` en fin de vie
