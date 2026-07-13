# `agentproto rendezvous`

```text
agentproto rendezvous serve [--port <n>] [--host <ip>]
                            [--park-timeout-ms <n>] [--idle-timeout-ms <n>]
                            [--max-message-bytes <n>]
```

Run your own **rendezvous broker** — the untrusted ciphertext splicer that
[`pair`](./pair.md) routes through. The broker matches two WebSocket sockets
sharing a one-time token and pipes their bytes verbatim; it never parses
payloads and, because pairing traffic is end-to-end encrypted, it **cannot read
or forge** anything. It learns only the token, the peers' IPs, message sizes,
and timing.

Self-hosting is defence in depth (the crypto already protects you against a
malicious broker) plus an escape hatch: no third party — not even a future
hosted default instance — need sit between your client and daemon.

This is a thin re-export of the standalone `agentproto-rendezvous` binary, so
you don't need that bin on your `PATH`.

## Serve

```bash
agentproto rendezvous serve --port 8788 --host 0.0.0.0
```

```text
agentproto-rendezvous listening on ws://0.0.0.0:8788/v1
  clients dial:  ws://<this-host>:8788/v1?side=client&t=<token>
  daemons dial:  ws://<this-host>:8788/v1?side=daemon&t=<token>
  the broker only ever sees ciphertext — token, IPs, sizes, timing.
```

Point a daemon at it with `pairing.rendezvous` in config, or per-offer with
`agentproto pair offer --rendezvous ws://your-host:8788/v1`. For anything beyond
localhost, terminate TLS in front of it (`wss://`) with your usual reverse proxy.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <n>`, `-p` | `8788` | Port to bind. |
| `--host <ip>`, `-H` | `0.0.0.0` | Bind address. |
| `--park-timeout-ms <n>` | `120000` | How long a lone socket waits for its peer before it's recycled. |
| `--idle-timeout-ms <n>` | `900000` | Idle teardown after a splice (15 min). |
| `--max-message-bytes <n>` | `1048576` | Max WS message size (1 MiB). |

The broker also rate-limits token attempts per IP, enforces single-use tokens (a
token that has already spliced is dead), and compares tokens in constant time.

`SIGINT` / `SIGTERM` shut it down gracefully.

## See also

- [pair.md](./pair.md) — the pairing ceremony that uses the broker.
- [concepts/pairing.md](../concepts/pairing.md) — why the broker can't cheat.
