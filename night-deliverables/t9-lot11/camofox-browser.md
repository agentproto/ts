# camofox-browser

## Perimetre et limites

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/camofox-browser`) n existe pas dans le bac a sable de cette session, et le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces). Aucun fichier du projet n a donc pu etre lu.

J analyse le depot miroir public `agentiknet/camofox-browser`, fork de `jo-inc/camofox-browser`. Aucun build et aucune installation n ont ete lances.

## A quoi il sert

camofox-browser est un serveur de navigation anti-detection pour agents IA, construit sur Camoufox, un fork de Firefox qui falsifie l empreinte au niveau C++ (concurrence materielle, rendu WebGL, AudioContext, geometrie d ecran, WebRTC).

Le probleme resolu est reel: Playwright se fait bloquer, Chrome headless est identifiable, les plugins stealth finissent par former une empreinte reconnaissable. Le projet expose une API REST pensee pour les agents:

- Des snapshots d accessibilite au lieu de HTML, environ 90% plus petits, ce qui economise du contexte.
- Des references d elements stables (`e1`, `e2`) pour cliquer sans repasser par des selecteurs fragiles.
- Des macros de recherche pour les sites courants, un import de cookies, un recyclage d onglets, un endpoint de transcription YouTube, des metriques Prometheus, une abstraction de provider de proxy, et un plugin OpenClaw.

C est une brique d infrastructure, pas un produit fini, et c est ce qui la rend interessante: tout agent qui doit naviguer sur le web reel en a besoin.

## Etat reel

### Code

61 fichiers suivis. Serveur Express (`server.js`) et bibliotheque `lib/` en 13 modules: `config`, `cookies`, `downloads`, `fly` (Fly.io), `images`, `launcher`, `macros`, `metrics`, `proxy`, `request-utils`, `snapshot`, `youtube`. Version `1.5.2`, paquet publie sous le nom `@askjo/camofox-browser`, `private` absent donc publie. `postinstall` lance `npx camoufox-js fetch` pour telecharger le moteur.

Depoiement prevu de trois facons: local (`npm start`, port 9377), conteneur Docker avec `Dockerfile` et `Makefile` qui pre-telecharge les binaires Camoufox et yt-dlp hors du build, et hebergement chez Fly.io ou Railway (`lib/fly.js`).

### Tests

27 fichiers de test avec Jest, organises en `tests/unit`, `tests/e2e` et `tests/live`. Les scripts npm distinguent `test`, `test:e2e`, `test:live` (derriere `RUN_LIVE_TESTS=1`) et `test:debug`. La suite est serieuse et bien decoupee.

### CI

Aucun workflow GitHub Actions dans le miroir. Les tests ne sont donc pas executes automatiquement sur le fork. A noter que l amont en a, notamment un workflow de deploiement de telemetrie, absent ici.

### Deploiement et adoption reelle

Le paquet amont `@askjo/camofox-browser` est publie en version `1.18.1` (45 versions au total, derniere modification le 2026-10-05) et enregistre environ 92 000 telechargements sur les 30 derniers jours. L amont `jo-inc/camofox-browser` compte environ 11 800 etoiles, 1183 forks, 246 issues ouvertes et un push le 2026-10-16. Le miroir, lui, est fige en version `1.5.2`.

Concretement: la demande existe, elle est chez l amont, pas chez le miroir.

Ce qui est deja fait dans l ecosysteme: le monorepo `agentproto/ts` integre ce serveur via le paquet `adapters/browser-camofox`, dont le README precise que le serveur est `jo-inc/camofox-browser` (MIT, Jo Inc.) et que les correctifs vivent dans le fork `bureau-sh/camofox-browser`. Le contrat HTTP est donc deja consomme en production par le runtime.

### Dernieres activites git

103 commits: 40 en fevrier 2026, 47 en mars, 16 en avril. Dernier commit le 2026-04-06 (`v1.5.2`, avec le correctif de Content-Type sur les captures et le nettoyage des sessions vides), dernier push le 2026-06-02. Le miroir est 15 commits en retard sur l amont.

## Ce qu il faut pour en tirer du revenu

Le marche existe mais il est deja pris par Jo, dont la monétisation passe par `askjo.ai`, un assistant personnel heberge. On ne peut pas vendre le serveur tel quel.

Les pistes qui restent ouvertes:

1. Un hebergement de navigateur pour les agents, vendu au volume. Un serveur camofox dans un cloud, avec proxy et isolation, facture au navigateur ou au Go. C est un service d infrastructure, avec un cout de sortie par IP qui rend le prix facile a fixer.
2. Une offre de.navigation pour agents, adossee au runtime agentproto. Le runtime sait deja piloter camofox: c est un argument que les pure players n ont pas, et qui permet de vendre un resultat (le site a ete lu, la donnee extraite) plutot qu un navigateur.
3. Une edition conforme pour les entreprises: isolation par tenant, journal d audit, pas de telemetrie sortante, SLA. La question du chiffrement de l trafic et de la localisation des IP est un vrai sujet de vente B2B.
4. La telemetrie et le telechargement de modeles, deja geles par l amont, montrent que la valeur du projet est captée par l operateur du service, pas par le developpeur du serveur.

## Est-ce qu il merite un PM

Non pour le miroir. C est un fork sans CI, en retard de 15 commits sur un amont actif, dont la valeur est deja captée ailleurs et dont l usage dans l ecosysteme est deja couvert par `adapters/browser-camofox` dans `agentproto/ts`.

Le PM n est pas necessaire tant que la seule question ouverte est "faut-il garder ce miroir". Elle se repond par la synchronisation, pas par de la gestion de produit. Un PM deviendrait pertinent au moment ou l on decide de vendre de l hebergement de navigateur pour les agents, parce que la decision porte alors sur le packaging, le prix, la SLA et la conformite.
