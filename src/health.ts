export type HealthState = {
  discordReady: boolean;
  jellyfinUser?: string;
  subtitleIndex?: {
    itemCount: number;
    cueCount: number;
    lastIndexedAt: string | null;
  } | null;
};

export function startHealthServer(
  port: number,
  appVersion: string,
  getState: () => HealthState,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path !== "/healthz" && path !== "/health") {
        return new Response("Not Found", { status: 404 });
      }

      const state = getState();
      const body = {
        status: state.discordReady ? "ok" : "starting",
        service: "jellybot",
        version: appVersion,
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
