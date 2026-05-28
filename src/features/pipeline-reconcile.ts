import type { AppConfig } from "../config.ts";
import type { FeatureStore } from "./feature-store.ts";
import { inspectFeaturePipeline } from "./pipeline-tracker.ts";
import type { PipelineStageId } from "./pipeline-stages.ts";

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
  config: AppConfig,
  store: FeatureStore,
  guildId: string,
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
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "feature.pipeline.reconcile_error",
          issueNumber: suggestion.githubIssueNumber,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
  }
}

export function startFeaturePipelineReconcileLoop(
  config: AppConfig,
  store: FeatureStore,
  intervalMs = 5 * 60_000,
): () => void {
  const tick = () => {
    for (const guildId of store.listGuildIdsWithBuilding()) {
      void reconcileBuildingSuggestions(config, store, guildId);
    }
  };

  const timer = setInterval(tick, intervalMs);
  void tick();

  return () => clearInterval(timer);
}
