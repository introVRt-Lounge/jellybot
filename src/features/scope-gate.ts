import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ScopeGateResult =
  | { ok: true; summary: string; issueBody: string }
  | { ok: false; reason: string };

const SPAM_HINTS =
  /\b(crypto|nft|gambling|buy now|click here|free money)\b/i;

function loadScopeDoc(): string {
  try {
    return readFileSync(join(process.cwd(), "docs/PRODUCT_SCOPE.md"), "utf8");
  } catch {
    return "Help guild members discover and share Jellyfin library content in Discord.";
  }
}

function evaluateHardBlocks(description: string): ScopeGateResult | null {
  const trimmed = description.trim();
  if (trimmed.length < 12) {
    return { ok: false, reason: "Describe the idea in a bit more detail (at least 12 characters)." };
  }

  if (SPAM_HINTS.test(trimmed)) {
    return {
      ok: false,
      reason: "That looks like spam or unrelated promotion, not a jellybot feature idea.",
    };
  }

  return null;
}

export function evaluateSuggestionHeuristic(description: string): ScopeGateResult {
  const hardBlock = evaluateHardBlocks(description);
  if (hardBlock) {
    return hardBlock;
  }

  const trimmed = description.trim();
  const summary = trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
  const issueBody = buildIssueBody(
    trimmed,
    summary,
    "Forwarded for guild ranking. Maintainer triages via `/feature choose`.",
  );
  return { ok: true, summary, issueBody };
}

const SCOPE_ENRICHER_SYSTEM_PROMPT = `You prepare jellybot Discord feature suggestions for community consideration.

DEFAULT: pass=true. Assume YES. Ideas enter the guild ranking queue; the maintainer (Radgey) is the ultimate arbiter via /feature choose and GitHub triage.

Your job when pass=true:
- Reframe vague wording into a clear summary
- Expand meta/tooling/transparency requests (subtitle coverage reports, index health, bot stats, operator visibility, UX polish, docs) as valid community ideas
- Treat library coverage, indexing, reliability, and guild UX as in scope even when not a direct clip command

Set pass=false ONLY for obvious spam, abuse, or proposals with zero connection to jellybot or Jellyfin guild use (unrelated product pitch, pure scam).

When uncertain, pass=true. If pass=false, explain briefly in reason.

Reply JSON only: {"pass":boolean,"reason":string,"summary":string,"userStory":string,"acceptance":string[]}`;

export async function evaluateSuggestionScope(
  description: string,
  openaiApiKey?: string,
): Promise<ScopeGateResult> {
  const hardBlock = evaluateHardBlocks(description);
  if (hardBlock) {
    return hardBlock;
  }

  const heuristic = evaluateSuggestionHeuristic(description);
  if (!openaiApiKey) {
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
          { role: "system", content: SCOPE_ENRICHER_SYSTEM_PROMPT },
          {
            role: "user",
            content: `PRODUCT_SCOPE (context only — feature suggestions default to consideration):\n${scopeDoc}\n\nSuggestion:\n${description}`,
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

    const fallbackSummary = description.trim().slice(0, 160);
    const summary = parsed.summary?.trim() || fallbackSummary;

    const scopeNote = parsed.pass
      ? parsed.reason?.trim() || "Forwarded for guild ranking; maintainer triages."
      : `Forwarded for guild ranking. Automated note for maintainer (not a block): ${parsed.reason?.trim() || "borderline — human decides"}`;

    const issueBody = buildIssueBody(description, summary, scopeNote, parsed.userStory, parsed.acceptance);
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
