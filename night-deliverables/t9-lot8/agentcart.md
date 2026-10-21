# agentcart

## Périmètre de lecture

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/agentcart`) n'était pas présent dans le conteneur d'exécution: ni `/home/user/projects`, ni aucune copie de l'arborescence `agentik-studio` n'existent sur la machine, et le dépôt GitHub du produit est privé pour le jeton d'accès de la session. Aucun code AgentCart n'est donc lisible ici. L'analyse a été reconstruite sur les sources publiques: le site `agentcart.io` (actuellement en pause), la documentation produit `docs.agentcart.io`, le dépôt public de la documentation (`Bar-Dov/agentcart-docs`), la spec ouverte Universal Commerce Protocol, et les snapshots web.archive. Aucun build et aucune installation n'ont été lancés.

## À quoi il sert

AgentCart est une couche de commerce agentique: elle rend une boutique e-commerce lisible et achetable par des agents IA (ChatGPT, Perplexity, Google AI Mode, et tout agent parlant le protocole Universal Commerce Protocol). L'agent ne dialogue plus avec un site web, il interroge un manifeste machine et passe commande via des endpoints structurés.

Le cycle marchand tient en quatre étapes documentées:

1. Scan: l'agent parcourt le catalogue et évalue la qualité des données produit (titres, descriptions, images, prix, données structurées) pour un usage par IA.
2. Score: deux notes sur 100, le score brut sur les données existantes et le score AgentCart après enrichissement, ventilées par catégorie (descriptions, données structurées, état du checkout).
3. Connect: le marchand pose une redirection de `/.well-known/ucp` vers le manifeste hébergé par AgentCart, qui expose deux services, `dev.ucp.shopping` en REST 1.0 et `dev.ucp.shopping.mcp` en MCP 1.0, plus les capacités `checkout` et `catalog`.
4. Analyze: suivi des visites par plateforme IA, produits demandés, sessions de checkout démarrées, taux de conversion.

Cibles plateformes: Shopify pleinement supporté, WooCommerce via un plugin WordPress, Magento annoncé, headless sur la roadmap.

Côté développeur, l'API est un hôte UCP hosted: manifeste en `GET /api/ucp/{slug}`, recherche et lecture de catalogue en proxy vers l'Admin API Shopify, création de session de checkout avec en-tête `Idempotency-Key`, totaux en centimes (champ `currency` en ISO 4217) et un flux de paiement par redirection vers le checkout Shopify, puis `POST /checkout-sessions/{id}/complete`. Un endpoint MCP JSON-RPC 2.0 est exposé en parallèle du REST.

## État réel

Code: illisible dans cet environnement (dépôt produit privé, clone local absent). Le seul code public est la documentation, en MDX dans un site Nextra (`Bar-Dov/agentcart-docs`, 2 commits, dernier push le 2026-05-30, langage MDX).

Tests et CI: rien de public. Aucun workflow GitHub Actions visible, aucun paquet npm publié, aucun release. La documentation est datée page par page: "Last updated on May 30, 2026" pour l'introduction, "April 11, 2026" pour les pages développeur et marchand. Il n'y a donc aucune preuve de couverture de test ou de chaîne de livraison sur le code produit.

Déploiement: l'infrastructure était réelle et multi-tenant. L'hébergement est en `app.agentcart.io`, avec un slug UCP par marchand, un point d'entrée MCP par boutique, et un tunnel vers le site marchand. Mais l'état du produit aujourd'hui est explicite: la page d'accueil de `www.agentcart.io` affiche "This project is currently paused. Thanks for your interest, check back later." Le service a donc été mis en pause, et la documentation de juin 2026 n'a pas été suivie d'une reprise.

Dernières activités git: sur le dépôt de documentation, dernier push le 2026-05-30. Aucune activité publique du produit depuis. Le contexte fautif est celui du standard: UCP est un standard ouvert (`Universal-Commerce-Protocol/ucp`), avec un dépôt de spécification mis à jour le 2026-10-20 et un dépôt d'exemples mis à jour le 2026-10-21, et déjà plusieurs implémentations de référence chez des tiers (par exemple un blueprint NVIDIA AI retail et une app de chat storefront Shopify).

## Ce qu'il faudrait pour en tirer du revenu

Aucune source de revenu n'est active: produit en pause, pas de pricing public, pas de boutique vendable. Pour repartir, dans cet ordre:

1. Une décision explicite de reprise ou d'arrêt. Tant que le site dit "paused", toute prospection se fait au rabais. Si la reprise est décidée, le premier geste visible est de remettre le statut en ligne et de fixer un pricing.
2. Une monétisation par boutique, pas par code. Le modèle naturel est un abonnement par magasin connecté, plus une part sur le volume de sessions de checkout initiées par des agents, ce qui aligne le revenu sur la valeur créée. L'alternative est l'agence: revendre l'installation et l'optimisation de catalogue aux agences qui gèrent plusieurs boutiques.
3. Un différentiel face à la commoditisation du protocole. UCP est ouvert, donc l'implémentation de référence se fait en interne ou par des tiers. La valeur ne peut pas rester dans l'implémentation: elle doit être dans le réseau (nombre de boutiques connectées), dans les données agrégées de trafic agentique et dans le scoring de préparation IA, qui sont des données propriétaires difficiles à répliquer.
4. Un plug-in distribution propre. Le plugin WordPress et l'app Shopify sont les points d'entrée du produit: ils doivent être publiés dans les places de marché officielles avec de bons avis, faute de quoi les marchands n'installent rien.
5. Un sujet de conformité à traiter en amont. Le canal agent-to-merchant et les paiements agentiques convergent vers des obligations de traçabilité et d'auditabilité, ce qui est un argument de vente B2B et une charge technique à budgéter.

## Verdict PM

Non, pas de PM d'exécution à ce stade. Le produit est en pause depuis environ cinq mois, le code n'est pas observable ici, et la techno de base qu'il implémente est un standard public que d'autres implémentent déjà. Ce qui manque n'est pas un PM d'exécution mais une décision d'investissement courte: deux ou trois semaines de cadrage (reprise ou abandon, positionnement par rapport à UCP et à ses implémentations, coût d'acquisition) et une réponse binaire. Un PM d'exécution aujourd'hui serait une façon dispendieuse de valider une idée qui n'a plus de traction. Le PM redevient pertinent si la reprise est arbitrée, car il faudra alors structurer le pricing, le plug-in distribution et le programme partenaires.
