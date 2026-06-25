---
name: durable-supervision
description: >-
  Superviser des agents de façon DURABLE via le moteur de policies in-daemon
  d'agentproto : attacher une policy de complétion à une session (ou un groupe
  fan-in), faire tourner un gate (shell ou judge-agent) au turn-end, émettre
  policy:passed/failed sur le bus d'events, et conditionner un commit hôte à un
  gate vert avec ack humain (commit-ready → ack → committed). Déclenche ce skill
  quand l'utilisateur veut « un gate vert comme condition de commit », « attacher
  une policy à un agent », « committer automatiquement quand les tests passent »,
  « escalader à l'humain seulement si bloqué », « une supervision qui survit sans
  cowork ouvert », ou parler de RoutineRunner / webhook notifyUrl / judge-gate.
  Complète nested-orchestration (qui pilote la TOPOLOGIE des agents) en ajoutant
  la COUCHE DE GOUVERNANCE durable au-dessus des sessions.
---

# Durable supervision (moteur de policies in-daemon)

Le superviseur durable ne vit pas dans cowork (qui dépend de l'app ouverte) mais
**dans le daemon agentproto**. Il s'abonne aux events de session
(`turn-end`/`awaiting-input`/`exited`), exécute un **gate** à la fin d'un tour, et
émet le résultat sur un **bus d'events** que tu lis sans polling tokenivore. C'est
la couche de gouvernance au-dessus des sessions ; la topologie (qui spawne qui)
relève de `nested-orchestration`, l'exécution-modèle de `light-coder-orchestration`.

Tout ce qui suit a été **prouvé live** sauf les sections explicitement marquées
« source » (code-complet + tests unitaires, mais pas ré-exécuté ici).

## Principe en une ligne

`session → (turn-end) → gate (shell|judge) → policy:passed|failed → [then: emit | commit (ack humain) → policy:committed]`

## 1. Attacher une policy à une session

```
attach_policy({
  sessionId: "sess_xxx",        // OU sessionIds:[...] pour un groupe fan-in
  then: "emit",                  // "emit" → policy:passed/failed ; "commit" → stage+commit
  gate: { command, args?, cwd?, timeoutMs? },   // shell : exit 0 = pass
  onFail?: { nudge?, maxRetries? },             // re-prompt N fois puis blocked
  next?: <policy>                                // DAG : chaîne une policy au done (source)
})
```

- **Cycle de vie** prouvé : `watching` → (turn-end) `gating` → `done` (vert) /
  `blocked` (rouge, pas de retry restant) / `awaiting-ack` (commit). Lis-le via
  `get_policy_status({policyId})` ; inventaire via `list_policies()`.
- Le gate tourne **après le `turn-end`** de la session surveillée. **Attache la
  policy AVANT que la session ne finisse son tour** (spawn idle → attach → prompt),
  sinon tu cours le même risque de race que `wait_for_any` (l'event transitoire
  peut être manqué).
- **Gate absent** → la policy passe immédiatement au turn-end (utile pour juste
  jalonner une complétion sur le bus).

## 2. Le gate (shell) — deux invariants vécus

Le gate shell est `{ command, args?, cwd?, timeoutMs? }`, exit 0 = pass. **Deux
pièges prouvés en live** :

1. **Allowlist.** Le gate passe par la même allowlist que `execute_command`
   (`<workspace>/.agentproto/allowed-commands.json`, default-deny). Un gate
   `test -f x` a échoué avec `gate command 'test' not in allowlist` → policy
   `blocked`. Utilise un binaire allowlisté (`ls`, `cat`, `git`, `node`, `pnpm`,
   `npm`, `npx`, `gh`, `echo`, `bash`…). Pour « le fichier existe ? » → `ls <fichier>`
   (pas `test -f`). Pour un gate de tests → `pnpm`/`npm`/`node` selon le projet.
2. **cwd ancré au workspace.** La cwd du gate **défaute sur la cwd de la session
   surveillée**, mais elle est **ancrée au workspace** : une session dont la cwd
   est HORS du workspace fait échouer le gate avec `cwd escapes the workspace`.
   Parade : lance la session surveillée **dans le workspace**, ou passe une
   `gate.cwd` workspace-relative explicite (ex. `"."` ou `"sous/dossier"`).

Gate vert prouvé : `policy:passed`, status `done`, `lastGate.exitCode:0`.

## 3. Gate judge-agent (source — WP7)

À la place d'un shell, `gate: { judge: { adapter, model?, prompt, timeoutMs? } }`
spawne un agent LLM court qui juge la sortie de la session surveillée et finit par
`VERDICT: PASS|FAIL` (dernière occurrence, insensible à la casse). **Fail-safe** :
timeout ou réponse non parsable = FAIL. Le juge est **toujours killé** quand le
gate se résout, et il occupe un slot de concurrence pendant qu'il tourne. Utile
pour un critère qualitatif (« le diff respecte-t-il le style ? ») qu'aucun exit
code ne capture.

## 4. Gate vert comme condition de commit (prouvé end-to-end)

`then: "commit"` transforme un gate vert en **commit hôte gouverné** :

```
attach_policy({
  sessionId, then:"commit",
  gate: { command:"ls", args:["hello.txt"], cwd:"." },
  commit: { paths:["hello.txt"], message:"…", requireHumanAck: true }
})
```

- Stage **strictement** `commit.paths` via `git add -- <paths>` (jamais `-A`,
  jamais de glob ; `paths` vide = rejeté à l'attache), puis `git commit -m`
  (argv, `shell:false` — pas d'injection). **Jamais de push, jamais `--force`.**
- `requireHumanAck: true` (défaut) : gate vert → status `awaiting-ack` + event
  **`policy:commit-ready`** (avec `paths`, `message`, `commitPlan.cwd`). Le commit
  **ne part pas** tant que `ack_policy({ policyId, approve:true })` n'est pas
  appelé → exécute le commit → **`policy:committed` (+ sha)** → `done`.
  `approve:false` annule sans committer.
- `requireHumanAck: false` : commit direct au vert (toujours sans push).
- **Prérequis** : `git` allowlisté + un repo git avec `user.name`/`user.email`
  configurés à la cwd du commit. Séquence prouvée :
  `gate exit 0 → policy:commit-ready (awaiting-ack) → ack(approve:true) → policy:committed sha=…`,
  vérifiée par `git log` (1 fichier, 1 insertion).

## 5. Lire l'avancement sans polling — le bus d'events

`poll_events({ since, types?, sessionIds?, limit? })` : snapshot **curseur** des
events depuis le dernier appel (pas de transcript, donc bon marché). Types utiles :
`turn-end`, `awaiting-input`, `exited`, `command-done`, `policy:passed`,
`policy:failed`, `policy:commit-ready`, `policy:committed`. Prends un curseur
(`nextCursor`) **avant** de déclencher, relis après. Pour **bloquer** efficacement
sur une complétion imminente, `wait_for_any` ; pour un **sweep** d'état entre deux
actions, `poll_events`.

## 6. Escalade humaine via webhook (source)

`webhook-notifier.ts` POST un event aux URL cibles (per-session `notifyUrl` passé
au spawn **+** globale `AGENTPROTO_NOTIFY_URL` / `~/.agentproto/notify.json`, env
gagne, dédupliquées). Fire-and-forget : timeout 10 s, **un** retry après 2 s sur
erreur réseau, aucun retry sur 4xx/5xx, jamais d'exception dans le hot-path.
Déclenché sur `turn-end` / `awaiting-input` / `exited` (payload : `sessionId`,
`label`, `event`, `awaitingInput`, `ts`, + `exitCode`/`status` à l'exit). C'est le
seam « préviens-moi quand un agent attend » sans cowork ouvert.

## 7. RoutineRunner — la cible « babysit durable » (source, MVP)

`routine-runner.ts` est le superviseur durable complet : il exécute une séquence
de `RoutineStep[]` **en réagissant aux events** (pas de polling), gère le **fan-in**
(`waitFor: string[]` attend que TOUTES les sessions finissent), et applique une
**policy d'attente** par étape :

- `auto-allow` (+`prompt`) : répond tout seul et continue.
- `escalate` (+`webhookUrl?`, `timeoutMs?` défaut 5 min) : POST le webhook puis
  attend un `resolve(runId, stepIndex, response)` externe ; timeout = échec.
- `fail` : marque l'étape/le run en échec.

C'est « un agent qui babysit un autre en jouant l'humain **et n'escalade que si
bloqué** » (cf. le babysit live de `nested-orchestration`, ici rendu durable).

**Limites importantes (à connaître avant de s'appuyer dessus) :**

- **In-memory MVP** : l'état des runs n'est PAS persisté (`TODO: persist to
  ~/.agentproto/routine-runs.json`). Un restart du daemon **perd** les runs en
  cours. (Les policies `attach_policy` et les transcripts de session, eux,
  survivent ; c'est le RoutineRunner qui est volatile.)
- **Surface MCP : câblée sur branche, pas encore déployée.** Les tools
  `start_routine` / `get_routine_status` / `cancel_routine` / `resolve_routine` /
  `list_routines` existaient déjà dans `orchestration-tools.ts` mais ne
  s'enregistraient que `if (routineRunner)` fourni — et aucun call-site ne le
  passait. Le wiring (singleton dans `index.ts`, root gateway) **+ la persistance**
  (`~/.agentproto/routine-runs.json`, save atomique, recovery des runs stale en
  `failed` au restart) ont été livrés sur **PR #101 `feat/routine-runner-durable`**
  (commit `3cc75a7`, gate vert vérifié). Tant que la PR n'est pas mergée **et** le
  daemon rebuild+restart, ces tools ne sont pas actifs sur le daemon en cours :
  la voie **pilotable aujourd'hui** reste `attach_policy` + `next` (DAG) +
  `poll_events` + webhook. Note de design retenue : routine tools **hors** du
  subset orchestrateur scopé (invariant handshake).

## 8. Quand utiliser quoi

- **Une complétion à jalonner / un gate de tests** → `attach_policy then:emit` +
  `poll_events`.
- **Commit gouverné par un gate vert** → `attach_policy then:commit` +
  `requireHumanAck` + `ack_policy`.
- **Plusieurs étapes enchaînées** → `next` (DAG de policies, pilotable) plutôt que
  le RoutineRunner tant qu'il n'est pas exposé.
- **Critère qualitatif** → gate `judge`.
- **Prévenir un humain quand ça attend/bloque** → `notifyUrl` (per-session) ou
  global.

## Gotchas (vécus + source)

- **Race d'attache** : attache la policy **avant** le turn-end de la session
  (spawn idle → attach → prompt). Sinon l'event peut être manqué.
- **`test` n'est pas allowlisté** ; `ls`/`cat`/`git`/`node`/`pnpm`/`echo`/`bash` le
  sont. Adapte le gate à l'allowlist du workspace.
- **`cwd escapes the workspace`** : la session surveillée (ou la `gate.cwd`) doit
  être **dans** le workspace. Les sessions lancées dans un scratch hors-workspace
  ne sont pas gateables tel quel.
- **Commit isolé pour tester** : ne teste JAMAIS `then:commit` dans le repo de
  travail — le workspace root EST souvent un repo réel. Fais `git init` un repo
  jetable **dans** le workspace (cwd ne s'échappe pas), teste, puis `rm -rf`.
- **onFail** : sans `onFail`, un gate rouge → `blocked` immédiat. Avec, la session
  est re-promptée (`nudge`, `{code}` = exit code) jusqu'à `maxRetries` (défaut 2)
  puis `blocked` — la session doit être **encore running** pour recevoir le nudge.
- **RoutineRunner volatile** : voir §7 — ne t'appuie pas dessus pour du long-cours
  tant que la persistance + la surface MCP ne sont pas livrées.

## Checklist supervision durable

- [ ] Session surveillée **dans le workspace** (cwd ne s'échappe pas)
- [ ] Gate avec un binaire **allowlisté** (`ls` pas `test`, `pnpm`/`node` pour les tests)
- [ ] Policy attachée **avant** le turn-end (spawn idle → attach → prompt)
- [ ] `then:emit` pour jalonner / `then:commit` + `requireHumanAck` pour committer
- [ ] Commit : `paths` explicites, repo + `user.name/email`, **repo isolé** si test
- [ ] Suivi via `poll_events` (curseur) ; `ack_policy` pour libérer un commit
- [ ] Escalade `notifyUrl` seulement si tu veux être prévenu (bloqué/attente)
