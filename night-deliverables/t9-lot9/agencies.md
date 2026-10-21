# agencies

Perimetre et limites de cette analyse : le clone local du workspace (`projects/agentik-studio/projects/agencies`) n existe pas dans le bac a sable de cette session, et le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces). Aucun artefact du dossier `projects/agencies` lui-meme n a donc pu etre lu. Ce qui suit est reconstruit a partir des artefacts publics et verifiablements lies au projet (implementation de reference dans `agentproto/ts`, spec `agencies-sh/spec`, catalogue `openagentik/companies`). Les sources sont listees en fin de fichier.

## A quoi il sert

`agencies` est la couche operationnelle de l ecosysteme : le vocabulaire standardise d une entite qui agit pour un client. Concretement, une agence y declare ce qu elle vend (`SERVICE.md`), comment elle le facture (`PRICING-MODEL.md`), a qui (`COUNTERPARTY.md`), dans quel cadre commercial (`ENGAGEMENT.md`, `AGREEMENT.md`), ce qu elle livre (`DELIVERABLE.md`), ce qu elle facture (`INVOICE.md`), comment elle execute (`PROCEDURE.md`), ce qu elle fait recurrent (`ROUTINE.md`) et de quelle capacite elle dispose (`CAPACITY.md`).

Le double sens est assume dans la spec : "agence" au sens business (service business, consultancy, freelances qui travaillent pour des clients) et au sens philosophique/IA (un systeme capable d agir avec intention et autonomie). Les deux se rejoignent sur la meme formalisation de fichiers, ce qui permet a un humain et a un agent de partager le meme dossier de travail.

C est le socle sur lequel reposent les autres projets du lot : le catalogue d agences pretes a l emploi, la monetisation des agents, et les applications de type "livre" quiLivrent des competences.

## Etat reel

### Code

Implementation de reference dans le monorepo `agentproto/ts`, dossier `packages/agencies`, 61 fichiers, environ 4 600 lignes de TypeScript, reparti en trois paquets npm publics :

| Paquet | Version | Role |
| --- | --- | --- |
| `@agentproto/agencies` (core) | 0.1.6 | 11 doctypes, validateurs, renderers, templates canvakit, extraits de procedure et de routine |
| `@agentproto/agencies-engine` | 0.1.13 | Marcheurs de workspace (`computeAgencyOverview`), helpers d index, orchestration fichiers uniquement |
| `@agentproto/agencies-mastra` | 0.1.6 | Adaptateur Mastra : codegen `PROCEDURE.md` vers `workflow.ts`, orchestrateur d engagement |

Le core expose des doctypes (agency, service, engagement, agreement, deliverable, invoice, counterparty, procedure, pricing-model, routine, capacity), des validateurs, des renderers (tableau de bord d engagement, fiche d agence, signature d accord, revue de livrable, facture PDF, fiche de procedure) et sept templates canvakit. Un test dedie `vendor-neutrality.test.ts` verifie que le paquet ne depend d aucun vendor.

Le moteur passe par `IGovernanceFilesystem` de `@agentproto/governance-engine` : le meme code tourne sur `fs` en local et sur Supabase ou S3 en production. C est le point le plus abouti du lot.

Un successeur est deja dans le code : `@agentproto/agency-v2` (AIP-21) annonce remplacer les onze doctypes codes en dur par des collections AIP-18, mais son README indique explicitement "Status: 0.1.0-alpha" avec des corps `build()` et `validate()` en TODO. Les deux generations coexistent donc, ce qui est un vrai sujet de coherence produit.

### Tests

6 fichiers de test, environ 1 630 lignes :

- `doctypes.test.ts` (361 lignes), `renderers.test.ts` (251), `validators.test.ts` (201) dans le core
- `vendor-neutrality.test.ts` (65) dans le core
- `compute-agency-overview.test.ts` (266) et `integration.e2e.test.ts` (486) dans le moteur

Le paquet Mastra declare `vitest run --passWithNoTests`, donc aucun test n existe pour l adaptateur, ou le codegen de workflow. C est le trou de couverture le plus visible.

### Deploiement

Les trois paquets sont publies sur npm en acces public. Dernieres versions publiees le 2026-10-19 (`agencies` 0.1.6, `agencies-engine` 0.1.13, `agencies-mastra` 0.1.6). Versions publiees au total : 8, 14 et 8. Telechargements sur les 30 derniers jours : environ 333 pour `@agentproto/agencies` et environ 957 pour `@agentproto/agencies-engine`, soit environ 1 300 installations par mois. C est le seul indicateur de revenu du lot qui existe reellement a ce jour, et il est faible mais non nul.

### Dernieres activites git

Sur `packages/agencies` dans `agentproto/ts` : 28 commits, premier le 2026-05-01, dernier le 2026-10-19. Le dernier commit est un chore de release (`chore(release): version packages`), et les precedents sont pour l essentiel des chores (release, refresh de dependances). La derniere activite fonctionnelle remonte a plusieurs mois : le projet est vivant cote publication, pas cote conception.

Sur la spec `agencies-sh/spec` (`agentagencies/v1`) : seulement 2 commits, les 2026-04-26 et 2026-04-27, avec un exemple `hello-world` complet (agency, company, team, agents, projects, skills, tasks). La spec est restee au stade du brouillon epaissi et n a plus bouge depuis avril.

Sur le catalogue `openagentik/companies` : 2 commits, les deux le 2026-04-26 (ajout de paperasse puis de ostack), avec un workflow CI `validate.yml`. Deux agences pretes a l emploi, 6 agents et 6 skills pour paperasse, 5 agents et 28 skills pour ostack.

## Ce qu il faudrait pour en tirer du revenu

La spec, elle, ne se vend pas : c est un standard ouvert, c est justement ce qui lui donne de la valeur. L argent se prend autour.

1. Un runtime heberge pour les agences. Aujourd hui tout est dans des fichiers markdown ; il faut une offre ou l on souscrit a une agence, on y deploie des engagements, on suit les livrables et on emet les factures. C est le produit qui transformerait le standard en revenu, et le moteur FS/S3 montre que l architecture est deja la.
2. Une offre de cadrage pour les professions reglementees, sur le modele de paperasse (compta, fiscal, notariat, copropriete) : vente de packs d agents et de skills, plus un abonnement de mise a jour. C est le modele qui a deja produit de l adoption dans l ecosysteme.
3. Un service de validation et de conformite : un CI ou un service paye qui verifie qu un dossier d agence respecte `agentagencies/v1` et `agentgovernance/v1` (signatures, journal d audit, politique). Peu de code, forte valeur, argumentaire de vente evident.
4. Une place de marche d agences : chaque agence publie ses skills, l acheteur les installe, l editeur touche une part. Le catalogue openagentik/companies est deja le prototype de la distribution, mais il n y a ni vitrine ni monetisation.

Le bloquant n est pas technique, c est le choix : standard ouvert gratuit contre standard ouvert qui sert de canal vers une offre proprietaire. Il faut trancher cette ligne avant d investir.

## Merite-t-il un PM

Oui pour la ligne produit "agences" (runtime heberge, packs metier, place de marche), non pour la spec elle-meme.

Pourquoi oui sur la ligne produit : plusieurs acheteurs distincts (agences, clients, plateformes), plusieurs formes de monétisation possibles et non tranchees, une decision de coherence a prendre (AIP-21 contre agentagencies/v1), et une base d adoption reelle qui existe deja (environ 1 300 telechargements npm par mois) mais qui n est monétisee d aucune facon. Quelqu'un doit arbitrer entre vendre l outil, vendre les packs et vendre l'accompagnement.

Pourquoi non sur la spec : elle a un editeur technique et une communaute, pas un besoin de PM. Un PM sur `agencies-sh/spec` serait un deplacement de moyens vers un standard dont l adoption se joue par l'usage, pas par la feuille de route produit.

## Sources reellement lues

- `agentproto/ts` : `packages/agencies/**` (core, engine, mastra), `packages/agency-v2/**`, READMEs et `package.json` des trois paquets, historique git du dossier, CI du monorepo (`.github/workflows/ci.yml`, aucune entree specifique a agencies)
- Registre npm : `@agentproto/agencies`, `@agentproto/agencies-engine`, `@agentproto/agencies-mastra` (versions, dates de publication, telechargements sur 30 jours)
- `agencies-sh/spec` (repo public) : arborescence `v1/`, README, 2 commits
- `openagentik/companies` (repo public) : arborescence des deux agences, workflow CI `validate.yml`, 2 commits
- `agentiknet/agentproto` (public) : `specs/resources/aip-21/draft/starters/agentagencies-v1-compat/` (compatibilite AIP-21)

## Limites

Aucun fichier du dossier de travail `projects/agencies` n a pu etre lu. L etat decrit est celui des artefacts lies, pas celui du dossier en question. Les volumes de fichiers et de lignes proviennent du clone local de `agentproto/ts`, donc ils sont exacts pour ce qui est dans ce depot et ignores pour le reste.
