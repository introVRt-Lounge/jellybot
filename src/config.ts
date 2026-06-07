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
  audioLanguages: string;
  subtitleDefaultClipSeconds: number;
  subtitleQuotePaddingSeconds: number;
  subtitleIndexConcurrency: number;
  subtitleIndexOnStartup: "off" | "incremental";
  githubToken?: string;
  notificationChannelId?: string;
  openaiApiKey?: string;
  releaseRepoOwner: string;
  releaseRepoName: string;
  releaseAnnounceGraceMs: number;
  botStateDbPath: string;
  featureSuggestionsChannelId?: string;
  featureTriageDiscordUserIds: string[];
  /** Maintainer ops alerts (pipeline stuck/failed). Never use feature suggestions / movies channel. */
  discordBotspamChannelId?: string;
  radarrUrl?: string;
  radarrApiKey?: string;
  radarrQualityProfileId?: number;
  radarrRootFolderPath?: string;
  /** Refuse acquisitions when the Radarr root folder has less than this many GB free (default 3). */
  radarrMinFreeGb: number;
  sonarrUrl?: string;
  sonarrApiKey?: string;
  sonarrQualityProfileId?: number;
  sonarrLanguageProfileId?: number;
  sonarrRootFolderPath?: string;
  /** Refuse acquisitions when the Sonarr root folder has less than this many GB free (default 3). */
  sonarrMinFreeGb: number;
  /**
   * Comma-separated case-insensitive substrings; any Sonarr root folder whose
   * path matches any of these is skipped during default selection. Use this to
   * keep the request flow away from special-purpose libraries.
   */
  sonarrExcludedRootKeywords: string[];
  /**
   * Shared secret required on every webhook POST. Compared against the
   * X-Webhook-Token header or ?token= query string. Empty/undefined disables
   * the entire webhook surface so /hooks/* returns 404.
   */
  webhookSharedSecret?: string;
  /** Coalesce window for repeated webhooks against the same item. */
  webhookDebounceMs: number;
  /** Cap on poll-for-item retries before we give up waiting on Jellyfin. */
  webhookPollMaxAttempts: number;
  /** Poll interval between item-lookup retries. */
  webhookPollIntervalMs: number;
  /** Pause after Jellyfin per-item refresh before reading media streams (ms). */
  webhookPostRefreshSettleMs: number;
  /** Hard ceiling on clips per supercut (#140). Applied even when the user requests more. */
  supercutMaxClips: number;
  /** Hard ceiling on aggregate supercut runtime in seconds (post-padding). */
  supercutMaxDurationSeconds: number;
  /** Padding (in ms) added either side of each cue when rendering a supercut clip. */
  supercutPaddingMs: number;
  /** Adjacent-cue merge window (ms) inside the same item. */
  supercutCoalesceGapMs: number;
  /** Hard ceiling on the final supercut mp4 size (MB) before Discord upload. */
  supercutMaxMb: number;
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
    audioLanguages: env.AUDIO_LANGUAGES?.trim() || env.SUBTITLE_LANGUAGES?.trim() || "eng,en",
    subtitleDefaultClipSeconds: Number(env.SUBTITLE_DEFAULT_CLIP_SECONDS ?? 15),
    subtitleQuotePaddingSeconds: Number(env.SUBTITLE_QUOTE_PADDING_SECONDS ?? 2),
    subtitleIndexConcurrency: Number(env.SUBTITLE_INDEX_CONCURRENCY ?? 4),
    subtitleIndexOnStartup:
      env.SUBTITLE_INDEX_ON_STARTUP?.trim().toLowerCase() === "off" ? "off" : "incremental",
    githubToken: env.GITHUB_TOKEN?.trim() || undefined,
    notificationChannelId: env.NOTIFICATION_CHANNEL_ID?.trim() || undefined,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    ...parseReleaseRepo(env),
    releaseAnnounceGraceMs: Number(env.RELEASE_ANNOUNCE_GRACE_MS ?? 60_000),
    botStateDbPath: env.BOT_STATE_DB_PATH?.trim() || "/var/lib/jellybot/data/bot-state.db",
    featureSuggestionsChannelId: env.FEATURE_SUGGESTIONS_CHANNEL_ID?.trim() || undefined,
    featureTriageDiscordUserIds: parseCsvIds(env.FEATURE_TRIAGE_DISCORD_USER_IDS ?? "563807698223890442"),
    discordBotspamChannelId: env.DISCORD_BOTSPAM_CHANNEL_ID?.trim() || undefined,
    radarrUrl: env.RADARR_URL?.trim().replace(/\/+$/, "") || undefined,
    radarrApiKey: env.RADARR_API_KEY?.trim() || undefined,
    radarrQualityProfileId: parseOptionalNumber(env.RADARR_QUALITY_PROFILE_ID),
    radarrRootFolderPath: env.RADARR_ROOT_FOLDER_PATH?.trim() || undefined,
    radarrMinFreeGb: Number(env.RADARR_MIN_FREE_GB ?? 3),
    sonarrUrl: env.SONARR_URL?.trim().replace(/\/+$/, "") || undefined,
    sonarrApiKey: env.SONARR_API_KEY?.trim() || undefined,
    sonarrQualityProfileId: parseOptionalNumber(env.SONARR_QUALITY_PROFILE_ID),
    sonarrLanguageProfileId: parseOptionalNumber(env.SONARR_LANGUAGE_PROFILE_ID),
    sonarrRootFolderPath: env.SONARR_ROOT_FOLDER_PATH?.trim() || undefined,
    sonarrMinFreeGb: Number(env.SONARR_MIN_FREE_GB ?? 3),
    sonarrExcludedRootKeywords: parseCsvIds(env.SONARR_EXCLUDED_ROOT_KEYWORDS ?? ""),
    webhookSharedSecret: env.WEBHOOK_SHARED_SECRET?.trim() || undefined,
    webhookDebounceMs: Number(env.WEBHOOK_DEBOUNCE_SECONDS ?? 30) * 1000,
    webhookPollMaxAttempts: Number(env.WEBHOOK_POLL_MAX_ATTEMPTS ?? 12),
    webhookPollIntervalMs: Number(env.WEBHOOK_POLL_INTERVAL_SECONDS ?? 10) * 1000,
    webhookPostRefreshSettleMs: Number(env.WEBHOOK_POST_REFRESH_SETTLE_MS ?? 1500),
    supercutMaxClips: Number(env.SUPERCUT_MAX_CLIPS ?? 30),
    supercutMaxDurationSeconds: Number(env.SUPERCUT_MAX_DURATION_SECONDS ?? 90),
    supercutPaddingMs: Number(env.SUPERCUT_PADDING_MS ?? 400),
    supercutCoalesceGapMs: Number(env.SUPERCUT_COALESCE_GAP_MS ?? 1500),
    supercutMaxMb: Number(env.SUPERCUT_MAX_MB ?? 24),
  };
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function parseCsvIds(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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

function parseReleaseRepo(env: NodeJS.ProcessEnv): { releaseRepoOwner: string; releaseRepoName: string } {
  const combined = env.RELEASE_REPO?.trim();
  if (combined?.includes("/")) {
    const [owner, name] = combined.split("/", 2);
    if (owner && name) {
      return { releaseRepoOwner: owner, releaseRepoName: name };
    }
  }

  return {
    releaseRepoOwner: env.RELEASE_REPO_OWNER?.trim() || "introVRt-Lounge",
    releaseRepoName: env.RELEASE_REPO_NAME?.trim() || "jellybot",
  };
}
