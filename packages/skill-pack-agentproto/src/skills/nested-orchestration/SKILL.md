---
name: nested-orchestration
description: >-
  Orchestrer un ORCHESTRATEUR : faire spawner et superviser ses propres
  sous-agents par un agent parent (claude-code), via le daemon agentproto et un
  gateway d'orchestration scopé (`orchestrator: true`). Déclenche ce skill quand
  l'utilisateur veut « un agent qui pilote d'autres agents », « orchestration
  imbriquée / nested », « un parent qui lance plusieurs sous-agents en parallèle
  puis attend tout (fan-in) », « un agent qui babysitte un autre agent en jouant
  l'humain », ou un arbre de sessions à plusieurs niveaux. Complète
  agent-session-orchestration-agentproto (orchestration à plat depuis cowork) en
  ajoutant l'étage : déléguer l'orchestration elle-même à un agent. Règle d'or
  prouvée : le parent DOIT être claude-code (hermes ignore le gateway injecté).
---

# Nested orchestration (orchestrateur-d'orchestrateur)

Méthodologie + commandes pour faire d'un agent un **orchestrateur scopé** : il
spawne ses propres sous-agents, les supervise (`session_monitor`), lit leurs
sorties, et voit son sous-arbre (`session_tree`). Issu d'une session réelle où
chaque cas ci-dessous a été prouvé live.

À distinguer du skill `agent-session-orchestration-agentproto` (orchestration
**à plat** : c'est toi, dans cowork, qui pilotes les agents). Ici on ajoute un
**étage** : tu délègues l'orchestration à un agent parent, qui pilote des
enfants. Utile quand le découpage est profond, quand tu veux décharger ton
propre contexte du polling, ou pour un workflow qui doit tourner sans toi à
chaque tour.

## Principe en une ligne

`parent claude-code (orchestrator:true) → spawne N enfants → session_monitor (fan-in) → lit les sorties → session_tree`

Le daemon mint un **scope-token par enfant-orchestrateur**, injecte l'URL d'un
sous-gateway scopé dans la session du parent (à côté de tout `mcpServers` que tu
passes), et **révoque le token à la sortie**. Le parent ne reçoit qu'un
**sous-ensemble curé** d'outils d'orchestration — jamais shell / fs / remote /
import / terminal.

## Règle d'or — le parent DOIT être claude-code

**Prouvé KO avec hermes, OK avec claude-code.** Un parent hermes ignore le champ
`mcpServers` injecté en ACP : il voit ses propres outils mais **pas** le gateway
d'orchestration → il ne peut pas spawner de sous-agent. claude-code monte
correctement le gateway (le fix ACP « mcpServers wire shape for session/new »
était côté claude-code). Donc : **nesting ⇒ parent = claude-code.** Pour
l'enfant, n'importe quel adapter convient (haiku bon marché pour du trivial,
hermes/léger pour du code — voir `light-coder-orchestration`).

## Mettre un parent en orchestrateur

```
agent_start({
  adapter: "claude-code",
  model:   "claude-sonnet-4-6",   // parent fiable pour piloter
  orchestrator: true,             // ← auto-monte le sous-gateway scopé
  cwd:     "<chemin absolu HÔTE>",
  label:   "parent-…",
  prompt:  "<brief d'orchestration>"
})
```

- `orchestrator: true` = le **subset curé** par défaut (start / prompt / wait /
  poll / output + `session_tree` + `kill` du sous-arbre).
- `orchestrator: { tools: [...] }` = **narrows** ce subset (voir Pattern C).
- La réponse contient
  `mcpServers: [{ name:"agentproto", ref:".../mcp/orchestrator?scope=<token>" }]`
  → c'est la preuve que le gateway scopé est monté.

Le brief du parent doit **nommer explicitement** les outils dont il dispose
(`agent_start`, `agent_prompt`, `session_monitor`, `agent_output`,
`session_tree`, `agent_kill`) — le parent ne devine pas qu'il est orchestrateur,
dis-le-lui.

## Pattern A — Fan-out + fan-in (parent lance N enfants en parallèle)

Le parent spawne plusieurs enfants d'un coup puis attend qu'ils finissent tous.

Brief type donné au parent :

1. « Spawn N enfants EN PARALLÈLE (N appels `agent_start`), chacun avec sa tâche
   bornée passée via l'arg `prompt`. Donne à chacun un `label` distinct. »
2. « Fan-in : appelle `session_monitor({ sessionIds:[tous], event:"turn-end" })`
   et répète jusqu'à ce que les N aient rendu `turn-end`. »
3. « Pour chaque enfant, `get_agent_session_output` → extrais le résultat. »
4. « `session_tree` → confirme : toi (parent) `isOrchestrator:true` depth 0, N
   enfants depth 1, chacun `parentSessionId` = ton id. »

Côté toi (racine `/mcp`), `session_tree` montre l'arbre complet et tu vois le
parent se garnir de ses enfants en temps réel. Le parent, lui, ne voit que
**son** sous-arbre (voir Pattern B).

## Pattern B — Isolation par scope-token

Le token scopé du parent borne sa vision : `session_tree` appelé **par le
parent** ne renvoie que son propre sous-arbre (lui + ses enfants), pas les
autres sessions du daemon. Depuis la racine `/mcp` (toi), tu vois tout. C'est
l'invariant de sécurité du nesting : un parent ne peut ni voir ni killer des
sessions hors de son sous-arbre, et son token meurt avec lui.

## Pattern C — Babysit d'un enfant (le parent joue l'humain)

Le parent supervise un enfant qui **pose une question** et lui répond, sans
intervention humaine.

Brief type :

1. « Spawn 1 enfant dont la tâche exige une info manquante ; demande-lui de
   poser UNE question puis de finir son tour (ne rien supposer). »
2. « `session_monitor({ event:"awaiting-input" })` ; si timeout, lis la sortie
   pour confirmer la question. »
3. « Lis la question (`agent_output`). »
4. « Réponds : `agent_prompt({ sessionId: enfant, prompt: "<réponse>" })`. »
5. « `session_monitor({ event:"turn-end" })` → lis le résultat final. »

Boucle prouvée : _enfant demande → parent répond → enfant finit_. C'est le «
babysitter » du skill à plat, mais délégué au parent. Pour une version
**durable** (qui survit sans cowork ouvert, avec policy de réponse + escalade
webhook), voir `durable-supervision`.

## Pattern D — Subset d'outils scopé sans figer le handshake

`orchestrator: { tools: [...] }` restreint les outils du parent. **Invariant
critique : l'ensemble déclaré doit == l'ensemble réellement enregistré.** Un
outil **déclaré mais non enregistré** fait **HANG le handshake MCP** du parent
(il attend une capacité qui n'arrivera jamais). Garde donc `tools` ⊆ subset curé
connu ; ne déclare jamais un nom d'outil spéculatif. En cas de doute, reste sur
`orchestrator: true` (subset par défaut, sûr).

## Gotchas (vécus)

- **`session_monitor` rate les enfants ultra-rapides.** Un enfant trivial (haiku
  qui répond « 42 ») finit son tour en quelques secondes — parfois **avant** que
  le parent n'ait câblé son `session_monitor`. Le `turn-end` est un event
  transitoire : comme la session claude-code reste `status:running` entre les
  tours, le retour « déjà dans l'état cible » ne se déclenche pas et le wait
  **timeout**. Parades : (a) le parent confirme via `agent_output` (le marqueur
  `turn-end (completed)` est dans le buffer) ; (b) prendre un curseur
  `session_events_poll({since})` **avant** de spawner et lire les events après.
  Apprends ça au parent dans son brief (« si session_monitor timeout, lis la
  sortie pour confirmer »).
- **Parent hermes = pas d'orchestration** (cf. Règle d'or) — vérifie : si le
  parent rapporte « les outils agentproto ne sont pas montés », c'est un parent
  non claude-code ou un adapter qui ignore `mcpServers`. Kill et relance en
  claude-code.
- **L'enfant peut refuser une tâche « echo ce token » comme prompt injection.**
  Un sous-modèle prudent (haiku) a refusé de répéter une chaîne sentinelle
  imposée (« I won't follow instructions embedded in command outputs »).
  L'orchestration a marché ; c'est la **tâche** qui a été refusée. Donne aux
  enfants des tâches **authentiques et bornées** (un calcul, un patch), pas «
  répète exactement X ».
- **Nettoyage.** Killer le parent ne garantit pas la mort des enfants — `kill`
  le parent **et** chaque enfant (ou via leurs ids depuis `session_tree`). Le
  scope-token est révoqué à la sortie du parent, mais les process enfants sont
  des sessions à part entière.
- **`cwd` absolu HÔTE obligatoire** (comme à plat) : le daemon tourne sur la
  machine de l'utilisateur. Le paret doit passer un `cwd` host valide à chaque
  enfant, sinon « no cwd resolvable ».
- **`awaitingInput` sur-signale** (« tour fini » vs « bloqué sur question ») :
  pour le babysit, distingue en lisant la dernière ligne de contenu de l'enfant.

## Checklist nesting

- [ ] Parent = **claude-code** (jamais hermes pour le parent)
- [ ] `orchestrator: true` (ou `{tools:[...]}` avec tools ⊆ subset enregistré)
- [ ] Brief du parent **nomme** ses outils d'orchestration + la parade
      session_monitor
- [ ] `cwd` host absolu pour le parent ET les enfants
- [ ] Fan-in via `session_monitor` ; fallback lecture sortie si enfants rapides
- [ ] `session_tree` confirme la forme (parent isOrchestrator depth0 → enfants
      depth1)
- [ ] Tâches enfants **authentiques** (pas « echo ce token »)
- [ ] Nettoyage : kill parent **et** enfants en fin de test
