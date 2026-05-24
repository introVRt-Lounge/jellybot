export type AppConfig = {
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  discordGuildIds: string[];
  jellyfinUrl: string;
  jellyfinUsername: string;
  jellyfinPassword: string;
  jellyfinMoviesLibraryId: string;
  jellyfinTvLibraryId: string;
  maxClipSeconds: number;
  maxClipMb: number;
  healthPort: number;
  appVersion: string;
  clipTempDir: string;
  subtitleDbPath: string;
  subtitleLanguages: string;
  subtitleDefaultClipSeconds: number;
  subtitleQuotePaddingSeconds: number;
  subtitleIndexConcurrency: number;
  subtitleIndexOnStartup: "off" | "incremental";
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    discordToken: requireEnv(env, "DISCORD_TOKEN"),
    discordClientId: requireEnv(env, "DISCORD_CLIENT_ID"),
    discordGuildId: env.DISCORD_GUILD_ID?.trim() || undefined,
    discordGuildIds: parseGuildIds(env),
    jellyfinUrl: (env.JELLYFIN_URL ?? "http://127.0.0.1:8096").replace(/\/+$/, ""),
    jellyfinUsername: requireEnv(env, "JELLYFIN_USERNAME"),
    jellyfinPassword: requireEnv(env, "JELLYFIN_PASSWORD"),
    jellyfinMoviesLibraryId: requireEnv(env, "JELLYFIN_MOVIES_LIBRARY_ID"),
    jellyfinTvLibraryId: requireEnv(env, "JELLYFIN_TV_LIBRARY_ID"),
    maxClipSeconds: Number(env.MAX_CLIP_SECONDS ?? 180),
    maxClipMb: Number(env.MAX_CLIP_MB ?? 9),
    healthPort: Number(env.HEALTH_PORT ?? 8080),
    appVersion: env.APP_VERSION?.trim() || "dev",
    clipTempDir: env.JELLYBOT_CLIP_DIR?.trim() || "/var/lib/jellybot/clips",
    subtitleDbPath: env.SUBTITLE_DB_PATH?.trim() || "/var/lib/jellybot/data/subtitles.db",
    subtitleLanguages: env.SUBTITLE_LANGUAGES?.trim() || "eng,en",
    subtitleDefaultClipSeconds: Number(env.SUBTITLE_DEFAULT_CLIP_SECONDS ?? 15),
    subtitleQuotePaddingSeconds: Number(env.SUBTITLE_QUOTE_PADDING_SECONDS ?? 2),
    subtitleIndexConcurrency: Number(env.SUBTITLE_INDEX_CONCURRENCY ?? 4),
    subtitleIndexOnStartup:
      env.SUBTITLE_INDEX_ON_STARTUP?.trim().toLowerCase() === "off" ? "off" : "incremental",
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseGuildIds(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const raw of [env.DISCORD_GUILD_ID, env.DISCORD_GUILD_IDS]) {
    for (const part of (raw ?? "").split(",")) {
      const guildId = part.trim();
      if (guildId) values.add(guildId);
    }
  }
  return [...values];
}
