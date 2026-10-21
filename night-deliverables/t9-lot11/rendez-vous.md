# rendez-vous

## Perimetre et limites

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/rendez-vous`) n existe pas dans le bac a sable de la session, et le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces). Aucun fichier du projet n a donc pu etre lu.

Ce que j analyse est le depot public `agentiknet/rendez-vous`, seul depot du lot qui ne soit pas un fork. Aucun build et aucune installation n ont ete lances.

## A quoi il sert

rendez-vous est une salle partagee: plusieurs personnes, plusieurs agents, une seule conversation agentique, chacun depuis l application qu il a deja sous la main (Telegram, WhatsApp, SMS, email, web). Rien a installer, on rejoint par un message.

La commande utilisateur tient en cinq verbes: `new` cree une salle adossee a son propre agent local, `new sb` cree une salle adossee a un bac a sable cloud, `join RDV-7F3K` entre dans une salle, `resume` revient le lendemain avec l etat intact, `leave` sort.

Le produit est la salle elle-meme, et les documentations le disent: un agent qui voit tous les fils peut faire ce qu un chatbot dans une poche ne peut pas faire, spotter le conflit entre deux personnes qui ne se parlent jamais, le nommer devant les deux et arbitrer jusqu a convergence. Deux mecanismes de confidentialite sont documentes: le chuchotement (un message ne voit qu un membre, les autres sont informes qu il y a eu un chuchotement) et les questions dirigees (l agent demande a qui s informer).

L architecture est explicitement une surcouche sur deux runtimes libres: `agentpush` pour unifier la messagerie (Telegram, WhatsApp, email) et `agentproto`, utilise non modifie depuis npm, pour orchestrer les agents et leurs bac a sables. Le modele de raisonnement est un modèle de codage via OpenRouter, la voix et la vision via OpenAI, les machines via e2b.

## Etat reel

### Code

249 fichiers suivis: 66 dans `src/`, 79 dans `test/`, un dossier `apps/room-artifact`, un dossier `scripts/` de 14 scripts de preuve (sandbox, codex, queue, agentpush, media), et 30 documents dans `docs/`.

Le code source est structure par responsibility: `src/fanin` (entrees des participants, ordonnees), `src/fanout` (rendu par surface), `src/audience` (chuchotements et questions), `src/channels` (Telegram, WhatsApp, email, SMS, web), `src/rooms` (cycle de vie et booter par salle), `src/daemon`, `src/sandbox` (e2b), `src/media`, `src/links`, `src/service`, `src/web`.

Le dossier `deck/` est un dossier de soumission: `SCRIPT.md`, `STORYBOARD.md`, `SUBMISSION.md`, deux revues (`REVIEW-fable.md`, `REVIEW-glm.md`), un `rendez-vous.pdf` et un `rendez-vous.canvakit.html`. C est la trace que le projet a ete construit pour un concours.

### Tests

79 fichiers de test dans `test/`, mirroring des modules source, lances par `node --test 'test/**/*.test.ts'`. Le volume est important: la documentation de soumission revendique "500 green tests". La couverture parait serieuse sur le coeur de logique (fan-in, fan-out, audience, rooms, sandbox, service, web).

### CI

Aucun workflow GitHub Actions. Avec 79 fichiers de test et 500 tests annonces, l absence de CI est le principal manque du projet: rien ne garantit que la suite passe au moment du commit, et rien ne la fait tourner en integration continue.

### Deploiement

Aucun. `package.json` est `private: true`, aucune version publiee, aucun conteneur, aucun service heberge. Le projet ne tourne que sur la machine du developpeur, avec son agent local ou un bac a sable e2b, et depend de cles API (OpenRouter, OpenAI, e2b, les canaux de messagerie).

La documentation contient toute une logistique de demonstration (`DEMO-PLAN-2MIN.md`, `DEMO-USECASE-2MIN.md`, `REHEARSAL.md`, `RUNBOOK.md`) et un `docs/DEPENDENCIES.md` qui liste les services externes. C est un projet pilote par desdemonstrations, pas par des utilisateurs.

### Dernieres activites git

54 commits, tous entre le 2026-09-12 et le 2026-09-16. Creation du depot le 2026-09-12, dernier push le 2026-09-16. C est cinq jours de travail, et le projet n a pas bouge depuis. La documentation de soumission dit explicitement que le service de rooms, le multimodal et le flip codex ont ete construit pendant le hackathon, sur un runtime agentproto qui avait deja envoye sept pull requests en amont.

## Ce qu il faut pour en tirer du revenu

Il n y a aucun revenu et aucune base d utilisateurs. Le projet est une piece de concours. Les pistes, dans l ordre de realisme:

1. Un service heberge de salles partagees. On paie par salle active et par participant. La valeur est immediate pour les equipes qui travaillent en silo d outils et qui doivent arbitrer entre plusieurs personnes. Le cout de revient est un agent qui tourne et un bac a sable.
2. Une integration en marque blanche dans les outils existants. Le produit de base `agentproto` a deja la notion de session, de routage et de boite a outils numerique. Une salle multi-participants est une evolution naturelle du runtime, donc le meilleur business model est peut-etre de l integrer dans agentproto plutôt que de le vendre a part.
3. Une position sur la communication confidentielle dans l era des agents. La question "qui voit quoi dans une conversation multi-participants" est un vrai sujet, de la meme famille que la confidentialite dans les groupes de messagerie. C est un argumentaire B2B solide.
4. Une lecture competitive a faire avant toute chose: `docs/COMPETITIVE.md` montre que l equipe a etudie l Agents API d OpenAI (sortie en beta le 2026-09-10, avec sessions durables, artefacts et environment templates). Le document note justement que leur artefact est une URL de telechargement et le nôtre une URL vivante, et qu il faut copier leur "environment template". C est une reflexion saine: le projet est dans le bon sujet et dans la bonne fenetre.

## Est-ce qu il merite un PM

Pas de suite, et la raison est claire: le projet a ete ecrit pour un jury. Il n y a pas d utilisateur, pas de demande explicite, pas de revenu, et la competition de reference (les sessions durables de l Agents API d OpenAI) est plus recente que le projet lui-meme. Un PM nomme maintenant aurait un produit a red definir avant d avoir quoi que ce soit a piloter.

Ce qui est vrai, en revanche, c est que le sujet est bon et que la fenetre est courte. Si l on veut que rendez-vous survive au hackathon, la decision a prendre est un choix de produit radical: soit l integrer comme capacite de session multi-participants dans agentproto, soit en faire un service heberge autonome. Ce choix se prend une fois, vite, et il ne demande pas un PM permanent, mais un arbitrage clair.

## Sources

- `agentiknet/rendezvous` (lu), metadonnees GitHub via l API
- `docs/ARCHITECTURE.md`, `docs/COMPETITIVE.md`, `deck/SUBMISSION.md` du depot
