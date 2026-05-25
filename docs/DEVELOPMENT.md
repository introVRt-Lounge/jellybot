# Development vs production

Jellybot uses a **two-tree** layout on the operator host:

| Path | Role |
|------|------|
| `~/coding/jellybot-dev` | Git checkout — edit code, run tests, `make dev-refresh` with local image build |
| `~/docker/jellybot` | Production deploy — **GHCR image only**, Watchtower, persistent data |

The GitHub repo stays **`introVRt-Lounge/jellybot`**. The `-dev` suffix is **local only** so prod compose never shares a working directory with bind-mounted source.

## Development (`~/coding/jellybot-dev`)

```bash
git clone https://github.com/introVRt-Lounge/jellybot.git ~/coding/jellybot-dev
cd ~/coding/jellybot-dev
cp .env.example .env
bun install
make test
make dev-refresh    # builds jellybot:runtime locally; container name jellybot-dev optional
make health
```

Optional `docker-compose.override.yml` (gitignored) for host-specific mounts:

- Subtitle DB: `JELLYBOT_DATA_HOST_DIR=/home/heavygee/docker/jellybot/data` (shared with prod data)
- Jellyfin on Docker network: `JELLYFIN_URL=http://jellyfin:8096`, `traefik_net` external network
- Clips: SMB or local bind under `/var/lib/jellybot/clips`

**Do not run a long-lived `jellybot` container from the dev checkout in production.** Use `make test` / short-lived compose profiles for parity checks.

## Production (`~/docker/jellybot`)

Only one container named **`jellybot`** should run on the host.

```bash
cd ~/docker/jellybot
docker compose pull
docker compose up -d --force-recreate
curl -fsS http://127.0.0.1:8080/healthz | jq .
```

Compose uses:

- `image: ghcr.io/introvrt-lounge/jellybot:latest`
- `com.centurylinklabs.watchtower.enable=true`
- `com.centurylinklabs.watchtower.scope=minutely`
- Bind mounts: `./data` (subtitle index + bot state), clips path on host
- `.env` with secrets (never commit)

### Automagic deploy chain

1. Conventional commit merged to `main`
2. CI builds and pushes GHCR (`:main`, `:sha-*`; `:latest` on major/minor release tags)
3. Watchtower (minutely scope) recreates `jellybot` when `:latest` digest changes
4. Bot **`ClientReady`** one-shot checks GitHub Releases and announces major/minor to `#botspam`

Patch releases update GitHub but do **not** move `:latest` — silent until the next major/minor Watchtower cycle.

## First-time prod bootstrap

1. Create `~/docker/jellybot/data` (uid **1001** for SQLite WAL)
2. Copy `.env` from dev checkout; add `GITHUB_TOKEN`, `NOTIFICATION_CHANNEL_ID`
3. Copy `deploy/prod/docker-compose.host.example.yml` to `~/docker/jellybot/docker-compose.yml` and adjust paths
4. `docker login ghcr.io` (Watchtower uses host credentials for private packages)
5. Stop any dev-checkout `jellybot` container before starting prod

## Rollback

Pin image in `~/docker/jellybot/docker-compose.yml` to a semver or `sha-*` tag, then:

```bash
docker compose pull && docker compose up -d --force-recreate
```

Restore `:latest` when ready for Watchtower again.
