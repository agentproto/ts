# paperasse

## Perimetre et limites

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/paperasse`) n existe pas dans le bac a sable de cette session, et le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces). Aucun fichier du projet n a donc pu etre lu.

J analyse le depot miroir public `agentiknet/paperasse`, fork de `romainsimon/paperasse`. Aucun build et aucune installation n ont ete lances.

## A quoi il sert

paperasse est une collection de skills markdown pour agents IA specialises dans la bureaucratie francaise. L objectif est ecrit tel quel dans le README: "Des skills pour agents IA specialises dans la bureaucratie francaise", avec la precision que le marche est le controle fiscal et l audit comptable, domains ou l erreur coute cher.

Les six skills livres:

| Skill | Perimetre |
| --- | --- |
| `comptable` | PCG, TVA, IS, cloture annuelle, FEC, liasse fiscale, facturation, e-reporting |
| `controleur-fiscal` | simulation de controle DGFIP, chefs de redressement |
| `commissaire-aux-comptes` | audit NEP en 7 phases, opinion motivee |
| `notaire` | frais de notaire, successions, donations, SCI, PACS |
| `syndic` | copropriete, assemblees, appels de fonds, travaux, contentieux |
| `fiscaliste` | IR, IFI, PFU, PEA, LMNP, RSU, BSPCE, crypto, PER |

Chaque skill est un `SKILL.md` accompagne de donnees de reference, de modeles et de scripts deterministes. Trois elements font la valeur du projet:

- Les scripts deterministes (`scripts/calc.js`, `generate-fec.js`, `generate-statements.js`, `generate-facturx.js`, `validate-facture.js`) : le calcul n est pas delegate au modele, il est fait par du code, avec une piste de calcul (`scripts/test-deterministic-calculations.js`).
- Les donnees publiques tracees (`data/sources.json`) : PCG 2026 en JSON, nomenclature fiscale du compte de resultat, references BOFiP, chacune avec URL, licence, frequence de mise a jour et date de dernier import.
- Les connecteurs metier (`integrations/qonto`, `integrations/stripe`) : recuperation automatique des transactions bancaires et des paiements.

Le harness d evaluation est le morceau le plus aboutu: `evals/` (Python) fait tourner chaque skill avec `claude-sonnet-4-6`, note avec `claude-haiku-4-5`, et compare avec un prompt de base, ce qui produit le delta affiche dans le badge du README (88% avec skill contre 75% sans, soit +13 points). C est une demonstration de valeur, pas une simple couverture de test.

## Etat reel

### Code

204 fichiers suivis. Repos Python minimal: `package.json` declare `paperasse` en version `1.1.0`, `private: true`, dependances `marked`, `pdf-lib`, `puppeteer`, `stripe`. La generation de PDF passe par `puppeteer`, donc un environnement de rendu est requis. `marketplace.json` declare le lot pour un registre de skills (slug, nom, chemin, description, integrations).

### Tests

Il n y a pas de repertoire de tests JavaScript. La couverture est de deux types:

- `scripts/test-deterministic-calculations.js`, lance par `npm run test:calc`, qui verifie les calculs de clôture et de liasse.
- `evals/tests/` en Python, plus le harness complet `run_evals.py` et `aggregate_benchmark.py`.

Ce qui manque: les tests deterministes ne sont pas relies a une CI qui les bloque, et il n y a aucun test unitaire sur les generateurs de PDF ou de FacturX, alors que ce sont les livrables que le client paie.

### CI

Un seul workflow, `.github/workflows/evals-smoke.yml`, declenche a la pull request: il identifie les skills modifies, prepare un environnement, lance les evals correspondants. C est une CI reelle et bien faite, mais qui ne couvre que les evals IA et pas les tests deterministes ni les scripts de generation.

### Deploiement et distribution

Le projet est distribue en markdown, donc "deploie" veut dire publie sur un registre de skills. Le snapshot lu montre une fiche publique sur `agentskill.sh` (`/skillsets/paperasse`) qui liste les skills un par un, avec un scan de securite et une auto-revue annonces par le registre. Sur npm, `paperasse` existe en version `0.0.1`, une coquille vide. Aucun service heberge, aucune API.

### Dernieres activites git

62 commits au total. Les derniers datent du 2026-04-20 (`fiscaliste: outils deterministes, examples, PAS, sources officielles`), le dernier push sur GitHub est du 2026-04-26. La creation du miroir date du 2026-04-26.

Comparaison avec l amont: le miroir est 0 commit en avance et 22 commits en retard sur `romainsimon/paperasse`. L amont est vivant (2546 etoiles, 197 forks, 34 issues ouvertes, dernier push le 2026-08-10), donc le miroir du workspace est une photographie d il y a six mois, en retard de tout le travail recent, y compris les mises a jour reglementaires (loi de finances, facturation electronique 2026). C est un point de vigilance majeur sur un produit dont la valeur est d etre a jour.

## Ce qu il faudrait pour en tirer du revenu

Le socle de competence est la, le canal de distribution est la, mais il n y a aucun euro. La monetisation naturelle se fait sur la promesse de conformite:

1. Un abonnement de mises a jour reglementaires. Les sources sont annuelles ou trimestrielles (PCG, nomenclature, BOFiP, e-reporting). Une fois le socle installe, le client a besoin de mises a jour garantiees. C est un revenu recurrent, faible par unite, mais defensible parce que la mise a jour est le vrai travail.
2. Une offre de conformite outillee: generation de FacturX signee, controle de liasse avant depot, journal des corrections. Le code deterministe existant est la matiere premiere, il faut le packaging et la garantie.
3. Une vente directe aux cabinets: un pack par profession (CAC, controle fiscal, syndic) avec les references et les modeles a jour, vendu a l unite ou en abonnement.
4. Un contrat de mise en place et de formation. Les skills sont techniques, la cible est non technique, la formation est donc facturable.
5. Ne pas faire du SaaS de gestion comptable. Concurrencer Qonto, Pennylane et Sage sur le logiciel est mort; se placer sur la competence metier, c est ce que le produit sait deja faire.

## Est-ce qu il merite un PM

Oui.

Les raisons: c est le projet du lot qui a le plus de traction verifiable (2546 etoiles sur l amont, fiche sur un registre de skills, harnais d evaluation qui chiffre un delta de +13 points). Il a un client identifiable et paie, il a un produit livre, il a une preuve de valeur mesuree. Ce qui manque n est pas de la reflexion produit mais de l exploitation commerciale: packaging, cible, prix, canal, mise a jour payante. C est exactement le travail d un PM.

Le PM a aussi une decision a prendre rapidement: le miroir du workspace est en retard de 22 commits sur un produit reglementaire. Il faut soit resynchroniser et traiter le depot comme un miroir consomme, soit assumer une divergence et la rendre explicite.
