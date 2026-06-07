import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  AttachmentBuilder,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { AutocompleteSessionGuard, isBenignAutocompleteError } from "../autocomplete-guard.ts";
import type { AppConfig } from "../config.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import { openSubtitleIndex } from "../subtitles/index-db.ts";
import { coalesceCues, findSupercutCues, planSupercut } from "../supercut/finder.ts";
import { renderSupercut } from "../supercut/render.ts";

const PHRASE_MIN_LENGTH = 3;
const PHRASE_MAX_LENGTH = 80;
const SERIES_AUTOCOMPLETE_LIMIT = 25;

const seriesAutocompleteGuard = new AutocompleteSessionGuard();
const SERIES_AUTOCOMPLETE_KEY = (interaction: AutocompleteInteraction) =>
  `${interaction.user.id}:${interaction.guildId ?? "dm"}:supercut:series`;

/**
 * In-flight mutex keyed by guildId (or "dm" for DMs). One render per guild
 * keeps disk pressure bounded and stops trolls from queueing 30-clip
 * supercuts in a row to lock up ffmpeg.
 */
const inFlightRenders = new Set<string>();

export function buildSupercutCommand(maxClipsCeiling: number): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName("supercut")
    .setDescription("Concatenate every clip of a phrase from a series into one supercut.")
    .addStringOption((o) =>
      o
        .setName("phrase")
        .setDescription("The phrase to find (e.g. 'mawp')")
        .setMinLength(PHRASE_MIN_LENGTH)
        .setMaxLength(PHRASE_MAX_LENGTH)
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("series")
        .setDescription("Series title (case insensitive). Required for coherent results.")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("max_clips")
        .setDescription(`Hard cap on clips. Defaults to ${maxClipsCeiling}.`)
        .setMinValue(3)
        .setMaxValue(maxClipsCeiling)
        .setRequired(false),
    );
  return cmd as unknown as SlashCommandBuilder;
}

export async function handleSupercutAutocomplete(
  interaction: AutocompleteInteraction,
  config: Pick<AppConfig, "subtitleDbPath">,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "series") {
    if (!interaction.responded) await interaction.respond([]).catch(() => undefined);
    return;
  }

  const query = focused.value.trim();
  try {
    const { isCurrent } = seriesAutocompleteGuard.beginCancellable(SERIES_AUTOCOMPLETE_KEY(interaction));
    const index = openSubtitleIndex(config.subtitleDbPath, { readonly: true });
    let names: string[];
    try {
      names = index.listSeriesNames(query, SERIES_AUTOCOMPLETE_LIMIT);
    } finally {
      index.close();
    }

    if (!isCurrent() || interaction.responded) return;

    const choices = names.map((name) => ({ name: name.slice(0, 100), value: name }));
    await interaction.respond(choices);
  } catch (error) {
    if (isBenignAutocompleteError(error)) return;
    console.error(
      JSON.stringify({
        event: "supercut.autocomplete_failed",
        query,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    if (!interaction.responded) await interaction.respond([]).catch(() => undefined);
  }
}

export type SupercutConfig = Pick<
  AppConfig,
  "subtitleDbPath" | "clipTempDir" | "supercutMaxClips" | "supercutMaxDurationSeconds" | "supercutPaddingMs" | "supercutCoalesceGapMs" | "supercutMaxMb"
>;

export async function handleSupercutCommand(
  interaction: ChatInputCommandInteraction,
  jellyfin: JellyfinClient,
  config: SupercutConfig,
): Promise<void> {
  const phrase = interaction.options.getString("phrase", true).trim();
  const seriesName = interaction.options.getString("series", true).trim();
  const requestedClipCap = interaction.options.getInteger("max_clips") ?? config.supercutMaxClips;
  const maxClips = Math.min(requestedClipCap, config.supercutMaxClips);

  if (phrase.length < PHRASE_MIN_LENGTH) {
    await interaction.reply({
      content: `Phrase must be at least ${PHRASE_MIN_LENGTH} characters.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId ?? "dm";
  if (inFlightRenders.has(guildId)) {
    await interaction.reply({
      content: "Another supercut is already rendering in this server. Try again in a minute.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  inFlightRenders.add(guildId);

  const interactionId = interaction.id;
  const workDir = join(config.clipTempDir, `supercut-${interactionId}`);
  const outputPath = join(config.clipTempDir, `supercut-${interactionId}.mp4`);

  try {
    const index = openSubtitleIndex(config.subtitleDbPath, { readonly: true });
    let rawCues;
    try {
      rawCues = findSupercutCues(index, {
        query: phrase,
        seriesName,
        searchLimit: Math.max(maxClips * 4, 60),
      });
    } finally {
      index.close();
    }

    if (rawCues.length === 0) {
      await interaction.editReply(
        `No matches for **${phrase}** in **${seriesName}**. Check the spelling and try a less common phrase.`,
      );
      return;
    }

    const coalesced = coalesceCues(rawCues, config.supercutCoalesceGapMs);
    const plan = planSupercut({
      cues: coalesced,
      paddingMs: config.supercutPaddingMs,
      maxClips,
      maxDurationSeconds: config.supercutMaxDurationSeconds,
    });

    if (plan.cues.length < 3) {
      await interaction.editReply(
        `Only ${plan.cues.length} hit${plan.cues.length === 1 ? "" : "s"} for **${phrase}** in **${seriesName}** — that's not really a supercut. Try \`/quote\` for a single match.`,
      );
      return;
    }

    console.info(
      JSON.stringify({
        event: "supercut.requested",
        userId: interaction.user.id,
        guildId,
        phrase,
        seriesName,
        rawHits: rawCues.length,
        clipsAfterCaps: plan.cues.length,
        estimatedDurationSeconds: Math.round(plan.estimatedDurationSeconds),
        trimmedForRuntime: plan.trimmedForRuntime,
      }),
    );

    await interaction.editReply(
      `Rendering **${plan.cues.length}-clip supercut** of "${phrase}" from **${seriesName}** (~${Math.round(plan.estimatedDurationSeconds)}s)...`,
    );

    const maxBytes = Math.floor(
      Math.min(interaction.attachmentSizeLimit, config.supercutMaxMb * 1024 * 1024) * 0.95,
    );

    const result = await renderSupercut({
      cues: plan.cues,
      jellyfin,
      paddingMs: config.supercutPaddingMs,
      workDir,
      outputPath,
      maxBytes,
    });

    if (!result.ok) {
      console.warn(
        JSON.stringify({
          event: "supercut.render_failed",
          userId: interaction.user.id,
          guildId,
          phrase,
          seriesName,
          reason: result.message,
        }),
      );
      await interaction.editReply(result.message);
      return;
    }

    const sizeMb = (result.sizeBytes / (1024 * 1024)).toFixed(1);
    const summary = [
      `Supercut: **"${phrase}"** in **${seriesName}**`,
      `${result.clipsRendered} clips, ~${Math.round(plan.estimatedDurationSeconds)}s, ${sizeMb} MB.`,
      plan.trimmedForRuntime > 0
        ? `(${plan.trimmedForRuntime} additional hit${plan.trimmedForRuntime === 1 ? "" : "s"} skipped to stay under the cap.)`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const attachment = new AttachmentBuilder(outputPath, {
      name: `supercut-${slugify(seriesName)}-${slugify(phrase)}.mp4`,
    });

    await interaction.editReply({
      content: summary,
      files: [attachment],
    });

    console.info(
      JSON.stringify({
        event: "supercut.delivered",
        userId: interaction.user.id,
        guildId,
        phrase,
        seriesName,
        clipsRendered: result.clipsRendered,
        sizeBytes: result.sizeBytes,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "supercut.error",
        userId: interaction.user.id,
        guildId,
        phrase,
        seriesName,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    const message = "Something went wrong while building that supercut.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => undefined);
    } else {
      await interaction
        .reply({ content: message, flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  } finally {
    inFlightRenders.delete(guildId);
    await rm(outputPath, { force: true }).catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Test hook: the in-flight set is module-scoped so tests can clear it between runs. */
export function _resetSupercutMutexForTests(): void {
  inFlightRenders.clear();
}
