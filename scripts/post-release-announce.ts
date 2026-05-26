#!/usr/bin/env bun
/** Post a release announce embed for a specific tag (optionally patch). Operator tool. */
import { Client, Events, GatewayIntentBits } from "discord.js";
import "dotenv/config";
import { loadConfig } from "../src/config.ts";
import { createReleaseAnnouncerFromConfig } from "../src/release/release-announcer.ts";
import { fetchReleaseByTag } from "../src/release/github-releases.ts";

const tag = process.argv[2];
const allowPatch = process.argv.includes("--allow-patch");

if (!tag) {
  console.error("Usage: bun run scripts/post-release-announce.ts <tag> [--allow-patch]");
  process.exit(2);
}

const config = loadConfig();
const announcer = createReleaseAnnouncerFromConfig(config);
if (!announcer) {
  console.error("Release announcer disabled (GITHUB_TOKEN / NOTIFICATION_CHANNEL_ID missing)");
  process.exit(2);
}

const release = await fetchReleaseByTag(
  config.releaseRepoOwner,
  config.releaseRepoName,
  config.githubToken!,
  tag,
);
if (!release) {
  console.error(`Release not found: ${tag}`);
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once(Events.ClientReady, async () => {
  try {
    const posted = await announcer.announceRelease(client, release, { allowPatch });
    console.info(JSON.stringify({ event: "post_release_announce.done", tag, posted }));
    process.exit(posted ? 0 : 1);
  } catch (error) {
    console.error(error);
    process.exit(1);
  } finally {
    client.destroy();
  }
});

await client.login(config.discordToken);
