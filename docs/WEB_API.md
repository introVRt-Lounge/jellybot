# Web API (try-it surface)

When `WEB_API_ENABLED=1`, jellybot exposes a JSON REST API on the health port alongside `/healthz`.

## Enable

```env
WEB_API_ENABLED=1
WEB_API_CORS_ORIGINS=https://jellybot.introvrtlounge.com,http://127.0.0.1:8788
WEB_API_PREVIEW_TTL_MS=900000
WEB_API_MAX_PREVIEW_MB=50
WEB_API_RATE_LIMIT_SUGGEST_PER_MIN=60
WEB_API_RATE_LIMIT_PREVIEW_PER_HOUR=10
```

## Ingress

| Surface | Host | Backend |
| --- | --- | --- |
| Marketing UI | `jellybot.introvrtlounge.com` | Cloudflare Pages (`web/`) |
| Web API | `api.jellybot.introvrtlounge.com` | Traefik → `jellybot:8080` |

The static site reads `web/config.js` for the API base URL.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/meta` | Capability discovery |
| GET | `/api/v1/quote/suggest?q=` | Quote autocomplete (optional `series=`) |
| GET | `/api/v1/quote/series?q=` | TV series filter autocomplete |
| POST | `/api/v1/quote/preview` | Render a quote clip preview (`match` token required) |
| GET | `/api/v1/clip/kinds?q=` | Movie/TV kind filter |
| GET | `/api/v1/clip/media?kind=&q=` | Jellyfin media autocomplete |
| POST | `/api/v1/clip/preview` | Render a manual clip preview |
| GET | `/api/v1/previews/:id` | Stream a short-lived MP4 preview |

## DMCA reports

When `WEB_API_DMCA_NTFY_TOPIC` and `NTFY_SERVER` are set:

| Method | Path |
| --- | --- |
| POST | `/api/v1/dmca/report` |

Publishes to ntfy (see [DMCA.md](DMCA.md)). Modeled on `gavinc-contact-bridge` in server-setup compose/core.


## Architecture note

Discord handlers and the web API share the same service layer:

- `src/services/quote-search-service.ts` — subtitle FTS suggestions
- `src/services/media-search-service.ts` — Jellyfin media suggestions
- `src/api/render-preview.ts` — ffmpeg render + preview store

Discord remains the primary guild UX; the web surface is for marketing try-it and operator verification.
