# t9 lot 11: rapports

Analyse des projets sans PM, lot 11. Lecture seule: code, `package.json`, tests et CI. Aucun build, aucune installation.

## Perimetre et limites de la session

Le clone local du workspace attendu (`projects/agentik-studio/projects/<nom>`) n existe pas dans le bac a sable de cette session: `/home/user/projects` et `/home/user/workspace` sont vides, et aucune copie de l arborescence `agentik-studio` n est presente sur la machine. Le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces a l ecriture comme a la lecture de l API). La liste nominative des projets du lot n a donc pas pu etre lue a la source.

Ce qui a ete fait a la place: chaque projet du lot a ete identifie par son depot miroir public dans l organisation `agentiknet`, qui est l unique trace accessible de l arborescence `agentik-studio`. Les six depots ci-dessous ont ete clones en lecture seule, sans build ni installation, puis compares a leur amont pour mesurer l ecart. Chaque analyse detaillee est dans un fichier dedie:

| Projet | Fichier | Nature du depot |
| --- | --- | --- |
| ostack | `ostack.md` | fork de `mr-daedalium/ostack-saas`, lui-meme fork de `garrytan/gstack` |
| paperasse | `paperasse.md` | fork de `romainsimon/paperasse` |
| openscreen | `openscreen.md` | fork de `siddharthvaddem/openscreen` (amont archive) |
| camofox-browser | `camofox-browser.md` | fork de `jo-inc/camofox-browser` |
| arkor | `arkor.md` | fork de `arkorlab/fine-tuning` |
| rendez-vous | `rendez-vous.md` | depot original, pas un fork |

Les projets deja traites par les lots 8 et 9 (agentcart, guilde, openagentik, agencies, agent-books, agentik-branding, hackatons) ne sont pas repris ici.

## ostack

- A quoi il sert: une equipe d ingenierie IA pour Claude Code, sous forme de 28 skills (planification, revue, QA, livraison, retrospectives), avec un moteur navigateur Playwright integre et un patron de dossier `company/` conforme a `agentcompanies/v1`. C est la brique la plus interesting du lot: elle est deja montee sur le standard `agentcompanies/v1`, qui est aussi le standard retenu dans le lot 9.
- Etat reel: 251 fichiers, 34 fichiers de test (bun test, avec separation `test:fast` et tests evals IA exclus de la suite par defaut), version 0.1.0, aucun workflow CI, aucun paquet npm. 52 commits, dont 48 en mars 2026, dernier push le 2026-04-15. Le miroir est 4 commits en avance de l amont fige, et l amont de l amont est gratuit.
- Pour en tirer du revenu: un service heberge qui execute la boucle de skills sur le code du client, plus un hote de navigateur `browse/` facture au volume, plus une verticalisation precise. La valeur est dans le contenu editorial des skills et dans la distribution, pas dans le code.
- PM: non. Miroir d un projet amont gratuit et fige, aucune chaine de livraison, six mois d inactivite, et rien a arbitrer avant la decision de reprise. Le oui revient si `company/` devient un produit a part, c est a dire si le standard `agentcompanies/v1` devient l objet a faire adopter.

## paperasse

- A quoi il sert: six skills markdown pour agents IA specialises dans la bureaucratie francaise (comptable, controleur fiscal, CAC, notaire, syndic, fiscaliste), avec scripts de calcul deterministes, donnees reglementaires tracees (PCG 2026, nomenclature de liasse, BOFiP), connecteurs Qonto et Stripe, et un harness d evaluation qui mesure un delta de +13 points avec skill contre sans.
- Etat reel: 204 fichiers, tests deterministes en JavaScript et evals en Python, une seule CI (`evals-smoke.yml`) qui ne couvre ni les scripts de generation PDF et FacturX ni les tests deterministes. Distribution existante sur le registre `agentskill.sh`, paquet npm `paperasse` a l etat de coquille. 62 commits, dernier push le 2026-04-26, et surtout 22 commits en retard sur l amont `romainsimon/paperasse` (2546 etoiles, vivant), alors que le produit porte sur des textes qui changent chaque annee.
- Pour en tirer du revenu: un abonnement de mises a jour reglementaires, une offre de conformite outillee (FacturX signe, controle de liasse avant depot, journal des corrections), des packs par profession, et de la formation. La competence est deja la, il manque le packaging et le canal.
- PM: oui. C est le projet du lot qui a le plus de traction verifiable, un client qui paie, un produit livre et une preuve de valeur mesuree. Il manque de l exploitation commerciale, pas de la reflexion produit. Decision a prendre vite: resynchroniser ou assumer la divergence.

## openscreen

- A quoi il sert: un enregistreur d ecran libre, alternative a Screen Studio, en application Electron, distribue par winget, AUR, Homebrew et Nix. L apport propre du miroir est `scripts/studio/`, qui transforme une session agent (clics, captures) en projet `.openscreen` deterministe, puis en video finie via ffmpeg ou via l editeur pilote en headless.
- Etat reel: 536 fichiers, 46 fichiers de test (vitest, Playwright, Testing Library), 14 workflows CI dont lint, typecheck, tests unitaires et navigateur, build, et toute la chaine de distribution. 699 commits, dernier push le 2026-07-10. Aucun tag ni release dans le miroir, et 100 commits de retard sur `getopenscreen/openscreen`, la continuite active du projet depuis l archivage de l original.
- Pour en tirer du revenu: un service heberge de generation de demos a partir de sessions agent, ou une prestation de production de demos pour les equipes produit. Interdit de monetiser l application elle-meme, le projet l assume explicitement.
- PM: non pour le miroir, qui est une copie de travail sans release et sans monetisation possible. Oui pour une decision a prendre: le module studio est la seule piece propre du lot et elle merite un arbitrage (service, prestation ou licence).

## camofox-browser

- A quoi il sert: un serveur REST de navigation anti-detection pour agents, base sur Camoufox, avec snapshots d accessibilite compacts, references d elements stables, macros, import de cookies, metriques et plugin OpenClaw. C est de l infrastructure agentique, deja consommee par `agentproto/ts` via `adapters/browser-camofox`.
- Etat reel: 61 fichiers, 27 fichiers de test Jest (unit, e2e, live), aucun workflow CI dans le miroir, version 1.5.2, 103 commits dont l essentiel en fevrier et mars 2026, dernier push le 2026-06-02, 15 commits en retard sur un amont qui a 11 800 etoiles et 92 000 telechargements npm par mois. La demande est chez l amont, pas dans le miroir.
- Pour en tirer du revenu: de l hebergement de navigateur pour agents facture au volume, en particuliers parce que le runtime sait deja le piloter, et une edition entreprise avec isolation, journal d audit et absence de telemetrie sortante. La monétisation de l amont passe par son propre produit, donc la valeur du serveur est capturee ailleurs.
- PM: non pour le miroir, dont la seule question est la synchronisation avec l amont. Le PM devient pertinent si l on decide de vendre de l hebergement de navigateur, car la decision porte alors sur le packaging, le prix, le SLA et la conformite.

## arkor

- A quoi il sert: un SDK TypeScript pour le fine-tuning de modeles ouverts, avec CLI, Studio local et API de jobs sur GPU heberge (SSE pour les checkpoints, callbacks typees, authentification Auth0), plus trois recettes LoRA sur Gemma.
- Etat reel: monorepo Turborepo de 4 paquets, 321 fichiers, 63 fichiers de test colocalises, 5 workflows CI dont un garde-fou de style et une publication npm avec provenance. SDK publie en alpha (`arkor` 0.0.3-alpha.1) avec environ 123 telechargements par mois. Le miroir date d aout 2026 et a diverger de l amont (117 commits en avance, 283 en retard). Decisif: l amont annonce que le service `arkor.ai` est arrete et que le framework n est plus maintenu.
- Pour en tirer du revenu: soit relancer un service de fine-tuning heberge, mais le marche est bruyant et le produit n aura pas d avantage; soit se replier sur le fine-tuning local et souverain en remplacant le backend cloud, le Studio et les schemas servant alors de facade; soit accepter que la valeur restante est pedagogique.
- PM: non pour l instant. Le service est arrete et le miroir est en alpha, la decision structurante (relancer ou se replier) est un arbitrage de direction. Le sujet a traiter en priorite est l hygiene: ne pas laisser un paquet publie et un miroir actif d un service arrete.

## rendez-vous

- A quoi il sert: une salle partagee ou plusieurs personnes, depuis WhatsApp, Telegram, SMS, email ou web, pilotent un seul agent et une seule conversation, avec des chuchotements confines et un mode bac a sable cloud. Le projet est une surcouche sur `agentpush` et sur `agentproto` utilise non modifie.
- Etat reel: 249 fichiers dont 66 sources et 79 fichiers de test (79 fichiers, environ 500 tests annonces), mais aucun workflow CI, donc rien ne garantit que la suite passe au commit. Aucun deploiement, `private: true`, aucune version publiee. 54 commits du 2026-09-12 au 2026-09-16: cinq jours de travail, dans le cadre d un hackathon, avec un dossier de soumission complet (pitch, storyboard, PDF, deux revues externes).
- Pour en tirer du revenu: un service heberge de salles partagees facture par salle et par participant, ou une integration en marque blanche dans agentproto, ou une position sur la confidentialite des conversations multi-participants. Le document `COMPETITIVE.md` montre que l equipe a deja cadre le sujet face a l Agents API d OpenAI.
- PM: pas de suite. C est une piece de concours, sans utilisateur ni revenu, dans un sujet ou la reference (sessions durables d OpenAI) est plus recente que le projet. La decision a prendre est un choix de produit radical et unique: integrer dans agentproto ou service autonome. Si ce choix est fait, un PM a alors un vrai sujet.

## Synthese

| Projet | PM | Verdict en une ligne |
| --- | --- | --- |
| ostack | non | miroir gratuit et fige, mais brique `company/` a garder |
| paperasse | oui | la competence est la, la traction est la, il manque le packaging |
| openscreen | non (oui pour le module studio) | copie de travail sans release, monetisation impossible sur l application |
| camofox-browser | non | demande chez l amont, usage deja couvert par agentproto |
| arkor | non | service arrete en amont, hygiene avant tout |
| rendez-vous | pas de suite | sujet bon, fenetre courte, mais piece de concours sans utilisateur |

Deux points transverses: cinq des six projets sont des forks maintenus en l etat, sans version ni release, ce qui veut dire que la vraie question pour eux est la synchronisation avec l amont et non la conduite du produit. Et le seul projet qui a un PM franchement justifié est aussi le seul dont le miroir est le plus en retard sur un produit reglementaire: c est le meme probleme vu de deux angles.
