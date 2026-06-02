import { parseBazarrWebhook, parseRadarrWebhook, parseSonarrWebhook } from "./parsers.ts";
import type { WebhookDispatcher } from "./dispatch.ts";
import type { WebhookKick } from "./types.ts";

export type WebhookRouterConfig = {
  /**
   * Required token for inbound webhooks. Compared against the
   * `X-Webhook-Token` header or `?token=` query string. Empty string disables
   * the entire webhook surface (router returns 404).
   */
  sharedSecret: string;
};

const HOOK_PATH_PREFIX = "/hooks/";

const PARSERS: Record<string, (raw: unknown) => WebhookKick | null> = {
  radarr: parseRadarrWebhook,
  sonarr: parseSonarrWebhook,
  bazarr: parseBazarrWebhook,
};

/**
 * If the request matches a webhook route, handle it and return a Response.
 * If it's not a webhook route, return null so the caller (health server) can
 * route /healthz / 404 normally.
 *
 * Handles:
 * - POST /hooks/radarr | /hooks/sonarr | /hooks/bazarr
 * - GET / HEAD on the same paths return 200 with a small status body so
 *   Connect "Test" buttons see a happy response without ever exercising the
 *   indexer.
 */
export async function tryHandleWebhook(
  request: Request,
  config: WebhookRouterConfig,
  dispatcher: WebhookDispatcher,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(HOOK_PATH_PREFIX)) return null;

  if (!config.sharedSecret) {
    return new Response("Webhooks disabled (no shared secret configured).", { status: 404 });
  }

  const source = url.pathname.slice(HOOK_PATH_PREFIX.length).split("/")[0]?.toLowerCase() ?? "";
  const parser = PARSERS[source];
  if (!parser) {
    return new Response(`Unknown webhook source: ${source}`, { status: 404 });
  }

  // GET / HEAD = liveness ping. Auth-gated so we don't leak "I exist" without
  // a token, but the body is small + safe.
  if (request.method === "GET" || request.method === "HEAD") {
    if (!authenticate(request, url, config.sharedSecret)) {
      return new Response("Unauthorized", { status: 401 });
    }
    return Response.json({ status: "ready", source });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!authenticate(request, url, config.sharedSecret)) {
    console.warn(
      JSON.stringify({
        event: "webhook.auth_failed",
        source,
        path: url.pathname,
      }),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "webhook.bad_json",
        source,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    return new Response("Invalid JSON", { status: 400 });
  }

  const kick = parser(payload);
  if (!kick) {
    console.info(
      JSON.stringify({
        event: "webhook.ignored",
        source,
        eventType: extractEventType(payload),
      }),
    );
    return Response.json({ status: "ignored", source });
  }

  const result = dispatcher.enqueue(kick);
  console.info(
    JSON.stringify({
      event: "webhook.received",
      source: kick.source,
      eventType: kick.eventType,
      kind: kick.kind,
      title: kick.title ?? null,
      tmdbId: kick.kind === "movie" ? kick.tmdbId ?? null : null,
      tvdbId: kick.kind === "episode" ? kick.tvdbId : null,
      seasonNumber: kick.kind === "episode" ? kick.seasonNumber : null,
      episodeNumber: kick.kind === "episode" ? kick.episodeNumber : null,
      deduped: result.ok && "deduped" in result ? result.deduped : false,
    }),
  );

  return Response.json({ status: "queued", deduped: "deduped" in result ? result.deduped : false });
}

function authenticate(request: Request, url: URL, secret: string): boolean {
  const header = request.headers.get("x-webhook-token") ?? request.headers.get("X-Webhook-Token");
  if (header && constantTimeEqual(header, secret)) return true;

  const queryToken = url.searchParams.get("token");
  if (queryToken && constantTimeEqual(queryToken, secret)) return true;

  return false;
}

/**
 * Length-checked compare. Not a full HMAC - shared-secret tokens don't
 * benefit much from constant-time compare against a network attacker since
 * they can already brute-force length via timing - but it's cheap and gives
 * us at least the easy hardening.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function extractEventType(payload: unknown): string | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const candidate = (payload as Record<string, unknown>).eventType;
    if (typeof candidate === "string") return candidate;
    const event = (payload as Record<string, unknown>).event;
    if (typeof event === "string") return event;
  }
  return null;
}
