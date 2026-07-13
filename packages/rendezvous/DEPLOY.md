# Deploying @agentproto/rendezvous

This document covers production deployment of the rendezvous server — the untrusted ciphertext splicer for E2E daemon pairing.

## Quick Start

### Docker

```bash
# Build the image
# build the bundle first (standalone package, only dep is ws):
pnpm --filter @agentproto/rendezvous build
docker build -t agentproto-rendezvous packages/rendezvous

# Run with default settings
docker run -p 8788:8788 agentproto-rendezvous

# Run with custom env vars
docker run -p 8788:8788 \
  -e RENDEZVOUS_PORT=8788 \
  -e RENDEZVOUS_HOST=0.0.0.0 \
  -e RENDEZVOUS_IDLE_TIMEOUT_MS=600000 \
  agentproto-rendezvous
```

### Binary

```bash
# Install
npm install -g @agentproto/rendezvous

# Run
agentproto-rendezvous serve --port 8788 --host 0.0.0.0
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RENDEZVOUS_PORT` | `8788` | Server port |
| `RENDEZVOUS_HOST` | `0.0.0.0` | Bind address |
| `RENDEZVOUS_PATH` | `/v1` | WebSocket upgrade path |
| `RENDEZVOUS_PARK_TIMEOUT_MS` | `120000` | How long a lone socket waits for its peer (2 min) |
| `RENDEZVOUS_IDLE_TIMEOUT_MS` | `900000` | Idle teardown after splice (15 min) |
| `RENDEZVOUS_MAX_MESSAGE_BYTES` | `1048576` | Max WebSocket message size (1 MiB) |
| `RENDEZVOUS_RATE_LIMIT_MAX` | `120` | Rate limit max attempts per window |
| `RENDEZVOUS_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (1 min) |
| `RENDEZVOUS_DEBUG` | `false` | Enable debug logging |

CLI arguments take precedence over environment variables.

## Health Checks

The server exposes a health endpoint at `GET /healthz`:

```bash
curl http://localhost:8788/healthz
# {"status":"ok","parked":0,"active":1}
```

Use this for load balancer health probes and container orchestration (Kubernetes liveness/readiness probes).

## TLS / HTTPS

The rendezvous server speaks plain WebSocket (ws://). For production, terminate TLS at your reverse proxy or load balancer:

### Nginx Example

```nginx
server {
    listen 443 ssl;
    server_name rendezvous.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:8788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

### Caddy Example

```caddy
rendezvous.example.com {
    reverse_proxy localhost:8788
}
```

### Cloudflare Tunnel

```bash
cloudflared tunnel --url ws://localhost:8788
```

## Scaling Considerations

### Horizontal Scaling

The rendezvous server is **stateful** — each daemon/client pair must connect to the same instance. To scale horizontally:

1. **Use a load balancer with sticky sessions** (session affinity) based on the token query parameter
2. **Or shard by token** — route tokens starting with `a-f` to instance 1, `g-m` to instance 2, etc.
3. **Or use a single instance** — a single Node.js process can handle thousands of concurrent splices

### Resource Requirements

| Metric | Typical | Max |
|--------|---------|-----|
| Memory | 50 MB base + 100 KB per active splice | 1 GB for 10k splices |
| CPU | Low (I/O bound) | 1 core per 5k active splices |
| Connections | Unlimited (OS limits apply) | Tune `ulimit -n` |

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rendezvous
spec:
  replicas: 1  # Stateful — scale carefully
  selector:
    matchLabels:
      app: rendezvous
  template:
    metadata:
      labels:
        app: rendezvous
    spec:
      containers:
        - name: rendezvous
          image: agentproto/rendezvous:latest
          ports:
            - containerPort: 8788
          env:
            - name: RENDEZVOUS_PORT
              value: "8788"
            - name: RENDEZVOUS_IDLE_TIMEOUT_MS
              value: "900000"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8788
            initialDelaySeconds: 5
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8788
            initialDelaySeconds: 2
            periodSeconds: 10
          resources:
            requests:
              memory: "64Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "1000m"
---
apiVersion: v1
kind: Service
metadata:
  name: rendezvous
spec:
  selector:
    app: rendezvous
  ports:
    - port: 8788
      targetPort: 8788
```

## Security Considerations

1. **The broker is untrusted by design** — it only sees ciphertext, tokens, IPs, sizes, and timing
2. **Tokens are single-use** — once a pair splices, the token cannot be reused until the splice closes
3. **Rate limiting** — configure `RENDEZVOUS_RATE_LIMIT_MAX` to prevent abuse
4. **No plaintext** — the broker cannot read or forge traffic
5. **Run as non-root** — the Docker image runs as UID 1001

## Monitoring

### Metrics

The server exposes basic stats via the `/healthz` endpoint:

- `parked`: Number of sockets waiting for their peer
- `active`: Number of active splices

### Logging

Set `RENDEZVOUS_DEBUG=true` for verbose logging. Logs are written to stderr.

### Prometheus (future)

Metrics endpoint for Prometheus scraping is planned. For now, parse `/healthz` or use the Node.js `process.stats`.

## Troubleshooting

### Connection refused

- Check the server is listening on the correct port and host
- Verify firewalls/security groups allow WebSocket connections

### Token in use

- A token can only have one active splice at a time
- Wait for the previous splice to close, or generate a new token

### Park timeout

- A socket that waits longer than `RENDEZVOUS_PARK_TIMEOUT_MS` without its peer will be closed
- Ensure both daemon and client dial within the timeout window

### Idle timeout

- Splices with no traffic for `RENDEZVOUS_IDLE_TIMEOUT_MS` will be torn down
- Send keepalive traffic to prevent this, or increase the timeout

## Support

- GitHub Issues: https://github.com/agentproto/ts/issues
- Documentation: https://agentproto.sh
