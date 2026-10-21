# hackatons

Perimetre et limites de cette analyse : le clone local du workspace (`projects/agentik-studio/projects/hackatons`) n existe pas dans le bac a sable de cette session, et le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces). Le dossier de travail n a donc pas pu etre parcouru. Ce que j analyse est le projet qui y vit d apres les traces publiques : le dossier `projects/hackatons/naia` est un depot git imbrique, publie sous `github.com/agentiknet/hackaton-naia`, et son document de reprise y fait explicitement reference.

## A quoi il sert

`hackatons` est un conteneur de projets realises pour des hackathons, dans lequel chaque equipe de hackathon travaille comme un projet a part entiere, avec son propre depot git imbrique. Le dossier joue le role d une vitrine et d un terrain d essai : chaque entree est une piece de concours datee, avec sa demonstration, son pitch et ses livrables de soumission.

Ce n est pas un produit. C est un reservoir de projets et de materiaux reutilisables, et son rendement indirect est la visibilite et la masse critique obtenue sur les concours.

Le seul projet dont j ai pu reconstituer l contenu en entier est `naia`, construit pour le hackathon de l Assemblee Nationale 2026.

## Etat reel (projet naia)

### Code

Repo `agentiknet/hackaton-naia`, 49 commits, 97 fichiers a la racine de l arborescence. TypeScript, Node 20 et plus, pnpm.

L architecture revendiquee est celle d un assistant parlementaire gouverne, en cinq couches, avec un Conseil des Mentors qui verifie chaque affirmation contre les sources officielles avant reponse. Le code confirme cette description :

- agents Mastra declaratifs dans `src/mastra/agents/` : `naia` (claude-sonnet-5), `mentor-juriste` et `mentor-parlement` (claude-haiku-4-5), chacun avec son `instructions.md` lu au demarrage ;
- client MCP natif `@mastra/mcp` vers un serveur de recherche legale, 20 outils `moulineuse_*` ;
- pipeline de verification dans `src/pipeline/` (`claims.ts`, `verify.ts`, `concurrency.ts`) : decoupage en affirmations, verification concurrente, delai de 20 s par mentor, budget global de 90 s, statuts `certified`, `insufficient` quand plus de la moitie des sources sont inconnues, `refused`, un retry ;
- journal d audit JSONL dans `src/audit/log.ts`, et endpoints Hono `/api/chat`, `/api/verify`, `/api/audit/:id` ;
- interface autonome `web/index.html` (chat, panneau de certification, jauge de confiance, bandeau de refus, timeline, vue audit, mode demo) ;
- export PDF dans `src/export/pdf.ts`, agent d export Canva dans `src/mastra/agents/canva-writer/`, generateur de pitch deck dans `src/scripts/gen-pitch-deck.ts` ;
- fixtures de demonstration et de rejeu (`fixtures/demo/`, `fixtures/moulineuse/`) avec un mode mock declenche par variable d'environnement ;
- livrables de concours dans `hackathon-an-2026/` : `DEFI.md`, presentation, deux PDF de diapositives, deux videos, sept captures d ecran ;
- scripts de smoke : `smoke:mcp`, `smoke:claims`, `smoke:verify`, `smoke:pipeline`.

Le `package.json` est en `private: true`, depend de `@canvakit/core` et `@canvakit/export` en `file:../../canvakit/packages/...`, ce qui confirme la structure locale du workspace et le couplage a l outil de rendu interne.

### Tests

Il n y a aucun framework de test unitaire (ni vitest ni jest dans le `package.json`). La verification repose sur quatre scripts de smoke executes en `tsx`, qui sont des probes d integration contre le serveur et le MCP reels, plus une recette manuelle detaillee dans le document de reprise (deux requetes de controle, une attendue `certified` avec score et sources, une attendue `refused` ou `insufficient`, plus la relecture du journal d audit). Le `typecheck` existe (`tsc --noEmit`) et le build est un `tsc` simple.

C est le point faible assume du projet : la logique metier qui compte, celle qui decide de certifier ou de refuser, n est couverte par aucun test de regression. Un changement de seuil ou de formulation des instructions peut faire passer une mauvaise reponse en `certified` sans qu aucun signal ne le dise.

### Deploiement

Aucun deploiement public. Le service tourne en local via `tsx src/server.ts`, lit un fichier `.env` (cle Anthropic, URL du MCP), et depend d un service externe de recherche legale. Un mode demo et un mode mock permettent de rejouer des fixtures si l API est indisponible, ce qui est la strategie de immunisation de la demo retenue lors du concours. Aucune image, aucun manifeste de deploiement, aucun en pipeline de publication.

### Dernieres activites git

C est le point le plus net. Le repo a ete cree le 2026-07-04 et tous les commits (49) sont traces entre le 2026-07-03 et le 2026-07-04. Dernier commit le 2026-07-04 a 15:49 UTC, sur des videos et des diapositives. Aucune activity depuis, soit environ trois mois et demi de silence.

Le document de reprise du 2026-07-04 signale explicitement qu une partie du travail de calibration etait non committee dans l arbre au moment de l arret, et qu une gate finale avait ete interrompue par un redemarrage. Autrement dit, le projet a ete fige en cours de qualification, pas apres qualification.

Le repo est public (contrairement a ce qu indiquait le document, qui prevoyait un passage public au freeze) et compte 0 star.

## Ce qu il faudrait pour en tirer du revenu

En l etat, le rendement est reputational, pas financier : un prix, une mention, de la visibilite pour le studio. Trois conversions sont possibles :

1. Transformer la chaine "assistant gouverné, reponse certifiee" en produit. La technique (conseil de verificateurs, arbitrage par code, journal d audit, refus assume) est transposable a d autres domaines ou une reponse fausse coute cher : collectivites, entreprises, conformite, sante. C est la piste la plus serieuse, et elle est independante du hackathon.
2. Vendre la production, pas le produit. Ce que le projet sait faire de maniables : produire une demo qui tient, generer un pitch deck, produire des videos, monter des diapositives. C est un service vendable a d autres equipes de hackathon, facturable a la prestation. Les outils sont deja la (canvakit, gen-pitch-deck, export PDF, agent Canva).
3. Utiliser les hackathons comme canal de prospection. Les equipes qui passent 3 jours sur un sujet precis sont des prospects identifies, avec un livrable deja ecrit. C'est gratuit et c'est ce que le dossier fait deja de facto.

Ce qu il ne faut pas faire : essayer de monnayer chaque entree du dossier individuellement. Les concours sont des artefacts jetables par nature, et un projet de hackathon sans client payeur n'est pas un produit.

## Merite-t-il un PM

Non pour le dossier tel quel. Oui, mais sous condition, si le dossier devient une offre.

Pourquoi non pour le dossier : chaque entree a une date limite, une variance elevee, aucun utilisateur, aucun revenu recurrent, et un cycle de vie de deux jours observe sur la seule entree verifiable. Un PM n aurait aucun arbitrage a rendre. Ce qu il faut, c est un curator avec un formulaire d entree standardise (contexte, jury vise, livrables attendus, date) et une regle de archivage.

Pourquoi la condition : les deux conversions qui rapportent (produit gouverné, service de production) sont des offres qui demandent un positionnement, un prix, une cible. Si l intention est de les lancer, alors oui, un PM est necessaire, mais sur l offre et pas sur le dossier. Et il faut d'abord decider laquelle des deux conversions on vise, parce qu'elles ne se pilotent pas de la meme facon.

## Sources reellement lues

- `agentiknet/hackaton-naia` (public) : arborescence complete (97 entrees), `package.json`, `README.md`, `ARCHITECTURE.md`, `REPRISE.md`, `HANDOFF-2026-07-04.md`, presence et contenu des dossiers `src/`, `web/`, `fixtures/`, `hackathon-an-2026/`, historique des 49 commits, metadonnees du depot
- `agentiknet/rendez-vous` (public) : ou figure la reference explicite a `projects/hackatons/naia` comme repo imbrique, et la regle de depot imbrique dans l arbre parent

## Limites

Je n ai pas parcouru le dossier `projects/hackatons` lui-meme : je ne sais pas combien d entrees il contient, ni lesquelles au-dela de naia, ni si des entrees plus recentes que juillet 2026 existent. L analyse porte sur une entree sur N, la seule que le monde public documente. Il est possible que d autres entrees soient plus recents et plus Alive, auquel cas mon verdict sur l activite du dossier serait trop severe.
