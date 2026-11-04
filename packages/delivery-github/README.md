# @agentproto/delivery-github

GitHub producer knowledge for the delivery kernel. This package keeps GitHub
verdicts, triage rows and coalesce/repeat keys out of `@agentproto/sentinel`
and `@agentproto/delivery`.

- `GITHUB_TRIAGE_RULE_TABLE`: the explicit event-class -> wake/fyi table
  (originally PR #2444).
- `FAILURE_VERDICTS` and `verdictOf`: the verdict vocabulary GitHub providers
  emit as `data.conclusion` or `data.state`.
- `GITHUB_CLASSIFIERS`: the table plus the generic failure classifier, ready
  for a delivery classifier registry.
- `GITHUB_COALESCE_RULES`, `githubCoalesceKeyFor`, `githubRepeatKeyFor`: queue
  keys per subject/head, and the triage repeat key (absent for failures so a
  repeat failure always wakes).
- `registerGithubDeliveryModule(registry)`: registers classifiers, coalesce
  rules and the repeat-key resolver into a producer's registries.
