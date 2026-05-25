FROM oven/bun:1.3.11 AS deps

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.11 AS test

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests

USER bun

CMD ["bun", "run", "ci"]

FROM oven/bun:1.3.11 AS runtime

ARG APP_VERSION=dev
ARG GIT_SHA=unknown

LABEL org.opencontainers.image.title="jellybot" \
      org.opencontainers.image.description="Discord bot for Jellyfin video clips" \
      org.opencontainers.image.source="https://github.com/introVRt-Lounge/jellybot" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production \
    BUN_ENV=production \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    HEALTH_PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /usr/sbin/nologin jellybot \
    && mkdir -p /var/lib/jellybot/clips /var/lib/jellybot/data \
    && chown -R jellybot:jellybot /var/lib/jellybot

WORKDIR /app

COPY --from=deps --chown=jellybot:jellybot /app/node_modules ./node_modules
COPY --chown=jellybot:jellybot package.json bun.lock tsconfig.json ./
COPY --chown=jellybot:jellybot src ./src

USER jellybot

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]
