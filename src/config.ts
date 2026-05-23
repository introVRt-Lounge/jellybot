export type AppConfig = {
  discordToken: string;
  discordClientId: string;
  discordGuildId?: string;
  jellyfinUrl: string;
  jellyfinUsername: string;
  jellyfinPassword: string;
  maxClipSeconds: number;
  maxClipMb: number;
  healthPort: number;
  appVersion: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    discordToken: requireEnv(env, "DISCORD_TOKEN"),
    discordClientId: requireEnv(env, "DISCORD_CLIENT_ID"),
    discordGuildId: env.DISCORD_GUILD_ID?.trim() || undefined,
    jellyfinUrl: (env.JELLYFIN_URL ?? "http://127.0.0.1:8096").replace(/\/+$/, ""),
    jellyfinUsername: requireEnv(env, "JELLYFIN_USERNAME"),
    jellyfinPassword: requireEnv(env, "JELLYFIN_PASSWORD"),
    maxClipSeconds: Number(env.MAX_CLIP_SECONDS ?? 120),
    maxClipMb: Number(env.MAX_CLIP_MB ?? 24),
    healthPort: Number(env.HEALTH_PORT ?? 8080),
    appVersion: env.APP_VERSION?.trim() || "dev",
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
