# Copyright / DMCA (public demo)

Jellybot is **self-hosted** software. IntroVRt Lounge also runs a **public try-it demo** that can render short previews from an indexed library.

## How reports are delivered

Same estate pattern as **[gavincowie.com](https://gavincowie.com/#contact)**:

| Piece | gavincowie.com | Jellybot |
| --- | --- | --- |
| Static form | Hugo site contact section | `web/dmca.html` |
| Ingest API | `POST /api/contact` on gavincowie.com | `POST /api/v1/dmca/report` on jellybot web API |
| Bridge | `gavinc-contact-bridge` (Flask, compose/core) | Built into jellybot (`src/api/dmca-report.ts`) |
| ntfy topic | `gavinc-site-contact` | `jellybot-dmca` (configurable) |

No mailbox required — subscribe to the ntfy topic on your phone (Quest / ntfy app).

## Enable on prod jellybot

```env
WEB_API_ENABLED=1
WEB_API_DMCA_NTFY_TOPIC=jellybot-dmca
NTFY_SERVER=https://ntfy.tail9944ee.ts.net
NTFY_USER=...
NTFY_PASSWORD=...
```

Rate limit defaults: **5 reports / 15 minutes / IP** (`WEB_API_DMCA_RATE_LIMIT_*`).

## Scope

| In scope | Out of scope |
| --- | --- |
| Public try-it previews at `jellybot.introvrtlounge.com` | Clips on Discord servers you do not operate |
| Preview URLs on `api.jellybot.introvrtlounge.com` | Self-hosted Jellybot instances run by third parties |

## Public page

`/dmca.html` on the Cloudflare Pages marketing site posts to the web API.

## Handling (v1)

Manual triage from the ntfy notification:

1. Validate notice completeness
2. Disable preview URL(s) if supplied
3. Suppress matching demo index entries where feasible
4. Reply to reporter email if follow-up is needed (operator client, not jellybot)

## Reference implementation

- Bridge: `~/coding/server-setup/compose/core/gavinc-contact-bridge/app.py`
- Frontend: `~/coding/gavincowie-site/static/js/site.js`
- Runbook row: `server-setup/docs/runbooks/domain-register.md` (`gavincowie.com/api/contact`)
