---
"@agentproto/runtime": minor
"@agentproto/apps": minor
---

Model roles: one config for which model the reviewers and judges use. The daemon config gains a `models` map (role → model id, or `{ model, route?, profile? }`), resolved as explicit input > repo `agentproto.json` `models` > daemon config `models` > built-in default (`DEFAULT_MODEL_ROLES`: `review.small`, `review.large`, `review.pr`, `judge.session`). `config_set models.<role>` warns (does not block) on a model id the catalog does not know, `config_get` lists the roles, and the new read-only `model_roles` tool reports each role's resolved model and source. An AGENT.md `model: role:<name>` is resolved before adapter selection and `app_run` spawn. The repo-maintenance `maintain` workflow (`reviewModelSmall`/`reviewModelLarge`) and the session-steward (`judgeModel`) now default to their roles instead of hard-coded ids; explicit inputs still win.
