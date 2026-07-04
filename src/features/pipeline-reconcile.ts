import type { Client } from "discord.js";
import type { AppConfig } from "../config.ts";
import type { FeatureStore } from "./feature-store.ts";
import { notifyPipelineOpsInBotspam } from "./pipeline-discord-notify.ts";
import { inspectFeaturePipeline } from "./pipeline-tracker.ts";
import type { PipelineStageId } from "./pipeline-stages.ts";

/** After this many consecutive API failures, mark the suggestion as rejected. */
export const MAX_RECONCILE_FAILURES = 10;

function pipelineEventStatus(stage: PipelineStageId): "ok" | "pending" | "failed" | "stuck" | "warn" {
  if (stage === "shipped") {
    return "ok";
  }
  if (stage === "failed") {
    return "failed";
  }
  if (stage === "awaiting_pr" || stage === "awaiting_agent" || stage === "awaiting_branch") {
    return "stuck";
  }
  if (stage.startsWith("awaiting_")) {
    return "pending";
  }
  return "pending";
}

export async function reconcileBuildingSuggestions(
  client: Client,
  config: AppConfig,
  store: FeatureStore,
  guildId: string,
  failureCounts: Map<number, number> = new Map(),
): Promise<void> {
  if (!config.githubToken) {
    return;
  }

  const building = store.listBuildingForGuild(guildId);
  for (const suggestion of building) {
    try {
      const inspection = await inspectFeaturePipeline({
        repoOwner: config.releaseRepoOwner,
        repoName: config.releaseRepoName,
        githubToken: config.githubToken,
        issueNumber: suggestion.githubIssueNumber,
      });

      failureCounts.delete(suggestion.id);

      const previous = store.latestPipelineEvent(suggestion.id);
      const detail = inspection.blocker ?? inspection.stageLabel;
      const status = pipelineEventStatus(inspection.stage);

      if (
        !previous ||
        previous.stage !== inspection.stage ||
        previous.detail !== detail ||
        previous.status !== status
      ) {
        store.recordPipelineEvent({
          suggestionId: suggestion.id,
          stage: inspection.stage,
          status,
          detail,
        });

        console.info(
          JSON.stringify({
            event: "feature.pipeline.stage",
            issueNumber: suggestion.githubIssueNumber,
            stage: inspection.stage,
            status,
            blocker: inspection.blocker,
          }),
        );

        if ((status === "stuck" || status === "failed") && config.discordBotspamChannelId) {
          try {
            await notifyPipelineOpsInBotspam(client, config, inspection);
          } catch (error) {
            console.error(
              JSON.stringify({
                event: "feature.pipeline.botspam_notify_error",
                issueNumber: suggestion.githubIssueNumber,
                error: error instanceof Error ? error.message : "unknown error",
              }),
            );
          }
        }
      }

      if (inspection.merged && inspection.stage === "awaiting_ship") {
        store.setStatus(suggestion.id, "shipped");
        store.recordPipelineEvent({
          suggestionId: suggestion.id,
          stage: "shipped",
          status: "ok",
          detail: inspection.prUrl,
        });
      }

      if (inspection.stage === "failed") {
        store.setStatus(suggestion.id, "rejected");
      }
    } catch (error) {
      const count = (failureCounts.get(suggestion.id) ?? 0) + 1;
      failureCounts.set(suggestion.id, count);

      console.error(
        JSON.stringify({
          event: "feature.pipeline.reconcile_error",
          issueNumber: suggestion.githubIssueNumber,
          consecutiveFailures: count,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );

      if (count >= MAX_RECONCILE_FAILURES) {
        store.setStatus(suggestion.id, "rejected");
        store.recordPipelineEvent({
          suggestionId: suggestion.id,
          stage: "failed",
          status: "failed",
          detail: `Rejected after ${count} consecutive API failures: ${error instanceof Error ? error.message : "unknown"}`,
        });
        failureCounts.delete(suggestion.id);

        console.warn(
          JSON.stringify({
            event: "feature.pipeline.reconcile_abandoned",
            issueNumber: suggestion.githubIssueNumber,
            consecutiveFailures: count,
          }),
        );
      }
    }
  }
}

export function startFeaturePipelineReconcileLoop(
  client: Client,
  config: AppConfig,
  store: FeatureStore,
  intervalMs = 5 * 60_000,
): () => void {
  const failureCounts = new Map<number, number>();

  const tick = () => {
    for (const guildId of store.listGuildIdsWithBuilding()) {
      void reconcileBuildingSuggestions(client, config, store, guildId, failureCounts);
    }
  };

  const timer = setInterval(tick, intervalMs);
  void tick();

  return () => clearInterval(timer);
}
