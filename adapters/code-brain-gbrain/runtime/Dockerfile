# gbrain (garrytan/gbrain) pilot image — Bun-native, no npm CLI exists.
# The public npm `gbrain` package is an UNRELATED project (stormcolor/gbrain,
# a GPU ML lib) — install strictly from GitHub source.
FROM oven/bun:1
RUN apt-get update && apt-get install -y git ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN bun install -g github:garrytan/gbrain
ENV PATH="/root/.bun/bin:${PATH}" HOME=/brain
WORKDIR /brain
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY entrypoint-pg.sh /usr/local/bin/entrypoint-pg.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/entrypoint-pg.sh
EXPOSE 3131
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -sf http://127.0.0.1:3131/health || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
