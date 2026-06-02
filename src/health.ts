import type { WebhookDispatcher } from "./webhooks/dispatch.ts";
import { tryHandleWebhook, type WebhookRouterConfig } from "./webhooks/router.ts";

export type HealthState = {
  discordReady: boolean;
  jellyfinUser?: string;
  subtitleIndex?: {
    itemCount: number;
    cueCount: number;
    lastIndexedAt: string | null;
  } | null;
  releaseTag?: string | null;
};

export type StartHealthServerOptions = {
  /** Optional webhook receiver. When undefined, /hooks/* returns 404. */
  webhooks?: {
    config: WebhookRouterConfig;
    dispatcher: WebhookDispatcher;
  };
};

export function startHealthServer(
  port: number,
  appVersion: string,
  getState: () => HealthState,
  options: StartHealthServerOptions = {},
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "0.0.0.0",
    port,
    async fetch(request) {
      // Webhook routes get first crack so /hooks/radarr etc. don't fall
      // through to the health 404 path.
      if (options.webhooks) {
        const handled = await tryHandleWebhook(
          request,
          options.webhooks.config,
          options.webhooks.dispatcher,
        );
        if (handled) return handled;
      }

      const path = new URL(request.url).pathname;
      if (path !== "/healthz" && path !== "/health") {
        return new Response("Not Found", { status: 404 });
      }

      const state = getState();
      const body = {
        status: state.discordReady ? "ok" : "starting",
        service: "jellybot",
        version: state.releaseTag ?? appVersion,
        appVersion,
        releaseTag: state.releaseTag ?? null,
        discord: state.discordReady ? "connected" : "starting",
        jellyfinUser: state.jellyfinUser ?? null,
        subtitleIndex: state.subtitleIndex ?? null,
      };

      return Response.json(body, {
        status: state.discordReady ? 200 : 503,
      });
    },
  });
}
