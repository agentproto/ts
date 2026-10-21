# agent-books

Perimetre et limites de cette analyse : le clone local du workspace (`projects/agentik-studio/projects/agent-books`) n existe pas dans le bac a sable de cette session, et le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces). Aucun fichier de ce projet n a donc pu etre lu. Ce qui suit porte sur la chaine technique reellement verifiable autour du livre dans les depots accessibles, et sur ce que le projet peut etre. Les lectures sont listees en fin de fichier, et les zones d incertaines sont signalees explicitement.

## A quoi il sert

Lecture la plus coherente avec les artefacts trouves : `agent-books` est un projet de livres crees ou enrichis par des agents, livres sous forme de paquets installables, distribues par le canal d applications d agentproto.

Le contrat existe deja dans le code, dans `packages/create-agentproto-app/templates/book/`. Le fichier `APP.md` du modele porte :

- `category: book`, une categorie d application a part, documentee dans `packages/app-kit/src/types.ts` comme regroupement grossier expose dans les catalogues et les arbres ;
- une bibliotheque `library.books[]` avec au moins un `{ id, title }` ;
- un agent d accompagnement, un workflow, une interface, et une liste d outils de l application (`app_run`, `app_status`, `app_data_read`, `app_data_write`...) ;
- un fichier de garde `.claude/skills/install-agentproto-app/SKILL.md`, decrit dans le modele comme "the tier-1 install path for buyers", donc une porte d installation destinee a un acheteur.

Le vocabulaire de la chaine est donc precis : un livre est un bundle, il s installe comme une application, et son acheteur est explicitement prevu.

## Etat reel

### Code

Ce qui existe reellement, c est la chaine, pas le contenu :

- Le modele `book` de `create-agentproto-app` : `APP.md`, un agent `__APP_SLUG__-assistant/AGENT.md`, un workflow `__APP_SLUG__-flow/WORKFLOW.md`, une interface `ui/index.html` (81 lignes a la creation), le `.gitignore` et la skill d installation.
- Le contrat de bundle de livre dans `packages/app-kit` (`define-app`, `emit`, `load-app`, types), avec tests dedies.
- Les trois primitives de distribution d agentproto : installation par depôt git (`app_install` puis `app_resync` avec sha epingle), bundle `.agentapp` (`agentproto app pack --release`), et catalogue distant statique fusionne par `app_catalog`. Chaque installation enregistre sa provenance, ce qui rend le re-synchronisation, la verification de sha et les mises a jour reproductibles.
- Le substrat documentaire : `packages/knowledge` (AIP-10, `KNOWLEDGE.md`, wiki markdown lintee au-dessus de sources brutes immuables), `packages/corpus` (composition AIP-10/12/18/9/15/41, 40 fichiers de test) et `packages/lesson` (AIP-11, capitalisation des lessons). C est exactement la chaine qui transforme des sources brutes en artefact compilant, donc le coeur technique d un livre produit par agents.
- L analogue public du marche : `romainsimon/skills-for-decision-making` (13 etoiles, dernier push le 2026-07-26) convertit un livre ("Algorithms for Decision Making") en fichiers `SKILL.md` avec un calculateur sans dependance. C est la meme idee de produit, livre vers competence executable, sur un marche voisin.

### Tests

Le modele `book` n a pas de test a lui, ce qui est normal pour un modele, mais il est couvert indirectement : `packages/create-agentproto-app` compte 3 fichiers de test dont `scaffold.test.ts` (86 lignes ajoutees lors de l introduction du modele) et `cli.test.ts`, et `packages/app-kit` en compte 14, dont `define-app.test.ts`, `emit.test.ts` et `load-app.test.ts` ajoutes par le commit du contrat de bundle. Le `packages/corpus` compte 40 fichiers de test. La base de tests du sous-systeme est donc solide, ce qui n est pas le cas partout ailleurs dans l ecosysteme.

### Deploiement

Rien n est publie : il n existe aucun livre en tant que bundle distributable, aucun catalogue distant listant des livres, et aucun mecanisme de paiement. Les applications installees chez un utilisateur sont des applications, pas des livres, et la categorie `book` n est, a ma connaissance, portee par aucun artefact public.

### Dernieres activites git

La chaine est recente et maintenue : le contrat de bundle de livre et la skill d installation de niveau 1 sont arrives dans le commit `4d01e5c3` (PR #1123), le modele `book` a ete repris au commit `d7f5063b` (PR #2098) du 2026-10-19, et `packages/app-kit` comme `packages/create-agentproto-app` ont ete touches le 2026-10-19 par la release `473703ff`. C est du travail des dernieres semaines, donc le sujet est vivant cote plateforme.

Coté contenu, en revanche, je n ai trouve aucune trace d un livre en cours, ni d un catalogue, ni d un pipeline d edition. C est le point aveugle le plus serieux de ce dossier.

## Ce qu il faudrait pour en tirer du revenu

La distribution est deja batie, il manque le contenu et le commerce. Dans l ordre :

1. Un catalogue de livres installables, avec une page de vente. Le canal existe (`app_catalog`, bundle `.agentapp`, `app install`), la page de vente n existe pas. C est le premier manque et le plus visible.
2. Un modele de licence et de prix. Un livre vendu a l unite, par abonnement, ou par licence d equipe. Il faut une regle de propriete intellectuelle explicite : qui detient les droits sur un texte genere par un agent, sur les sources citees, et sur les competences derivees. C est le point juridique le plus risque du projet, et il n est traite nulle part.
3. Un pipeline d edition reproductible : sources brutes, compilation, relecture, couverture, export. Les briques existent (knowledge, corpus, lesson, canva-writer pour la couverture, export PDF), mais aucune n est assemblee en chaine pour un livre.
4. Une offre de service pour les auteurs et les editeurs : "on transforme votre manuscrit en livre agentique". C est monetisable immediatement, sans avoir besoin d un marche, et cela finance le temps de construction du reste.
5. Une differentiation. Sans elle, le projet est un canal de distribution de plus. Les deux angles tenables sont le livre executable (le livre installe sur la machine du lecteur, avec competences operationnelles) et le livre verifiable (chaque affirmation rattachee a sa source, sur le modele de Naia). Le premier est un produit, le second est une promesse.

## Merite-t-il un PM

Oui, mais c est le dossier ou le PM est le plus clairement necessaire, et le verdict est conditionnel a une decision a prendre en premier.

Pourquoi oui : c est le seul projet du lot qui a un modele de revenu identifiable (vente de contenu), une chaine de distribution deja operationnelle, et aucun contenu. Il manque tout ce qui se decide : la definition de l offre (livre, livre executable, ou competence), le prix, le modele de droits, le pipeline d edition, la page de vente. Ce sont des arbitrages de produit, pas de technique. Sans eux, le projet reste un modele vide.

Pourquoi la condition : il faut d abord decider si `agent-books` est un projet de contenu (on edite et on vend des livres) ou un projet de plateforme (on outille ceux qui edient). Le premier se pilote avec un PM et une equipe editorial, le second est une brique de `agentproto/ts` et se pilote avec un lead technique. Les deux exigent des competences opposees, et les melanger est la facon sure de ne pas avancer.

Dans les deux cas, un PM est justifie des maintenant, parce que la premiere decision a prendre est un choix de positionnement, et que ce choix conditionne tout le reste du travail.

## Sources reellement lues

- `agentproto/ts` : `packages/create-agentproto-app/templates/book/**` (contenu integral des fichiers du modele), `packages/create-agentproto-app/src/__tests__/scaffold.test.ts` et `cli.test.ts`, `packages/app-kit/src/types.ts` (categorie `book`), `packages/app-kit/src/__tests__/**`, `packages/knowledge`, `packages/corpus`, `packages/lesson` (volumes de tests), `docs/cli/guides/distribute-an-app.md` et `docs/cli/guides/create-agentproto-app.md`, git log des commits `4d01e5c3` et `d7f5063b`
- `romainsimon/skills-for-decision-making` (public) : structure du repo (13 skills issues d un livre), README, activite recente
- Recherche GitHub sur les organisations accessibles : aucune trace de `projects/agent-books` dans un depot public

## Limites

C est le dossier le plus expose de lot : je n ai lu aucun fichier du projet, et je n ai trouve aucun artefact public qui le mentionne. La description ci-dessus est une reconstruction a partir du vocabulaire officiel du canal (modele `book`, categorie `book`, "tier-1 install path for buyers") et de la chaine technique qui l entoure. Si le projet est en realite un projet de redaction automatisee (documents, rapports, livres numeriques) et non un produit d edition, mon analyse du modele de revenu est a reecrire, meme si le diagnostic "distribution prete, contenu absent, arbitrage de positionnement a prendre" resterait valable.
