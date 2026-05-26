"""Shared helpers for jellybot Discord user-token smoke scripts."""

from __future__ import annotations

import json
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path


def load_env(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        import os

        os.environ.setdefault(key, val)


def jellybot_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def fetch_bot_logs(log_cmd: str) -> str:
    cmd = log_cmd.strip()
    if cmd.endswith("2>&1"):
        cmd = cmd[:-4].strip()
    argv = shlex.split(cmd)
    result = subprocess.run(argv, capture_output=True, text=True, check=False)
    return result.stdout + result.stderr


def parse_json_log_events(log_text: str, *, event_prefix: str) -> list[dict]:
    events: list[dict] = []
    for line in log_text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        event = payload.get("event")
        if isinstance(event, str) and event.startswith(event_prefix):
            events.append(payload)
    return events


@dataclass(frozen=True)
class QuoteAutocompleteAssessment:
    ok: bool
    interaction_id: str
    query: str
    result_count: int | None
    detail: str
    search_line: str | None = None
    outcome_line: str | None = None


def assess_quote_autocomplete_logs(
    interaction_id: str,
    query: str,
    events: list[dict],
) -> QuoteAutocompleteAssessment:
    """Correlate structured prod logs for one autocomplete interaction.

    Pass criteria (authoritative for jellybot smoke):
    - `quote.autocomplete` with matching interactionId and query
    - followed by `quote.autocomplete.responded` with responded=true and resultCount>0

    `quote.autocomplete.responded` does not repeat interactionId; correlate via the
    preceding search event for the same interaction.
    """

    search = next(
        (
            event
            for event in events
            if event.get("event") == "quote.autocomplete"
            and str(event.get("interactionId")) == interaction_id
            and event.get("query") == query
        ),
        None,
    )
    if search is None:
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=interaction_id,
            query=query,
            result_count=None,
            detail="missing quote.autocomplete log line for interaction/query",
        )

    result_count = search.get("resultCount")
    try:
        parsed_count = int(result_count)
    except (TypeError, ValueError):
        parsed_count = -1

    start_idx = events.index(search)
    tail = events[start_idx + 1 : start_idx + 6]

    responded = next((event for event in tail if event.get("event") == "quote.autocomplete.responded"), None)
    if responded is not None:
        if responded.get("query") != query:
            return QuoteAutocompleteAssessment(
                ok=False,
                interaction_id=interaction_id,
                query=query,
                result_count=parsed_count,
                detail="responded log query mismatch",
                search_line=json.dumps(search, sort_keys=True),
                outcome_line=json.dumps(responded, sort_keys=True),
            )
        responded_count = responded.get("resultCount")
        if responded.get("responded") is True and isinstance(responded_count, int) and responded_count > 0:
            return QuoteAutocompleteAssessment(
                ok=True,
                interaction_id=interaction_id,
                query=query,
                result_count=parsed_count,
                detail=f"bot responded with {responded_count} choice(s)",
                search_line=json.dumps(search, sort_keys=True),
                outcome_line=json.dumps(responded, sort_keys=True),
            )
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=interaction_id,
            query=query,
            result_count=parsed_count,
            detail="responded log present but not successful",
            search_line=json.dumps(search, sort_keys=True),
            outcome_line=json.dumps(responded, sort_keys=True),
        )

    skipped = next(
        (
            event
            for event in tail
            if event.get("event") in {"quote.autocomplete.respond_skipped", "quote.autocomplete.respond_skip"}
        ),
        None,
    )
    if skipped is not None:
        error = skipped.get("error") or skipped.get("reason") or "unknown"
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=interaction_id,
            query=query,
            result_count=parsed_count,
            detail=f"bot skipped respond: {error}",
            search_line=json.dumps(search, sort_keys=True),
            outcome_line=json.dumps(skipped, sort_keys=True),
        )

    failed = next((event for event in tail if event.get("event") == "quote.autocomplete_failed"), None)
    if failed is not None:
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=interaction_id,
            query=query,
            result_count=parsed_count,
            detail=f"autocomplete_failed: {failed.get('error', 'unknown')}",
            search_line=json.dumps(search, sort_keys=True),
            outcome_line=json.dumps(failed, sort_keys=True),
        )

    return QuoteAutocompleteAssessment(
        ok=False,
        interaction_id=interaction_id,
        query=query,
        result_count=parsed_count,
        detail="search log found but no respond outcome within next events",
        search_line=json.dumps(search, sort_keys=True),
    )
