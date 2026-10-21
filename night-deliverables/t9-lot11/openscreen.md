# openscreen

## Perimetre et limites

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/openscreen`) n existe pas dans le bac a sable de cette session, et le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces). Aucun fichier du projet n a donc pu etre lu.

J analyse le depot miroir public `agentiknet/openscreen`, fork de `siddharthvaddem/openscreen`. Aucun build et aucune installation n ont ete lances.

## A quoi il sert

OpenScreen est un enregistreur d ecran libre qui produit des demos et des walkthroughs soignes. Le positionnement est explicite: une alternative libre a Screen Studio, gratuite, sans abonnement, sans filigrane, utilisable en commercial.

Le produit de base est une application Electron (capture, zoom, effets de curseur, webcam, sous-titres, annotations, export). L apport propre du miroir est un module `scripts/studio/`, decrit par son README comme le "desktop video studio core":

- `recorder.mjs`: capture via ffmpeg, detection automatique du peripherique `avfoundation`, enregistrement par region (une fenetre ou un ecran) plutot que du plein ecran.
- `to-openscreen.mjs`: conversion deterministe d un journal d actions en projet `.openscreen`. Chaque clic devient une region de zoom (profondeur 3, fenetre de 1600 ms), les temps morts de plus de 2500 ms deviennent des regions d acceleration a 4x. La sortie est compatible exactement avec le format `EditorProjectData` de l editeur.
- `pacing.mjs`: passe de rythme par LLM (OpenRouter).
- `render-ffmpeg.mjs` et le mode `--openscreen-render`: rendu final, soit par segment/concat ffmpeg, soit en pilotant l editeur reel en headless via Playwright et Electron.

En clair, le module studio prend une session agent (clics, frappes, captures) et la transforme en video de produit finie. C est la brique qui relie openscreen a l ecosysteme agentique, et c est ce que le miroir ajoute.

## Etat reel

### Code

536 fichiers suivis. Application Electron avec deux arbres: `electron/` (main, preload, IPC, recording, native, diagnostics) et `src/` (React, composants, hooks, i18n), plus `tests/` (unitaires et e2e), `scripts/` (y compris `scripts/studio/` et `scripts/headless-export`). Version `1.6.0` dans `package.json`, `private: true`.

### Tests

46 fichiers de test. La suite combine `vitest` (config `vitest.config.ts` et `vitest.browser.config.ts`), `playwright.config.ts` pour l e2e et `@testing-library` pour les composants. La CI lance `npm run test` puis `npm run test:browser:install` et `npm run test:browser`, donc les tests navigateur sont bien dans la chaine.

### CI

C est le projet le mieux equipe du lot: 14 workflows dans `.github/workflows/`. `ci.yml` enchaine lint (biome), typecheck (`tsc --noEmit`), tests unitaires, tests navigateur, build vite et validation des titres de pull request. Le reste est de la distribution et de la communication: `aur-publish.yml`, `publish-winget.yml`, `update-homebrew-cask.yml`, `bump-nix-package.yml`, `promote.yml`, `prerelease.yml`, `diagnostic-artifact.yml`, et plusieurs workflows Discord (notification de PR, synchronisation de la feuille de route, classement hebdomadaire).

### Deploiement

Bureautique. Le produit est distribue par les gestionnaires de paquets systeme: winget, AUR, Homebrew et Nix. C est une strategie de distribution qui evite les stores payants et les commissions.

Point important: le depot miroir ne publie aucune release. Il n y a pas de tag Git et l installateur n est donc pas livrable depuis ce depot en l etat.

### Dernieres activites git

699 commits, tous anterieurs au 2026-07-10: 29 en fevrier, 112 en mars, 334 en avril, 169 en mai, 23 en juin, 32 en juillet. Le dernier commit est la synchronisation du fork avec l amont (2026-07-10), qui precede de quelques commits l ajout du module studio et l export headless. Dernier push le 2026-07-10.

Comparaison avec l amont: l original `siddharthvaddem/openscreen` est archive (39 928 etoiles, 3191 forks, dernier push le 2026-10-17), et la continuite est assuree par `getopenscreen/openscreen` (4735 etoiles, 309 forks, actif jusqu au 2026-10-21). Le miroir du workspace contient l historique complet de l original et 100 commits en retard sur `getopenscreen`. Concretement, les correctifs et les evolutions d autumne 2026 du projet vivant ne sont pas dans le miroir.

## Ce qu il faudrait pour en tirer du revenu

Le produit dit lui-meme qu il n aura jamais de palier payant: "OpenScreen has no paid tiers, premium features, upsells, or functionality locked behind a paywall". Donc le revenu ne viendra pas de l application de bureau telle quelle. Trois pistes realistes:

1. Un service heberge de generation de demos. Le client envoie une session agent ou une sequence d interactions, le service renvoie une video au format OpenScreen. C est exactement ce que le module studio sait faire, mais en service, avec file d attente, rendu asynchrone et hebergement des projets.
2. Une offre de production de demos pour les equipes produit. Le projet est deja utilise comme alternative a Screen Studio par des equipes produit; la prestation (production de la demo de sortie de version, montage, sous-titrage, publication) est le modele le plus rapide vers la revenue.
3. Une licence de la chaine studio pour des outils tiers. Le module est en Node ESM et parle le format `.openscreen`: il peut devenir une bibliotheque, avec une part editoriale si le projet studio se diffuse.

A ne pas faire: reimplementer un editeur video. La valeur est dans le module studio, pas dans le lecteur.

## Est-ce qu il merite un PM

Non pour le miroir lui-meme, et voila pourquoi: c est une copie de travail d un projet libre vivant, sans release, en retard de l amont, et le README interdit explicitement toute monetisation de l application. Un PM n a rien a arbitrer la-dessus.

Oui en revanche pour une decision de produit a prendre explicitement: le module studio est la seule piece qui n existe ni en amont ni ailleurs, elle est techniquement aboutie (deterministe, documentee, verifiee de bout en bout), et elle est strategiquement interesante. Cette decision (service heberge, prestation, ou licence) est une decision de PM, pas une decision d ingenieur. Tant qu elle n est pas prise, le miroir reste un projet sans propriétaire.

## Sources

- `agentiknet/openscreen` (miroir, lu), `siddharthvaddem/openscreen` (amont archive), `getopenscreen/openscreen` (continuite active)
- metadonnees GitHub via l API, etat des workflows et des releases
