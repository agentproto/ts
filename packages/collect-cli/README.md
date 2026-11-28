# @agentproto/collect-cli

The `collect` binary: a command-line tool for collecting public posts and
articles with provenance. It drives `@agentproto/collect` (engine, stores,
HTTP and API transports) from recipes and from the shell.

```sh
npm i -g @agentproto/collect-cli
collect --help
```

## Usage

```sh
collect init ./store                       # create a store
collect connectors --connector ./my-connector.mjs
collect doctor recipe.yaml                 # access level, secret presence (name only), transports
collect run recipe.yaml --store ./store    # run a recipe
collect run recipe.yaml --dry-run          # print the planned tasks, fetch and write nothing
collect run --connector ./my-connector.mjs \
  --source my-source --query "term" --subject "topic" --max 20 --store ./store   # trial run, no recipe
collect runs --store ./store
collect status <runId> --store ./store
collect resume <runId> --store ./store     # done tasks are not fetched again
collect export --store ./store > items.jsonl
collect export --store ./store --format csv --source my-source --out items.csv
collect reparse --store ./store --into ./rebuilt --connector ./my-connector.mjs
```

The store is `--store <path>`, else `$COLLECT_STORE`, else `./collect-store`.

### Recipe

YAML, validated with the `Recipe` schema of `@agentproto/collect`. An extra
top-level `connectors:` lists connector modules (paths relative to the recipe).

```yaml
name: weekly
connectors:
  - ./my-connector.mjs
sources:
  - connector: my-source
    queries:
      - { text: "some term", subject: "topic" }
workers: 4
caps: { total: 200 }
```

An invalid recipe prints each issue with its path (for example
`sources[0].queries[0].subject: ...`) and exits 2.

### Connector modules

`--connector <file>` (repeatable) imports a module and registers every
connector it exports (a default export, named exports, or an array), made with
`defineConnector`. A module may also export `apiAuth`
(`{ type: "bearer" | "header" | "query", ... }`) to say how the connector's
secret is sent; the default is a bearer token. `resume` loads again the
modules the original run used. One run supports connectors that need a single
API secret name.

### Secrets

A connector that declares `access: { level: "key", secret: "NAME" }` reads its
secret from the environment variable `NAME`. Secret values are never printed;
`doctor` shows only the variable name and whether it is set.

### Transports

`http` and `api` are wired. The browser transport is not available in this
version: `doctor` says so, and a connector that needs it is reported unusable.
`--rate-ms <n>` sets the minimum gap between two requests to one host
(default 1000).

### Output and exit codes

Results go to stdout, progress events to stderr (`--quiet` hides them).
`--json` gives machine output on every command: one JSON document on stdout
(`export` writes JSONL), events as JSON lines on stderr.

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | partial failure: a connector or task failed, was skipped, or the run was interrupted; the rest is written. `doctor`: a requested connector is unusable. `reparse`: a raw could not be rebuilt |
| 2 | usage error: bad arguments, invalid recipe, unknown run |
| 3 | store locked, missing or unreadable |

### Export

JSONL (one item per line, the stored shape) by default; `--format csv` writes
one row per item, structured fields (`subjects`, `links`, `ext`, ...) as JSON
text in their cell. `--view flat` is not available yet (exit 2).

### Reparse

`collect reparse --into <new store>` rebuilds items, observations, actors and
pickups from the stored raw responses through each connector's pure `parse`,
with no network. It never rewrites the source store: the result goes into a new
store (`--into` must not exist yet or be empty), written at the current schema
version, with the raw bodies and their index copied so it stands alone. Run
history is not copied. Dedup follows the engine (native id, then canonical
URL). Failed raws are copied but not parsed. Check the result, then swap the
directories yourself. The source store is locked while it is read (exit 3 if a
run holds it).

## License

Apache-2.0
