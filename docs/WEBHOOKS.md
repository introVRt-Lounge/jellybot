# Event-driven indexer kick (webhooks)

Jellybot exposes three webhook endpoints that turn Radarr / Sonarr / Bazarr Connect events into a targeted, single-item subtitle index run within ~30 seconds of a file or sub drop. This replaces the "wait until next 09:00 cron" lag that the bulk incremental indexer imposes.

The cron stays as a safety net - webhooks are fire-and-forget, so if a delivery is missed the daily scan still picks the work up.

## How it fits together

```
Radarr / Sonarr / Bazarr      jellybot:8080
+--------------------+        +-------------------+
| Connect: Webhook   | -POST-> /hooks/<source>
+--------------------+        |                   |
                              | parse -> kick -> debounce(30s) -> dispatch
                              |   1. trigger Jellyfin library refresh
                              |   2. poll Jellyfin for the item by tmdb/tvdb
                              |   3. force per-item refresh (bumps dateLastRefreshed)
                              |   4. run indexJellyfinItem(itemId)
                              +-------------------+
```

Each event is logged as JSON on stdout (`webhook.received`, `webhook.dispatch.indexed`, etc.) so you can correlate every Connect ping with what the indexer actually did.

## Configuration

In `~/docker/jellybot/.env`:

```bash
# Required to enable webhooks. Anything strong + URL-safe.
WEBHOOK_SHARED_SECRET=<long-random-token>

# Optional tuning (defaults shown):
# WEBHOOK_DEBOUNCE_SECONDS=30
# WEBHOOK_POLL_MAX_ATTEMPTS=12
# WEBHOOK_POLL_INTERVAL_SECONDS=10
# WEBHOOK_POST_REFRESH_SETTLE_MS=1500
```

If `WEBHOOK_SHARED_SECRET` is unset the entire `/hooks/*` surface returns 404 - useful as a hard kill switch.

After changing env, recreate the container so the new secret loads:

```bash
cd ~/docker/jellybot && docker compose up -d
```

## Connect URLs (inside the Docker network)

Radarr / Sonarr / Bazarr all sit on the same `traefik_net` network as jellybot, so use the service hostname rather than going through the host:

| Source | URL |
|---|---|
| Radarr | `http://jellybot:8080/hooks/radarr?token=<WEBHOOK_SHARED_SECRET>` |
| Sonarr | `http://jellybot:8080/hooks/sonarr?token=<WEBHOOK_SHARED_SECRET>` |
| Bazarr | `http://jellybot:8080/hooks/bazarr?token=<WEBHOOK_SHARED_SECRET>` |

If a product doesn't share the network, swap the host to `http://<docker-host>:8080/...` - just be aware that port 8080 is bound to `0.0.0.0` for the health endpoint, and your shared secret is the only thing protecting the surface from anyone on that network.

## Radarr setup

Settings -> Connect -> "+" -> Webhook:

- **Name:** Jellybot
- **URL:** `http://jellybot:8080/hooks/radarr?token=<secret>`
- **Method:** POST
- **Triggers (only check these):**
  - On Import / On File Import
  - On Movie File Delete
  - On Movie File Delete For Upgrade (if shown)
  - On Rename (optional - covers manual renames)
- **Tags:** leave empty (catch-all).
- **Test** should produce a 200 with `{"status":"ignored","source":"radarr"}` (Radarr sends `eventType: "Test"`, which the bot logs and drops).

## Sonarr setup

Settings -> Connect -> "+" -> Webhook:

- **Name:** Jellybot
- **URL:** `http://jellybot:8080/hooks/sonarr?token=<secret>`
- **Method:** POST
- **Triggers:**
  - On Import / On File Import
  - On Episode File Delete
  - On Episode File Delete For Upgrade
  - On Rename (optional)
- **Tags:** leave empty.

Test should return `status:"ignored"` for the same reason as Radarr.

## Bazarr setup

Bazarr's webhook surface is less standardised. Settings -> Notifications -> Custom -> add a new entry pointing to `http://jellybot:8080/hooks/bazarr?token=<secret>`. The Bazarr parser accepts whichever shape your install sends - it routes to a movie kick if it sees `tmdbId`/`imdbId`, or an episode kick if it sees `tvdbId` + season + episode.

If Bazarr is delivering a payload the bot doesn't recognise you'll see a `webhook.ignored` log line with the raw `eventType`. Capture that and we can add explicit support.

## Verifying it works

Tail the bot logs and trigger a webhook by clicking "Test" in any of the products:

```bash
docker logs -f jellybot 2>&1 | grep webhook
```

You should see:

- `webhook.received` (with `eventType:"Test"`) immediately on send.
- `webhook.ignored` because we deliberately drop Test events.

Then drop a real file (or use the Radarr "Search now" / "Manual Import" actions) and watch for:

- `webhook.received` -> `webhook.dispatch.indexed` (with `cueCount`).
- The new cues become searchable in `/quote` autocomplete within ~60s of the kick landing.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 Unauthorized` | Token mismatch | Re-paste the secret; URL-encode special chars or use the `X-Webhook-Token` header instead. |
| `404 Webhooks disabled (no shared secret configured)` | `WEBHOOK_SHARED_SECRET` is unset | Set it in `~/docker/jellybot/.env` and recreate the container. |
| `webhook.dispatch.item_not_found` | Jellyfin hadn't scanned the new file before our poll window expired | Increase `WEBHOOK_POLL_MAX_ATTEMPTS` or check that Radarr's "Connect to Jellyfin" Connect entry is configured. |
| `webhook.dispatch.skipped reason:no_cues` | Item exists but has only image-based subs (PGS / VobSub) | Run the pgs-to-srt OCR fallback or wait for Bazarr to fetch a text track, then the Bazarr webhook will retrigger. |
| Repeated `webhook.received` events for the same item produce only one `webhook.dispatch.indexed` | Working as designed - the dispatcher coalesces inside a 30s window. |
