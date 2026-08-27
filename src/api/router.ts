import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import { planClipRequest } from "../services/clip-request.ts";
import {
  filterClipKinds,
  searchMediaSuggestions,
  type MediaSuggestion,
} from "../services/media-search-service.ts";
import {
  minQuoteQueryLength,
  searchQuoteSeriesNames,
  searchQuoteSuggestions,
} from "../services/quote-search-service.ts";
import type { MediaKind } from "../jellyfin.ts";
import { clientIp, FixedWindowRateLimiter } from "./rate-limit.ts";
import { PreviewStore } from "./preview-store.ts";
import { renderClipPreviewRequest, renderQuotePreview } from "./render-preview.ts";
import {
  dmcaNtfyTitle,
  formatDmcaNtfyPayload,
  isDmcaHoneypot,
  parseDmcaReportBody,
} from "./dmca-report.ts";
import { publishNtfy } from "./ntfy-publish.ts";

export type WebApiRouterConfig = Pick<
  AppConfig,
  | "webApiEnabled"
  | "webApiCorsOrigins"
  | "webApiPreviewTtlMs"
  | "webApiMaxPreviewMb"
  | "webApiRateLimitSuggestPerMinute"
  | "webApiRateLimitPreviewPerHour"
  | "webApiDmcaRateLimitWindowMs"
  | "webApiDmcaRateLimitMax"
  | "webApiDmcaNtfyTopic"
  | "ntfyServer"
  | "ntfyUser"
  | "ntfyPassword"
  | "clipTempDir"
  | "maxClipSeconds"
  | "maxClipMb"
  | "audioLanguages"
  | "subtitleLanguages"
  | "subtitleDbPath"
  | "subtitleDefaultClipSeconds"
  | "subtitleQuotePaddingSeconds"
  | "watermarkPath"
>;

export type WebApiRouterDeps = {
  config: WebApiRouterConfig;
  jellyfin: JellyfinClient;
  previewStore?: PreviewStore;
  suggestLimiter?: FixedWindowRateLimiter;
  previewLimiter?: FixedWindowRateLimiter;
  dmcaLimiter?: FixedWindowRateLimiter;
};

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function parseMediaKind(raw: string | null): MediaKind | null {
  if (raw === "movie" || raw === "tv") return raw;
  return null;
}

export function createWebApiRouter(deps: WebApiRouterDeps) {
  const previewStore =
    deps.previewStore ?? new PreviewStore(deps.config.webApiPreviewTtlMs);
  const suggestLimiter =
    deps.suggestLimiter ??
    new FixedWindowRateLimiter(deps.config.webApiRateLimitSuggestPerMinute, 60_000);
  const previewLimiter =
    deps.previewLimiter ??
    new FixedWindowRateLimiter(deps.config.webApiRateLimitPreviewPerHour, 60 * 60_000);
  const dmcaLimiter =
    deps.dmcaLimiter ??
    new FixedWindowRateLimiter(
      deps.config.webApiDmcaRateLimitMax,
      deps.config.webApiDmcaRateLimitWindowMs,
    );

  function corsHeaders(request: Request): Headers {
    const headers = new Headers();
    const origin = request.headers.get("origin");
    if (origin && deps.config.webApiCorsOrigins.includes(origin)) {
      headers.set("access-control-allow-origin", origin);
      headers.set("vary", "Origin");
      headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
      headers.set("access-control-allow-headers", "content-type");
    }
    return headers;
  }

  function withCors(request: Request, response: Response): Response {
    const headers = new Headers(response.headers);
    for (const [key, value] of corsHeaders(request)) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  async function handle(request: Request): Promise<Response | null> {
    if (!deps.config.webApiEnabled) {
      return null;
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/")) {
      return null;
    }

    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204 }));
    }

    const ip = clientIp(request);

    try {
      if (request.method === "GET" && url.pathname === "/api/v1/meta") {
        return withCors(
          request,
          json({
            service: "jellybot-web-api",
            version: 1,
            endpoints: [
              "GET /api/v1/quote/suggest",
              "GET /api/v1/quote/series",
              "POST /api/v1/quote/preview",
              "GET /api/v1/clip/kinds",
              "GET /api/v1/clip/media",
              "POST /api/v1/clip/preview",
              "GET /api/v1/previews/:id",
              "POST /api/v1/dmca/report",
            ],
          }),
        );
      }

      if (request.method === "POST" && url.pathname === "/api/v1/dmca/report") {
        if (!deps.config.webApiDmcaNtfyTopic || !deps.config.ntfyServer) {
          return withCors(
            request,
            json({ error: "DMCA reporting is not configured." }, { status: 503 }),
          );
        }

        if (!dmcaLimiter.allow(`dmca:${ip}`)) {
          return withCors(request, json({ error: "Rate limit exceeded." }, { status: 429 }));
        }

        const parsed = parseDmcaReportBody(await request.json().catch(() => ({})));
        if (!parsed.ok) {
          return withCors(request, json({ error: parsed.error }, { status: 400 }));
        }

        if (isDmcaHoneypot(parsed.report)) {
          return withCors(request, json({ ok: true }));
        }

        try {
          await publishNtfy({
            server: deps.config.ntfyServer,
            topic: deps.config.webApiDmcaNtfyTopic,
            title: dmcaNtfyTitle(parsed.report),
            body: formatDmcaNtfyPayload(parsed.report, ip),
            user: deps.config.ntfyUser,
            password: deps.config.ntfyPassword,
          });
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "web_api.dmca_delivery_failed",
              error: error instanceof Error ? error.message : "unknown error",
            }),
          );
          return withCors(request, json({ error: "delivery_failed" }, { status: 502 }));
        }

        console.info(
          JSON.stringify({
            event: "web_api.dmca_reported",
            kind: parsed.report.kind,
            clientIp: ip,
          }),
        );

        return withCors(request, json({ ok: true }));
      }

      if (request.method === "GET" && url.pathname === "/api/v1/quote/suggest") {
        if (!suggestLimiter.allow(`suggest:${ip}`)) {
          return withCors(request, json({ error: "Rate limit exceeded." }, { status: 429 }));
        }

        const query = url.searchParams.get("q") ?? "";
        const series = url.searchParams.get("series") ?? undefined;
        const suggestions = searchQuoteSuggestions(deps.config.subtitleDbPath, query, {
          seriesFilter: series,
        });

        return withCors(
          request,
          json({
            query,
            series: series ?? null,
            minQueryLength: minQuoteQueryLength(series),
            suggestions,
          }),
        );
      }

      if (request.method === "GET" && url.pathname === "/api/v1/quote/series") {
        if (!suggestLimiter.allow(`series:${ip}`)) {
          return withCors(request, json({ error: "Rate limit exceeded." }, { status: 429 }));
        }

        const prefix = url.searchParams.get("q") ?? "";
        const series = searchQuoteSeriesNames(deps.config.subtitleDbPath, prefix);
        return withCors(request, json({ query: prefix, series }));
      }

      if (request.method === "GET" && url.pathname === "/api/v1/clip/kinds") {
        const query = url.searchParams.get("q") ?? "";
        return withCors(request, json({ kinds: filterClipKinds(query) }));
      }

      if (request.method === "GET" && url.pathname === "/api/v1/clip/media") {
        if (!suggestLimiter.allow(`media:${ip}`)) {
          return withCors(request, json({ error: "Rate limit exceeded." }, { status: 429 }));
        }

        const kind = parseMediaKind(url.searchParams.get("kind"));
        const query = url.searchParams.get("q") ?? "";
        if (!kind) {
          return withCors(
            request,
            json({ error: "Query param kind must be movie or tv." }, { status: 400 }),
          );
        }

        const suggestions: MediaSuggestion[] = await searchMediaSuggestions(
          deps.jellyfin,
          kind,
          query,
        );
        return withCors(request, json({ kind, query, suggestions }));
      }

      if (request.method === "POST" && url.pathname === "/api/v1/quote/preview") {
        if (!previewLimiter.allow(`preview:${ip}`)) {
          return withCors(request, json({ error: "Rate limit exceeded." }, { status: 429 }));
        }

        const body = (await request.json()) as {
          match?: string;
          duration?: string;
          padding?: string;
          series?: string;
          subtitles?: boolean;
        };

        if (!body.match?.trim()) {
          return withCors(request, json({ error: "match is required." }, { status: 400 }));
        }

        const result = await renderQuotePreview(
          { jellyfin: deps.jellyfin, config: deps.config, previewStore },
          {
            matchToken: body.match,
            durationRaw: body.duration,
            paddingRaw: body.padding,
            seriesFilter: body.series,
            burnInSubtitles: body.subtitles,
          },
        );

        if (!result.ok) {
          return withCors(request, json({ error: result.message }, { status: result.status }));
        }

        return withCors(request, json(result));
      }

      if (request.method === "POST" && url.pathname === "/api/v1/clip/preview") {
        if (!previewLimiter.allow(`preview:${ip}`)) {
          return withCors(request, json({ error: "Rate limit exceeded." }, { status: 429 }));
        }

        const body = (await request.json()) as {
          kind?: MediaKind;
          itemId?: string;
          start?: string;
          end?: string;
          duration?: string;
          subtitles?: boolean;
        };

        const kind = parseMediaKind(body.kind ?? null);
        if (!kind) {
          return withCors(request, json({ error: "kind must be movie or tv." }, { status: 400 }));
        }

        const planned = planClipRequest({
          kind,
          itemId: body.itemId ?? "",
          startRaw: body.start,
          endRaw: body.end,
          durationRaw: body.duration,
          maxClipSeconds: deps.config.maxClipSeconds,
        });

        if (!planned.ok) {
          return withCors(request, json({ error: planned.message }, { status: 400 }));
        }

        const result = await renderClipPreviewRequest(
          { jellyfin: deps.jellyfin, config: deps.config, previewStore },
          { plan: planned.plan, burnInSubtitles: body.subtitles },
        );

        if (!result.ok) {
          return withCors(request, json({ error: result.message }, { status: result.status }));
        }

        return withCors(request, json(result));
      }

      const previewMatch = url.pathname.match(/^\/api\/v1\/previews\/([^/]+)$/);
      if (request.method === "GET" && previewMatch) {
        const previewId = previewMatch[1]!;
        const record = previewStore.get(previewId);
        if (!record) {
          return withCors(request, json({ error: "Preview not found or expired." }, { status: 404 }));
        }

        const file = await readFile(record.filePath);
        const headers = corsHeaders(request);
        headers.set("content-type", record.contentType);
        headers.set(
          "content-disposition",
          `inline; filename="${record.fileName.replace(/"/g, "")}"`,
        );
        headers.set("cache-control", "private, max-age=60");
        return new Response(file, { status: 200, headers });
      }

      return withCors(request, json({ error: "Not found." }, { status: 404 }));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "web_api.error",
          path: url.pathname,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return withCors(request, json({ error: "Internal server error." }, { status: 500 }));
    }
  }

  return { handle, previewStore };
}

export function createWebApiHandler(deps: WebApiRouterDeps): (request: Request) => Promise<Response | null> {
  const router = createWebApiRouter(deps);
  return (request) => router.handle(request);
}
