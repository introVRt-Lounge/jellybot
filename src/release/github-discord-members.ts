/** IntroVRt Lounge GitHub login → Discord user snowflake (lowercase keys). */
const GITHUB_TO_DISCORD_SNOWFLAKE: Record<string, string> = {
  gpcas9: "385136311927046154",
  ariabelvr: "724384676780966020",
  toomanypillows: "203729667595829248",
  "radgey-cmd": "563807698223890442",
};

export function discordSnowflakeForGitHubLogin(login: string): string | null {
  return GITHUB_TO_DISCORD_SNOWFLAKE[login.trim().toLowerCase()] ?? null;
}

export function discordMentionForGitHubLogin(login: string): string | null {
  const snowflake = discordSnowflakeForGitHubLogin(login);
  return snowflake ? `<@${snowflake}>` : null;
}
