# @agentproto/review-pack-core

A first-party [review pack](../review/README.md#review-packs) for
[`@agentproto/review`](../review): three generic reviewer lanes —
`correctness`, `security`, `tests` — meant to be `uses:`d from a consumer
REVIEW.md instead of hand-writing the same rubrics in every repo.

```yaml
uses:
  - pack: ../review-pack-core     # or the npm name, once published
    as: core
    preset: kimi                  # every lane in this pack needs one
checks: [...]
bindings:
  local: {checks: [..., core/correctness, core/security, core/tests]}
```

Files-only — `REVIEW.md` + `rubrics/`, no build step, no `main`/`exports`.
Private for now: publishing to npm is out of scope until the pack format
settles (see `@agentproto/review`'s README), so consume this by relative
path until then.

## License

Apache-2.0
