import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ScopeGateResult =
  | { ok: true; summary: string; issueBody: string }
  | { ok: false; reason: string };

const JELLYFIN_HINTS =
  /\b(jellyfin|clip|quote|subtitle|movie|tv|episode|library|media|audio|lyrics|timestamp|discover|share)\b/i;

const OUT_OF_SCOPE_HINTS =
  /\b(moderation|ticket(?:ing)?|crypto|nft|gambling|admin panel|spotify only|without jellyfin)\b/i;

function loadScopeDoc(): string {
  try {
    return readFileSync(join(process.cwd(), "docs/PRODUCT_SCOPE.md"), "utf8");
  } catch {
    return "Help guild members discover and share Jellyfin library content in Discord.";
  }
}

export function evaluateSuggestionHeuristic(description: string): ScopeGateResult {
  const trimmed = description.trim();
  if (trimmed.length < 12) {
    return { ok: false, reason: "Describe the idea in a bit more detail (at least 12 characters)." };
  }

  if (OUT_OF_SCOPE_HINTS.test(trimmed)) {
    return {
      ok: false,
      reason:
        "That sounds outside jellybot's mission (Jellyfin → discover → clip → share in Discord). Try framing it around library media.",
    };
  }

  if (!JELLYFIN_HINTS.test(trimmed)) {
    return {
      ok: false,
      reason:
        "Tie the idea to Jellyfin library media (find, clip, quote, subtitles, etc.). Jellybot doesn't do general Discord utilities.",
    };
  }

  const summary = trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
  const issueBody = buildIssueBody(trimmed, summary, "Heuristic scope pass (Jellyfin-aligned keywords).");
  return { ok: true, summary, issueBody };
}

export async function evaluateSuggestionScope(
  description: string,
  openaiApiKey?: string,
): Promise<ScopeGateResult> {
  const heuristic = evaluateSuggestionHeuristic(description);
  if (!heuristic.ok || !openaiApiKey) {
    return heuristic;
  }

  try {
    const scopeDoc = loadScopeDoc();
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You gate jellybot feature suggestions against PRODUCT_SCOPE. Reply JSON only: {\"pass\":boolean,\"reason\":string,\"summary\":string,\"userStory\":string,\"acceptance\":string[]}",
          },
          {
            role: "user",
            content: `PRODUCT_SCOPE:\n${scopeDoc}\n\nSuggestion:\n${description}`,
          },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!response.ok) {
      return heuristic;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = payload.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      return heuristic;
    }

    const parsed = JSON.parse(raw) as {
      pass?: boolean;
      reason?: string;
      summary?: string;
      userStory?: string;
      acceptance?: string[];
    };

    if (!parsed.pass) {
      return {
        ok: false,
        reason: parsed.reason?.trim() || "Out of scope for jellybot's Jellyfin mission.",
      };
    }

    const summary = parsed.summary?.trim() || heuristic.summary;
    const issueBody = buildIssueBody(
      description,
      summary,
      parsed.reason?.trim() || "Scope gate pass.",
      parsed.userStory,
      parsed.acceptance,
    );
    return { ok: true, summary, issueBody };
  } catch {
    return heuristic;
  }
}

function buildIssueBody(
  description: string,
  summary: string,
  scopeNote: string,
  userStory?: string,
  acceptance?: string[],
): string {
  const lines = [
    "## User suggestion (Discord)",
    "",
    description,
    "",
    "## Scope gate",
    "",
    scopeNote,
    "",
    "## Summary",
    "",
    summary,
  ];

  if (userStory?.trim()) {
    lines.push("", "## User story", "", userStory.trim());
  }

  if (acceptance?.length) {
    lines.push("", "## Acceptance sketch", "", ...acceptance.map((item) => `- ${item}`));
  }

  lines.push(
    "",
    "---",
    "",
    "Created from `/feature suggest`. Rank with `/feature rank` in Discord. Triage via `/feature choose` (maintainer).",
  );

  return lines.join("\n");
}

export function suggestionIssueTitle(description: string): string {
  const oneLine = description.trim().split("\n", 1)[0]?.trim() ?? "Feature suggestion";
  const prefixed = oneLine.startsWith("[") ? oneLine : `[feat]: ${oneLine}`;
  return prefixed.length > 120 ? `${prefixed.slice(0, 117)}...` : prefixed;
}
