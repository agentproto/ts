# browser

## Périmètre de lecture

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/browser`) n'existe pas dans le conteneur d'exécution: ni `/home/user/projects`, ni `/home/user/workspace/projects`, et le dépôt `agentiknet/agentik-studio` refuse le clone (403, jeton PAT sans droit d'écriture sur ce dépôt privé). Aucun fichier du projet n'a donc été lu directement.

Ce qui suit repose sur des sources publiques vérifiables et sur le code lisible dans ce dépôt (`agentproto/ts`), qui est la plateforme sur laquelle le projet se branche:

- le miroir public du projet: `github.com/agentproto/bureau` (Apache-2.0), 281 entrées dans l'arbre, 157 fichiers TypeScript, 38 fichiers de test, 19 commits;
- le registre npm pour les paquets publiés et leurs téléchargements;
- les skills de développement embarqués dans le dépôt plateforme `packages/skill-pack-bureau/src/skills/{browser,bureau,linkedin}` (SOP de dev du projet);
- le dépôt plateforme pour les adaptateurs navigateur (`adapters/browser`, `adapters/browser-camofox`, `adapters/browser-chrome`, `adapters/browser-chromium`, `packages/browser-process`, `packages/browser-profiles`, `packages/driver/browser`, `packages/plugin-local-browser`).

Aucun build, aucune installation, aucun lancement de daemon n'ont été exécutés.

## À quoi il sert

Le projet `browser` est la pile navigateur d'Agentik. Son produit livrable est **Bureau**: un serveur de capacités navigateur installable, qui pilote un vrai navigateur (Firefox furtif Camofox par défaut, Chrome ou Chromium en option) et expose ce qu'il sait faire comme outils MCP au-dessus de HTTP, sur `127.0.0.1:8830`.

L'architecture tient en un schéma: l'agent est un client MCP, il porte un jeton d'appareil apparié, Bureau parle au navigateur (Camofox en REST sur `:9377`) et supervise Chrome ou Chromium quand le plugin navigateur est enregistré.

Les cinq briques fonctionnelles documentées dans le README du miroir public:

1. **Transport MCP** sur HTTP, avec 19 à 26 outils selon la version du catalogue (famille `browser_*`: navigate, evaluate, click, fill, screenshot, export pdf/html/text, act, download), plus un routeur de scrape à paliers (HTTP, chromium, camofox, agent) et un purified HTML vers markdown.
2. **Identités et consentements**: une session est une identité navigateur sauvegardée (cookies et stockage d'un login), Bureau garde les cookies, l'agent ne voit jamais le mot de passe. L'import de cookies se fait par domaine avec demande par domaine, journal de consentement chaîné par hash, révocation possible.
3. **Prêt à l'emploi**: `bureau session lease` prête les cookies pour une durée bornée (300 s par défaut, 900 s max) à un appareil apparié, avec approbation humaine obligatoire signée en ed25519, et un registre de baux chaîné.
4. **Vues en direct**: `GET /live/<session>` diffuse des captures MJPEG en lecture seule, 3 flux maximum par appareil, 10 minutes maximum, fin au retrait du consentement. La prise de contrôle (entrée depuis le spectateur) n'existe pas en v1.
5. **Gouvernance**: appairage comme seule porte d'entrée (QR ou config locale), révocation d'appareil, et ses propres limites documentées (pas d'encryptage au repos, le catalogue d'outils n'est pas encore re-ciblé sur Chrome).

Le projet se distingue du simple scraping par la discipline de sécurité produit: secrets dans le trousseau macOS, pas de jeton en argv, aucune URL ni cookie dans les événements de télémétrie, écritures toujours validées.

Dans la plateforme, la même pile est exposée sous trois visages: Bureau comme daemon autonome sur la machine de l'utilisateur, Bureau piloté par le daemon agentproto, et Bureau comme RuntimeSpec cloud sur un poste de travail navigateur Guilde. Le socle stealth (Camofox) est un projet séparé, `jo-inc/camofox-browser`, MIT, environ 11 800 étoiles, dernier push le 2026-10-16, publié sur npm sous `@bureau-browser/browser` (1.5.2, 124 téléchargements sur 30 jours) et `@askjo/camofox-browser`.

## État réel

### Code

Le miroir public `agentproto/bureau` est un monorepo pnpm de sept paquets: `apps/bureau` (CLI et serveur, hôte de plugins, SDK et points d'entrée plugin), `packages/core` (port driver, sessions, recordings, notifier, page-eval), `packages/drivers` (backends Camofox et MCP externe), `packages/mcp` (catalogue d'outils), `packages/router` (routeur de scrape à paliers), `packages/purify` (HTML vers markdown), `packages/sdk` (client typé et hooks React). Il y a aussi deux skills agent (`browser`, `bureau`), cinq références de skill (capture, cookies, recon, transport, writes) et six pages de documentation.

La couche métier est complète et lisible: registre de navigateurs, gestion de sessions, leases, ledger de consentement, compteur d'usage, contrôle de licence, rate limit, récolte d'orphelins, live view, vision, export via `@canvakit/export`, receitas (recipes) et engine de workflow.

Dans le dépôt plateforme, les adaptateurs existent et sont publiés: `@agentproto/adapter-browser` (0.8.0, 2 456 téléchargements sur 30 jours), `@agentproto/adapter-browser-camofox` (0.2.4, 1 982), `@agentproto/browser-profiles` (0.2.4, 1 250), `@agentproto/plugin-local-browser` (0.3.6, 1 611), `@agentproto/browser-process` (0.2.1, 1 196), `@agentproto/driver-browser` (0.3.1, 2 197).

### Tests et CI

Le miroir public compte 38 fichiers de test, sur des sujets qui comptent: catalogue d'outils avec snapshot golden (`tool-catalogue.snapshot.json`), portes de capacité, gate de grant, lease, ledger, rate limit, usage meter, licence, plugins, doctor, install-mcp, réapparition d'orphelins. Les tests ne touchent jamais un navigateur réel, tout passe par des fakes.

Il existe un script `scripts/quickstart-check.mjs` qui rejoue réellement les étapes 2 à 4 du démarrage sur un HOME temporaire, avec un Camofox fake et une page HTTP locale. Le résultat est archivé dans `docs/quickstart-run.txt`: PASS en 6 536 ms sur Node 22, démarrage du serveur, refus 401 sans jeton, installation MCP idempotente (config identique au second passage), initialisation MCP, 19 outils listés, navigate et evaluate qui lisent le titre de la page, et exemple SDK qui tourne. C'est une preuve de fin de parcours fonctionnelle, pas une simple suite unitaire.

Deux réserves sérieuses sur la CI. Le workflow `ci.yml` commence par la mention "Not run anywhere yet", et il dépend de paquets `@agentproto/*` publiés, ce qui force `--no-frozen-lockfile`. Le workflow `publish.yml` est explicitement en `PUBLISH_DRY_RUN: "true"` et ne publie rien tant qu'un mainteneur ne bascule pas le drapeau: il n'y a pas de `workflow_dispatch` qui puisse le contourner. Les paquets sont donc sur npm, mais la chaîne de publication automatique est à l'arrêt. Un job `release-scan` interdit toute mention des noms de produits privés dans l'arbre, ce qui confirme que le dépôt public est volontairement une coquille open core.

### Déploiement

Bureau est publié sur npm en version 0.1.1 pour les sept paquets (`@agentproto/bureau`, `bureau-core`, `bureau-drivers`, `bureau-mcp`, `bureau-purify`, `bureau-router`, `bureau-sdk`), le 2026-10-17. Les téléchargements sont faibles et cohérents avec un usage interne: 134 pour le CLI sur 30 jours, 159 pour core, 385 pour drivers, 364 pour mcp, 360 pour sdk, 203 pour purify, 386 pour router. Le label de version est "v1, pre-release" dans le README.

Le repo public a 0 étoile. Aucun site produit, aucun prix, aucun canal de distribution: la distribution passe par `npm install -g @agentproto/bureau` et par le plugin de bureau d'agentproto.

### Dernières activités git

Le miroir public a 19 commits, de l'"Initial import of the open Bureau core" le 2026-09-29 au "chore: ignore .turbo caches and local .npmrc" du 2026-10-17. Les jalons sont lisibles dans l'historique: "pairing as the only auth", "bureau on the browser layer", "business hooks" (la couche hooks métier qui contient la licence et le compteur d'usage), "neutral examples and author for public launch", "Remove internal scan tooling leak", et la release 0.1.1 avec son correctif de module manquant (`kit-control-driver.ts`, un `git add` oublié qui cassait le build). Le 2026-10-17 est aussi la date de sortie npm, donc le rythme s'est arrêté il y a quatre jours par rapport à la date d'analyse.

Côté plateforme, le code d'intégration est vivant: `packages/browser-process` et `packages/browser-profiles` touchés le 2026-10-18 et le 2026-10-19, `adapters/browser-chrome` et `adapters/browser-chromium` le 2026-10-18 (upload de fichier et onglets multi-agents pour chrome-live, PR 2045), et le pack de skills Bureau qui documente en détail les recettes sociales.

## Ce qu'il faudrait pour en tirer du revenu

Le produit est plus avancé que son canal: la plomberie de monétisation est déjà écrite dans le code et n'est simplement pas activée.

1. **Activer le prix.** `createLicenseCheck` vérifie déjà un jeton compact `<header>.<payload>.<signature>`, ed25519, en-tête `bureau-license`, charge `{sub, exp, features[], tier?}`, avec refus propre si le jeton est absent, expiré ou altéré, journalisation du refus et exposition dans `/health` en `licenseRefusals`. Il manque seulement le signer, les paliers et le prix. Un palier par tiers (sessions, domaines, volume de captures) est directement compatible avec le compteur d'usage déjà en place: un `start`, un `heartbeat` par minute, un `stop` par instance et par session, en JSONL append-only.
2. **Décider ce qui reste gratuit et ce qui se paie.** Le README est explicite: "This is the open core. Site-specific recipes and hosted services plug in through the plugin seam and are not part of this repository." C'est la bonne structure de monétisation: le core Apache-2.0 reste gratuit et barrière d'entrée, les recettes par site, le service hébergé et le pilotage à distance se vendent en plugin ou en offre.
3. **Construire l'offre hébergée.** Le point d'ancrage naturel est le poste de travail navigateur Guilde et le poste de travail Camofox loué à l'heure, avec facturation au temps de session et au volume capturé, puisque le compteur d'usage mesure déjà ces deux grandeurs.
4. **Ouvrir la distribution.** Zéro étoile, 134 téléchargements par mois, aucun site produit, aucun prix: la distribution est aujourd'hui le principal frein, plus que la technique. La publication automatique est en dry run, donc chaque sortie de version est manuelle: il faut au minimum une page produit, une page pricing, et un canal d'acquisition (la liste de diffusion, la communauté agentproto, le repo camofox qui draine déjà du trafic vers l'écosystème).
5. **Corriger le rapport confiance/sécurité.** L'export de cookies depuis un profil Chrome réel et l'usage de comptes personnels exposent le produit à un fort risque de réputation et de conformité. Il faut une offre explicite "votre navigateur, vos comptes, votre machine" (local only), une offre "sessions louées et isolées" et des conditions d'usage qui interdisent le repérage non autorisé, avant toute vente.
6. **Trancher la gestion des échecs techniques du v1.** Pas d'encryptage au repos des consentements, pas de prise de contrôle en direct, `browser_download` sans verbe de port, catalogue d'outils pas encore re-ciblé sur Chrome: ces limites doivent être documentées publiquement, sinon elles deviendront des tickets de support et un frein de vente.

## Verdict PM

**Oui, un PM.** C'est le seul des deux projets du lot qui a une trajectoire produit viable, et il est à un pas de la vente: le contrat de licence est écrit, le compteur d'usage tourne, la couture à plugins existe, le produit est publishable et son quickstart est vérifié bout en bout. Ce qui manque n'est pas de la technique mais du pilotage: fixer les paliers et les prix, décider ce qui est gratuit dans le core et ce qui est vendu en plugin ou en service hébergé, remettre la publication automatique en marche, ouvrir un canal de distribution, et rédiger les conditions d'usage. C'est exactement le périmètre d'un PM produit, court et à horizon de semaines. Sans PM, le projet reste une pièce technique brillante que personne ne vend.
