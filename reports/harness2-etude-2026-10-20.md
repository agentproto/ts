# Etude harness2, 2026-10-20

## Resume en six lignes

1. harness2 est un framework de recherche Google (Apache-2.0, v0.1.0, Python 3.12) qui optimise recursivement le harness d'un agent dont les poids restent figes, sans verificateur de verite terrain.
2. Son coeur est Propose-Probe-Compose: une execution de reference, des candidats invariant et domaine, des probes contrastifs, puis une composition selective, en mode parallele ou sequentiel borne par k.
3. Il ajoute une bibliotheque par domaine qui conserve le harness adopte et des lecons EXPERIENCE.md, et separe strictement selection aveugle, judge et report.
4. Il pilote aujourd'hui OpenCode ou Codex sur trois benchmarks (JobBench, LAB, WorkBuddy) et produit runs/, deliverables, judged.json et rapports; c'est un prototype de recherche, pas une plateforme.
5. agentproto est complementaire: daemon de sessions, adapters AIP-45, runs AIP-58, eval/scorers et sandbox; harness2 n'est pas un agent interactif et ne doit pas devenir un adapter AIP-45 classique.
6. Recommandation: utiliser harness2 comme backend d'eval/benchmark ou comme source de patterns (M/L), avec priorite au tree c1-c8, aux preuves fichiers sans fuite de rubric, a la bibliotheque d'experience et a la separation judge; un adapter AIP-45 direct est L pour une valeur faible.

## 1. Sources examinees

- Depot clone: `https://github.com/google-research/harness2`, commit `1cfe254e8d25b15f37048c3730134686abe60335`, dernier commit du 2026-10-13.
- `README.md`, `docs/SETUP.md`, `docs/BENCHMARKS.md`, `docs/EXPERIMENTS.md`, `CONTRIBUTING.md`, `pyproject.toml`, `LICENSE`.
- Code: `harness2/core/` (spec, recursion, proposer, context, selection, library, judge, report, schedule, tree, prompts), `harness2/substrate/`, `harness2/benchmarks/`, `harness2/cli/`.
- Test: `tests/test_workflow.py`, seul fichier de test, 229 lignes. Pas de workflow CI dans le clone.
- Papier: `Harness^2: Recursive Agent Harnessing for an Open World`, arXiv:2610.14224v1, soumis le 2026-10-09. Abstract et sections 2.1 a 2.3 lus.
- Licences tierces: `dependencies/README.md`, `third_party/README.md`, `third_party/licenses/`.

### Licence

Le code principal est sous Apache License 2.0. Les runners et donnees de benchmarks gardent leurs licences amont:

- JobBench: Apache-2.0.
- Harvey LAB: MIT.
- WorkBuddy-Bench: licence Tencent personnalisee, avec une restriction territoriale explicite pour l'Union europeenne.
- OpenCode: MIT.
- Les datasets ne sont pas redistribues; ils sont telecharges depuis leurs distributions amont.

Cette asymetrie de licences compte pour une integration: le coeur harness2 est reutilisable, WorkBuddy ne l'est pas forcement dans notre contexte.

## 2. Ce que fait harness2

### 2.1 But

harness2 part d'une constatation: a modele fige, la performance depend fortement du harness, c'est-a-dire des prompts, garde-fous, memoire, skills, scripts, subagents, plugins et de l'orchestration autour du modele. Le projet cherche a ameliorer automatiquement ce harness sur des taches ouvertes, sans labels ni rubric accessibles au moment de l'amelioration.

Il y a deux niveaux de recursion:

- Recursion au niveau tache: ameliorer le harness d'execution pour la tache courante.
- Recursion au niveau harnessing: conserver les harness adoptes et les lecons pour ameliorer la facon dont les taches suivantes seront harnessees.

Les poids du modele ne changent jamais.

### 2.2 Architecture et séparation des responsabilites

Le depot separe trois axes, ce qui est la partie la plus reutilisable du design:

1. Methode: `harness2/core/`. Elle ne connait ni benchmark ni framework d'agent. Elle gere la recursion, les prompts, la selection, la bibliotheque, le ledger, le report.
2. Substrat: `harness2/substrate/`. Il definit comment materialiser un harness et executer un rollout sous un framework d'agent. Deux implementations existent: OpenCode (`oc`, defaut) et Codex (`cx`).
3. Benchmark: `harness2/benchmarks/`. Chaque benchmark fournit un `BenchSpec` et un adapter qui expose taches, domaines, prompt de tache, execution, livrables, trajectoire et scoring.

Le contrat est dans `harness2/core/spec.py`:

- `BenchmarkAdapter` expose `tasks`, `domain_of`, `task_prompt`, `task_files`, `execute`, `delivered`, `trajectory`, `deliverable_files`, `deliverable_text`, `base_harness`, `validate_tree` et `score`.
- `Substrate` expose `surface`, `materialise`, `execute`, `read_trajectory` et `preflight`.
- `RunView` ne transporte jamais de score: uniquement label, run_id, run_dir, ok, delivered, cout, duree et erreur.

C'est un bon modele de seam: la methode ne peut pas tricher avec le score, puisque le score n'entre pas dans son interface.

### 2.3 Les huit composants editables

harness2 expose huit composants, notes c1 a c8:

| Composant | Role runtime |
|---|---|
| `systemprompt.md` | role et procedure, toujours en contexte |
| `guardrails.md` | regles permanentes, toujours en contexte |
| `LongTermMEMORY.md` | faits durables, toujours en contexte |
| `tool_descriptions/tool_guidance.md` | mode d'emploi des outils, toujours en contexte |
| `skills/<name>/SKILL.md` | workflow recharge a la demande |
| `sub_agents/<name>/AGENT.md` | delegation dans un contexte separe |
| `scripts/<name>.py` | helpers deterministes executables |
| `plugin/<name>.ts` | middleware dans la boucle d'outils |

Le `SurfaceSpec` decrit les chemins autorises, les caps de texte always-on, les regles de nommage, les triggers de skills et les stubs. `harness2/core/tree.py` sait lire, valider, ecrire et differ un tree. La regle d'edition est "omitted is inherited": un proposer n'emet que ce qu'il change.

### 2.4 Propose, Probe, Compose

Le pas contrastif est decrit dans le papier et implemente dans `harness2/core/recursion.py`:

1. Propose: une execution de reference du harness courant est produite. Deux candidats sont proposes: un candidat invariant, qui vise des faiblesses agentiques recurrentes (planning, usage des outils, contexte, delegation), et un candidat domaine, qui vise les connaissances et contraintes de la tache.
2. Probe: chaque candidat est execute sur la meme tache, avec le meme modele et le meme environnement. La comparaison des trajectoires et livrables donne un contraste comportemental, pas une verification de correctitude.
3. Compose: un composer lit la reference, les candidats, leurs diffs et les preuves, puis fusionne, revise, adopte un candidat ou conserve le harness courant. Chaque decision doit etre liee a une observation.

Le harness compose est execute a son tour. Le resultat d'un stage contient le harness, son execution et les notes de decision.

### 2.5 Modes parallele et sequentiel

- `--mode parallel`: 2k candidats a partir des memes preuves, puis k compositions independantes. Chaque composition voit tout le pool.
- `--mode sequential`: k passes Propose-Probe-Compose; le harness raffine et l'historique d'execution sont transportes d'une passe a l'autre.
- `--k 1`: les deux modes se reduisent au pas contrastif de base, sans selection.

La documentation interne de `recursion.py` annonce 4k rollouts et 3k stages d'amelioration, base partagee incluse.

### 2.6 Selection et evaluation

Point important: la methode n'a pas acces a la verite terrain. Pour `k > 1`, un selector agentique compare des livrables anonymises, avec la demande et les sources, et choisit un output existant. Il ne synthetise rien et ne voit pas quel harness a produit quel output.

Le jugement est separe de la methode:

- `harness2/core/judge.py` ne fait pas partie du chemin d'amelioration.
- Un echec de judge vaut `None`, jamais zero, et sort du denominateur.
- `harness2/cli/judge.py` et `harness2/cli/report.py` sont des commandes separees.
- LAB reporte partial et all-pass; JobBench utilise les poids de rubric amont; WorkBuddy lit un score de payload.
- Le report avertit sur les unites de score melangees, les fallbacks de stage, le choix d'un output de base et le plancher de bruit a k=1.

### 2.7 Bibliotheque d'experience

`harness2/core/library.py` implemente la recursion de harnessing:

```text
<root>/<run-tag>/<mode>/<domain>/INDEX.md
<root>/<run-tag>/<mode>/<domain>/harnesses/<task>/harness/<rel>
<root>/<run-tag>/<mode>/<domain>/harnesses/<task>/EXPERIENCE.md
```

Chaque entree porte le tree complet, pas un resume, et une lecon avec cue, lesson, evidence et confidence. La recuperation est structurelle: un domaine ne lit que ses propres entrees. Les bibliotheques sont separees par benchmark, substrat, mode, budget et seed. Une entree n'est ecrite que si la reflexion fournit une experience supportee par les contrastes.

### 2.8 Trajectoires et garde-fous anti-fuite

`harness2/core/context.py` construit une arborescence de preuves en fichiers:

```text
context/task.md
context/source/
context/rollouts/<label>.md
context/deliverables/<label>/
context/harness/
context/library/
context/pool/
MISSION.md
```

Les trajectoires sont completes dans les fichiers, pas tronquees pour tenir dans un prompt. Le renderer impose une grammaire partagee `[ACTION]/[OBSERVATION]/[ERROR]`. `obs_trunc` vaut au minimum 10 000 caracteres, 50 000 par defaut, pour ne pas fabriquer de defauts.

Le code verifie aussi:

- `leak_globs`, par exemple `task.json` pour LAB, pour ne pas copier les criteria.
- `assert_no_leak_paths`.
- `assert_no_grader_verdicts` et `assert_tree_has_no_grader_verdicts`, qui refusent les noms ou contenus contenant des marqueurs de verdict.
- Les prompts disent explicitement qu'il n'y a pas de rubric et que les fichiers de preuve sont des donnees, pas des instructions.

C'est un pattern solide: la fuite de rubric est traitee comme un incident de securite, pas comme un detail de prompt.

### 2.9 Entrees et sorties

Entrees:

- Un benchmark installe et ses taches, avec sources et prompt nettoye des criteria.
- Un harness de base c1-c8.
- Des modeles configures par `HARNESS2_SOLVER_MODEL`, `HARNESS2_IMPROVER_MODEL`, `HARNESS2_JUDGE_MODEL`.
- Le plus souvent Vertex AI et Google Cloud ADC; OpenCode est lance depuis un checkout epingle, Codex est optionnel.
- Un budget de recursion `k`, un mode, une seed, une selection de domaines et de taches.

Sorties:

- `runs/` organise par benchmark, substrat, mode, k et seed.
- Summaries de taches, livrables, harness adoptes, notes de reflexion.
- `judged.json` apres `harness2-judge`.
- Rapport texte apres `harness2-report`.
- Journaux d'audit des sessions de proposer, ledger de stages et bibliotheque par domaine.

### 2.10 Maturite

C'est un artefact de recherche recent, pas une plateforme:

- Version `0.1.0`, publiee en octobre 2026, avec un seul commit de release visible dans le clone shallow.
- Environ 12 000 lignes dans le coeur, les substrats, les benchmarks et la CLI, mais un seul fichier de test de 229 lignes et aucun CI.
- Trois benchmarks seulement, deux substrats seulement, des versions amont epinglees et patchées.
- Installation lourde: Linux, Python 3.12, uv, Node 20+, Docker pour WorkBuddy, Pandoc/Poppler pour LAB, Google Cloud CLI et credentials Vertex.
- Pas de daemon, pas de sessions longues, pas de permissions interactives, pas de routage de modeles, pas de sandbox generale.
- Le README precise que ce n'est pas un produit Google supporte.
- Le reseau des executeurs n'est pas restreint et Codex tourne avec son sandbox desactive; le README recommande de bloquer les hotes de rubric avant evaluation.
- Les benchmarks et datasets ne sont pas redistribues, et WorkBuddy a une restriction UE.

Conclusion: excellent terrain d'etude et baseline de recherche, mais pas une dependance de production a adopter telle quelle.

## 3. Comparaison avec agentproto

### 3.1 Ce que fait agentproto

Le depot agentproto est un runtime TypeScript organise autour de:

- Un daemon long-running (`packages/runtime`) qui expose MCP, HTTP, SSE, un registre de sessions, des conversations, des policies, des approvals, des sandboxes et des runs.
- Des adapters AIP-45 (`adapters/*`) qui declarent comment installer, verifier, authentifier et spawner un agent CLI. Le driver commun vit dans `packages/driver/agent-cli`. Les protocoles supportes incluent ACP, MCP, print et proprietary.
- Des presets de harness typés (`packages/harness`) qui lancent des sessions preconfigurees coder, researcher ou supervisor au-dessus des outils du daemon.
- AIP-58 pour les runs de workflow (`packages/workflow-runtime`, `packages/runtime/src/workflow-runner.ts`, `run-workspace.ts`, `run-event-log.ts`): runId, workspace isole, artifacts, event log append-only, retry, suspension, reprise.
- Un moteur de workflow typé (`packages/workflow-runtime`) avec steps tool, agent, artifact, map, pipeline, parallel, branch, loop, approval, suspend, subworkflow, budget agrege, structured output et cache.
- Un package eval (`packages/eval`) ou un scorer est un tool AIP-14 avec un `Score` partage; il fournit exact-match, regex, json-schema, latency-budget, un LLM-as-judge injectable, et `runEval` qui compose cible, scorers et telemetrie.
- Des reporters d'eval (`packages/eval-reporters`) pour stderr, array ou Langfuse.
- Un package `packages/model-intel` qui traite surtout des quotas AIP-67, pas du benchmark de modeles. Il n'existe pas de package `model-bench` dans ce clone; le chemin eval existant est `packages/eval` plus `packages/eval-reporters`.
- Des briques sandbox et egress: `packages/sandbox`, `packages/sandbox-box`, `packages/sandbox-e2b`, `packages/command-sandbox`, `packages/egress`, plus les modules `sandbox-*` du runtime.

### 3.2 Tableau de correspondance

| Sujet | harness2 | agentproto |
|---|---|---|
| Unite d'execution | Un rollout de benchmark, relance et reprenable par run_id | Une session de daemon ou un run AIP-58 |
| Agent | OpenCode ou Codex, lance par un substrat | N'importe quel adapter AIP-45, via ACP/MCP/print |
| Contrat d'extension | `Substrate` et `BenchmarkAdapter` | AIP-45, `defineAgentCli`, drivers AIP-30, tools AIP-14 |
| Harness editable | Tree c1-c8 avec `SurfaceSpec` | Presets `packages/harness`, `AGENTS.md`, skills, MCP servers, plugins |
| Persistance | Fichiers sous `runs/`, bibliotheque par domaine | Daemon, transcripts, artifacts, AIP-58 event log, reprise |
| Selection | Selector agentique sur livrables anonymises | Pas d'equivalent direct; `eval` et `runEval` scorers |
| Evaluation | Judge par benchmark, separe de la methode | Scorers deterministes, LLM judge injectable, reporters |
| Sandbox | WorkBuddy via Docker/Harbor, sinon acces reseau non restreint | Couche sandbox et egress dediee |
| Maturite | Prototype de recherche, 3 benchmarks | Runtime plus large, contracts AIP et CI |

### 3.3 Diagnostic

Les deux projets ne sont pas concurrents au meme niveau. harness2 optimise le harness et mesure sur trois benchmarks. agentproto fournit le runtime, les sessions, les adapters, les runs, la sandbox et une primitive d'eval generique. harness2 pourrait etre un client ou un consommateur d'agentproto, pas l'inverse.

## 4. Options d'integration

### Option A: adapter AIP-45 harness2

Question: harness2 peut-il devenir un adapter qu'agentproto spawn?

Reponse: techniquement oui, mais le modele est mauvais. harness2 n'est pas un agent interactif. Sa CLI attend un benchmark, une liste de taches, des modeles et un budget; elle ne prend pas un prompt libre sur stdin et ne rend pas un tour de conversation. Un adapter AIP-45 devrait inventer une semantique de type "prompt = tache de benchmark", exposer un protocole print ou ACP, et masquer que l'execution interne relance deja OpenCode ou Codex.

Effort: L.

Valeur: faible a moyenne. On obtiendrait un agent qui ne sait faire que des benchmarks harness2, sans usage general dans le daemon.

Fichiers a toucher:

- `adapters/harness2/package.json` (nouveau package `@agentproto/adapter-harness2`).
- `adapters/harness2/src/index.ts` (nouveau `defineAgentCli`, probablement `protocol: "print"`).
- `adapters/harness2/src/harness2-cli.ts` ou `bin/harness2-runner.py` (pont prompt vers tache, parsing des sorties).
- `adapters/harness2/src/index.test.ts` (tests de manifeste et de spawn).
- `packages/cli/src/registry/catalog.ts` (entree de catalogue).
- `docs/cli/concepts/adapters.md` et `README.md` (documentation de l'adapter).

Alternative plus utile: ne pas faire un adapter harness2, mais ajouter un substrat `AgentProtoSubstrate` cote harness2 (`harness2/substrate/agentproto.py`) pour qu'harness2 pilote des sessions agentproto. Cela inverse la dependance et reutilise notre runtime. Les fichiers cote agentproto seraient alors surtout `packages/harness/src/client.ts`, `packages/harness/src/handle.ts`, `packages/runtime/src/agent-tools.ts` et `packages/runtime/src/session-tools.ts`, avec un contrat d'injection de harness et d'export de run a stabiliser. Effort L, valeur plus elevee.

### Option B: backend d'eval / benchmark

Question: harness2 peut-il servir de backend a nos travaux model-bench / llm-intelligence?

Reponse: oui, c'est l'option la plus naturelle, a condition de ne pas vendre harness2 comme un backend generique. Il apporte trois benchmarks professionnels, un protocole de run reproductible, un judge separe et des artefacts de livraison. Il n'apporte pas un format d'eval universel ni une API stable.

Deux niveaux:

#### B1. Runner et import de resultats (recommande)

Un package TypeScript appelle la CLI harness2, lit `runs/`, `judged.json` et les summaries, puis les convertit en `EvalReport` et en evenements `EvalEvent`. On garde harness2 comme processus externe, avec son environnement Python, et on n'introduit aucune dependance Python dans le daemon.

Effort: M.

Valeur: elevee pour un tableau de bord d'intelligence de modeles sur des taches professionnelles, mais limitee aux trois benchmarks harness2 et a leurs licences.

Fichiers a toucher:

- `packages/eval-harness2/package.json` (nouveau package, depend de `@agentproto/eval`, `@agentproto/telemetry`, `zod`).
- `packages/eval-harness2/src/index.ts` (exports publics).
- `packages/eval-harness2/src/run-harness2.ts` (spawn `harness2`, `harness2-judge`, `harness2-report`, gestion des timeouts et des codes retour).
- `packages/eval-harness2/src/parse-runs.ts` (lecture des namespaces, summaries, judged rows, artifacts).
- `packages/eval-harness2/src/types.ts` (mapping vers `EvalReport`, `CaseReport`, `Score`).
- `packages/eval-harness2/src/__tests__/parse-runs.test.ts` (fixtures de runs).
- `packages/cli/src/commands/eval.ts` (nouvelle commande `agentproto eval harness2 ...`).
- `packages/cli/src/cli.ts` (dispatch de la commande).
- `packages/cli/package.json` (dependency workspace vers le nouveau package).
- `packages/eval/src/score.ts`, `packages/eval/src/events.ts`, `packages/eval/src/run-eval.ts` (reutilisation, eventuellement petite extension pour un target externe).
- `packages/eval-reporters/src/resolve.ts` (inchange, reutilise pour Langfuse ou stderr).

Ne pas modifier `packages/eval/src/judge.ts` pour y mettre harness2: le judge harness2 doit rester dans le runner, car il depend de l'environnement du benchmark.

#### B2. Substrat agentproto pour harness2 (plus profond)

On implemente `AgentProtoSubstrate` cote harness2 et on expose cote agentproto un moyen stable de:

- materialiser un tree c1-c8 dans un workspace de session;
- lancer une session avec un adapter et un modele donnes;
- recuperer trajectoire, livrables et cout;
- exposer un run_id stable et des artifacts.

Effort: L.

Valeur: tres elevee strategiquement, car harness2 pourrait alors optimiser des harness agentproto sur n'importe quel adapter, pas seulement OpenCode ou Codex.

Fichiers a toucher cote agentproto:

- `packages/harness/src/client.ts` et `packages/harness/src/handle.ts` (client daemon reutilisable).
- `packages/harness/src/harnesses/` (presets ou injection de harness).
- `packages/runtime/src/agent-tools.ts` et `packages/runtime/src/session-tools.ts` (options de spawn et de suivi).
- `packages/runtime/src/session-artifacts.ts` (export des livrables).
- `packages/runtime/src/transcript-writer.ts` et `packages/runtime/src/transcript-export.ts` (trajectoire lisible).
- `packages/runtime/src/run-workspace.ts`, `packages/runtime/src/run-event-log.ts`, `packages/runtime/src/workflow-runner.ts` (si on veut aligner sur AIP-58).
- `packages/eval/src/run-eval.ts` et `packages/eval/src/judge.ts` (si on veut un scoring agentproto en plus du judge harness2).

Cote harness2, le fichier principal serait `harness2/substrate/agentproto.py`, avec adaptation de `harness2/core/spec.py` seulement si le contrat `Substrate` doit bouger.

### Option C: copier des idees et patterns

Question: y a-t-il des idees a reprendre?

Reponse: oui, c'est le meilleur retour sur effort. Les patterns sont directement compatibles avec nos packages et ne creent pas de dependance a harness2.

#### C1. Tree de harness c1-c8 et `SurfaceSpec`

Un modele de donnees declaratif pour les composants editables d'un harness, avec chemins autorises, caps, regles de nommage, stubs et validateurs. Cela manque aujourd'hui a `packages/harness`, qui expose des presets mais pas de surface d'edition unifiee.

Effort: M. Valeur: elevee.

Fichiers: `packages/harness/src/tree.ts` (nouveau), `packages/harness/src/context.ts`, `packages/harness/src/harnesses/*.ts`, `docs/HARNESS-DESIGN.md`.

#### C2. Preuves en fichiers, sans rubric, avec tripwires

Servir les trajectoires completes comme fichiers de contexte, avec une grammaire `[ACTION]/[OBSERVATION]/[ERROR]`, des guards de fuite et une separation stricte entre donnees et instructions. Cela ameliorerait nos evals et nos boucles de review.

Effort: M. Valeur: elevee.

Fichiers: `packages/runtime/src/transcript-writer.ts`, `packages/runtime/src/session-artifacts.ts`, `packages/runtime/src/transcript-export.ts`, `packages/runtime/src/redaction.ts`, `packages/eval/src/run-eval.ts`, `packages/eval/src/judge.ts`.

#### C3. Bibliotheque d'experience par domaine

Stocker un harness complet plus un `EXPERIENCE.md` avec cue, lesson, evidence et confidence, et ne lire que les entrees du meme domaine. Cela pourrait alimenter `packages/harness`, `packages/knowledge` ou `packages/workspace-brain`.

Effort: M. Valeur: moyenne a elevee.

Fichiers: `packages/harness/src/library.ts` (nouveau), `packages/harness/src/context.ts`, `packages/knowledge/src/*`, `packages/runtime/src/workspace-brains.ts`.

#### C4. Selection aveugle et judge separe

Anonymiser les sorties, masquer le harness d'origine, choisir un output existant sans synthese, puis juger apres selection. Notre `packages/eval` a deja un `JudgeFn` injectable et un `Score`; il manque le protocole de selection aveugle et la discipline "judge failure is None, not zero".

Effort: S. Valeur: elevee.

Fichiers: `packages/eval/src/judge.ts`, `packages/eval/src/score.ts`, `packages/eval/src/run-eval.ts`, `packages/eval/src/events.ts`, `packages/eval-reporters/src/resolve.ts`.

#### C5. Ledger, fingerprint et reprise

harness2 marque chaque run complet, verifie le fingerprint du harness et refuse de melanger modeles ou partitions dans un meme namespace. AIP-58 couvre deja beaucoup de cela, mais le fingerprint de harness et l'identite de configuration sont des idees a reprendre dans nos runners.

Effort: S. Valeur: moyenne.

Fichiers: `packages/workflow-runtime/src/run-workflow.ts`, `packages/workflow-runtime/src/types.ts`, `packages/runtime/src/run-workspace.ts`, `packages/runtime/src/workflow-run-store.ts`, `packages/runtime/src/workflow-runner.ts`.

#### C6. Sandbox et egress au-dessus de la methode

harness2 reconnait lui-meme que le reseau non restreint peut laisser fuiter les rubrics. agentproto a deja `packages/egress`, `packages/sandbox`, `packages/sandbox-box`, `packages/sandbox-e2b`, `packages/command-sandbox`. Un backend harness2 execute dans notre sandbox avec egress deny-by-default serait un vrai differenciateur.

Effort: M. Valeur: elevee pour la validite des mesures.

Fichiers: `packages/egress/src/*`, `packages/sandbox/src/*`, `packages/sandbox-box/src/*`, `packages/runtime/src/sandbox-exec.ts`, `packages/runtime/src/sandbox-ledger.ts`, `packages/runtime/src/egress.ts`.

### Recommandation

1. Ne pas faire l'Option A comme adapter classique.
2. Faire l'Option B1 si l'objectif est de mesurer des modeles sur des taches professionnelles a court terme. C'est un package isole, sans dette dans le daemon.
3. Faire l'Option B2 seulement si l'objectif strategique est de faire de harness2 un optimiseur de harness agentproto. C'est un chantier L, mais il a le plus de valeur a long terme.
4. Prendre C2, C4 et C6 en priorite, puis C1 et C3. Ces patterns renforcent directement `packages/eval`, `packages/harness` et la sandbox, independamment de harness2.
5. Ne pas embarquer WorkBuddy ni ses donnees sans revue de licence a cause de la restriction UE.

## 5. Autres projets recents a regarder

Projets verifies via l'API GitHub le 2026-10-20:

- OpenHands, `https://github.com/OpenHands/OpenHands`. Plateforme d'agents de developpement avec runtime, sandbox et taches SWE; reference pour l'execution reelle et l'orchestration, licence MIT.
- Harbor, `https://github.com/harbor-framework/harbor`. Framework d'evaluation et d'amelioration d'agents, utilise par WorkBuddy, avec runners et environnements isoles; le voisin le plus direct de harness2, licence Apache-2.0.
- Terminal-Bench, `https://github.com/harbor-framework/terminal-bench-1`. Benchmark d'agents sur taches terminal, utile pour comparer des harness et des environnements d'execution, licence Apache-2.0.
- Inspect AI, `https://github.com/UKGovernmentBEIS/inspect_ai`. Framework d'evaluation de LLM avec taches, solvers, scorers et logs; bon modele pour un backend d'eval generique, licence MIT.
- mini-SWE-agent, `https://github.com/SWE-agent/mini-swe-agent`. Agent minimal d'environ 100 lignes qui resout des issues GitHub; utile comme baseline simple et comme contre-exemple aux gros harness, licence MIT.

## 6. Conclusion

harness2 est une contribution de recherche interessante sur un probleme reel: ameliorer le harness sans verite terrain. Son architecture methode/substrat/benchmark, son tree c1-c8, sa bibliotheque d'experience et sa discipline de separation selection/judge sont plus utiles que son code d'integration. Pour agentproto, la bonne cible n'est pas un adapter AIP-45 de plus, mais un backend d'eval Option B1, puis eventuellement un substrat Option B2, avec reprise immediate des patterns C2, C4 et C6.
