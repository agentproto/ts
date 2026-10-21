# agentik-branding

Perimetre et limites de cette analyse : le clone local du workspace (`projects/agentik-studio/projects/agentik-branding`) n existe pas dans le bac a sable de cette session, et le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces). Les elements ci-dessous viennent des artefacts publics qui referment explicitement ce projet, notamment les deux fichiers de design kit dont le commentaire indique "source of truth: projects/agentik-branding/README.md".

## A quoi il sert

Le projet porte la marque Agentik et sa chaine de production : les fichiers sources de la marque (logos, icones, wordmarks, versions transparentes) et les "design kits" qui les met en forme pour le rendu.

Il y a deux couches distinctes :

- la couche de marque, en images : un logo horizontal avec barre oblique, une icone en boite, une icone pleine, un wordmark, plus les declinaisons sur fond blanc, bleu et marine ;
- la couche de regles, en markdown : deux design kits, `agentik.md` et `agentik-dark.md`, au format du registre designkit. Ils portent la palette, la typo, les surfaces, les bordures, les couleurs semantiques et les chemins des images de logo.

Ce sont ces design kits qui sont consommes par canvakit, via l'option `--design kit:agentik` ou `--design kit:agentik-dark`, au moment de l export PDF ou HTML d une presentation.

## Etat reel

### Code

Il n y a pas de code a proprement parler. Le projet est un magasin d assets plus deux fichiers de configuration.

La palette de reference, telle qu elle est reprise dans le design kit sombre :

| Token | Valeur | Usage |
| --- | --- | --- |
| `brand-blue` | `#5586C8` | accent principal, fond d icone |
| `brand-navy` | `#0A2447` | fond, encre, hero |
| `brand-white` | `#FFFFFF` | encre sur fond sombre |

Surfaces sombres derivees : `background #0A2447`, `surface #123057`, `surface-raised #1B3B66`, `scrim rgba(0,0,0,0.55)`. Encre : `#FFFFFF`, `ink-muted #A9BDD6`, `ink-faint #6C84A3`. Accent clair `#7FA9DC`. Semantique : succes `#2F9E6E`, warning `#D9932B`, danger `#D1483C`, info `#7FA9DC`. Typo : Poppins en display et en corps de texte, le design kit le qualifiant de "premier vrai designkit" du registre.

Les chemins de logo dans le design kit pointent vers `projects/agentik-branding/logo/`, `.../icon/` et `.../transparent/`, ce qui confirme la structure du dossier de travail : un README.md qui fait foi, et trois dossiers d images.

### Tests

Il n y en a pas, et il ne peut pas y en avoir de naturels : ce sont des images et du frontmatter. Aucun controle automatique de contraste, de taille minimale, de resolution, ni de coherence des declinaisons. La seule verification est visuelle, faite a la lecture des exports. C est acceptable tant que la marque reste un support de communication interne, et ca devient un risque des que des tiers l utilisent.

### Deploiement

Aucun deploiement propre. Les assets sont versionnes dans les depots, les design kits voyagent avec les depots qui les referment (ils sont copies en local dans `deck/_design/` chez rendez-vous, precisement parce que les references `kit:` se resolvent relativement au repertoire courant). Le rendu est produit a la demande par canvakit.

A noter : le registre de design kits `designkit-sh`, cite comme standard dans l ecosysteme, ne renvoie aucun depot accessible, et le repo `canvakit/canvakit` (public) s est arrete a un unique commit le 2026-04-25, "init canvakit, export from agentik-studio monorepo". Donc le moteur de rendu des kits est publie mais peu vivant, et l illustration de reference du kit est restee dans un repo de produit.

### Dernieres activites git

Le design kit Agentik a ete pousse le 2026-09-12 dans `agentiknet/rendez-vous`, au moment de l ajout du pitch deck (6 pages plus 2 pages en annexe, exports PDF clair et sombre, script de passage a l oral, critiques independantes). C est la seule trace de modification datee que j ai pu rattacher a la marque Agentik.

A cote, une autre marque existe et vit dans `agentiknet/agentproto` : dossier `brand/` avec logos clair, sombre et vert, wordmarks, lockups, un `design.md` verrouille le 2026-08-07, et une galerie HTML de variations. Sa palette est differente (ink `#1b1b1c`, paper `#f4f0e6`, phosphor `#2f9e63`) et sa typo est IBM Plex Mono. Le `design.md` y signale une dette explicite non soldee : `wordmark.svg` et `lockup.svg` dessinent encore leur texte dans la pile systeme et non dans Plex, a corriger avant conversion en contours pour l artefact final.

Conclusion d activite : la marque est un actif fige, avec une dette connue et non traitee.

## Ce qu il faudrait pour en tirer du revenu

En l etat, la marque ne rapporte rien et ne peut pas rapporter seule. Elle est un cout, pas un actif. Les pistes reelles sont ailleurs :

1. Vendre la marque comme un service de white-label pour le catalogue d agences. Chaque agence du catalogue (paperasse, ostack, et demain d autres) a besoin de son propre kit, derivé du kit Agentik, avec son nom, ses couleurs et son ton. C est du revenu recurrent et rationnel si le kit est livre comme un design kit parametrable dans canvakit, pas comme des fichiers envoyes a la main.
2. Publier les design kits dans un registre avec licence et prix (l equivalent du registre designkit cite dans l ecosysteme). Un kit vendu ou sous licence a un usage commercial, avec une facture et une gestion de version. Cela suppose une licence explicite, ce qui n existe pas aujourd ou : les fichiers sont libres et sans restriction ecrite.
3. Vendre la production d assets comme un service : deck, landing page, icones, declinaisons, adaptes au canal. La chaine existe deja (canvakit, export PDF), il manque l offre et le prix.
4. Montrer que la coherence de marque se vend : un kit applique a un produit qui sort du lot. Sans ca, la marque reste un centre de cout.

Le point le plus rentable a court terme est le numero 1, parce que la demande existe deja dans le catalogue et que la marginalite est bonne si le kit est parametrique.

## Merite-t-il un PM

Non.

Pourquoi non : le projet n a ni utilisateur, ni revenu, ni evenement a gerer, ni dependance a arbitrer. C est une bibliotheque d assets avec un README qui fait foi et une dette de production (les SVG non outlines, l absence de controle de contraste, la duplication entre la marque Agentik et la marque agentproto). Un PM n y aurait rien a deciding, et le budget horaire irait ailleurs.

Ce dont le projet a besoin, c est d un responsable de marque (designer) qui tient la source de verite, d une chaine d export reproductible et d une decision de licence. Deux demi-journees de travail, pas un poste.

Exception a reexaminer : si les design kits deviennent un produit distribue (registre, kits payants, white-label en marque blanche), alors la question redevient un sujet de packaging et de tarification, et la reponse peut changer. Pour l instant, non.

## Sources reellement lues

- `agentiknet/rendez-vous` (public) : `deck/_design/agentik.md` et `deck/_design/agentik-dark.md` (contenu complet, palette, chemins des assets), `deck/README.md` (usage de canvakit et commandes d export), arborescence de `deck/`, commit du 2026-09-12 sur `deck/_design`
- `agentiknet/agentproto` (public) : dossier `brand/` complet (liste des fichiers, `design.md` verrouille, dettes ouvertes)
- `canvakit/canvakit` (public) : arborescence (apps/cli, apps/web avec Dockerfile et cloudbuild, packages core et export), unique commit du 2026-04-25
- `openagentik/stack` (public) : mention du standard designkit et du registre designkit-sh

## Limites

Les images elles-memes (logo/, icon/, transparent/) n ont pas pu etre inspectees : ni le dossier de travail, ni un depot public du projet. Je connais leur emplacement, leur nommage et leur role depuis les references des design kits, pas leur qualite reelle, ni leur exhaustivite, ni leurs dates. Le README du projet, qui fait foi sur la palette, n a pas pu etre lu non plus.
