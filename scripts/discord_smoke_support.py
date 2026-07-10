"""Shared helpers for jellybot Discord user-token smoke scripts."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


DEFAULT_SMOKE_LOG_CMD = "docker logs jellybot-dev"
DEFAULT_SMOKE_HEALTH_URL = "http://127.0.0.1:8093/healthz"


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


def load_smoke_env() -> None:
    """Load jellybot + discord.py-self env files (host paths, no GitHub Secrets)."""
    root = jellybot_repo_root()
    load_env(root / ".env")
    dpy_root = os.environ.get("DISCORD_PY_SELF_ROOT", "~/coding/discord.py-self").strip()
    load_env(Path(dpy_root).expanduser() / ".env")


def smoke_log_cmd() -> str:
    return os.environ.get("JELLYBOT_SMOKE_LOG_CMD", DEFAULT_SMOKE_LOG_CMD).strip()


def smoke_health_url() -> str:
    return os.environ.get("JELLYBOT_SMOKE_HEALTH_URL", DEFAULT_SMOKE_HEALTH_URL).strip()


def assert_health_responsive(url: str | None = None, *, timeout_sec: float = 2.0) -> dict:
    """Fail fast when the dev bot event loop is wedged (health must answer quickly)."""
    target = (url or smoke_health_url()).strip()
    deadline = time.time() + timeout_sec
    last_error = "no attempts"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(target, timeout=min(1.5, timeout_sec)) as response:
                body = response.read().decode("utf-8", errors="replace")
            payload = json.loads(body)
            if payload.get("discord") == "connected":
                return payload
            last_error = f"discord={payload.get('discord')!r}"
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
        time.sleep(0.25)
    raise TimeoutError(
        f"health at {target} not responsive within {timeout_sec}s ({last_error}) — "
        "dev bot event loop may be blocked (try SUBTITLE_INDEX_ON_STARTUP=off and recreate container)"
    )


def wait_for_health(url: str | None = None, *, timeout_sec: int = 120) -> dict:
    target = (url or smoke_health_url()).strip()
    deadline = time.time() + timeout_sec
    last_error = "no attempts"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(target, timeout=5) as response:
                body = response.read().decode("utf-8", errors="replace")
            payload = json.loads(body)
            if payload.get("discord") == "connected":
                return payload
            last_error = f"discord={payload.get('discord')!r}"
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8", errors="replace")
                payload = json.loads(body)
                if payload.get("discord") == "connected":
                    return payload
                last_error = f"http {exc.code} discord={payload.get('discord')!r}"
            except (json.JSONDecodeError, UnicodeDecodeError):
                last_error = f"http {exc.code}"
        except Exception as exc:  # noqa: BLE001 — startup window throws assorted socket errors
            last_error = str(exc)
        time.sleep(2)
    raise TimeoutError(f"health not ready at {target} within {timeout_sec}s ({last_error})")


def fetch_bot_logs(log_cmd: str | None = None) -> str:
    cmd = (log_cmd or smoke_log_cmd()).strip()
    if cmd.endswith("2>&1"):
        cmd = cmd[:-4].strip()
    argv = shlex.split(cmd)
    result = subprocess.run(argv, capture_output=True, text=True, check=False)
    return result.stdout + result.stderr


def fetch_bot_logs_since(log_cmd: str | None, *, since_epoch: float) -> str:
    """Fetch container logs since an epoch timestamp (immune to line-count drift)."""
    cmd = (log_cmd or smoke_log_cmd()).strip()
    if cmd.endswith("2>&1"):
        cmd = cmd[:-4].strip()
    argv = shlex.split(cmd)
    # docker logs --since accepts RFC3339 or relative seconds
    since_sec = max(1, int(time.time() - since_epoch) + 1)
    if "--since" not in argv:
        argv = [*argv, "--since", f"{since_sec}s"]
    result = subprocess.run(argv, capture_output=True, text=True, check=False)
    return result.stdout + result.stderr


def fetch_bot_logs_tail(log_cmd: str | None = None, *, since_line: int = 0) -> str:
    text = fetch_bot_logs(log_cmd)
    lines = text.splitlines()
    if since_line <= 0:
        return text
    return "\n".join(lines[since_line:])


def bot_log_line_count(log_cmd: str | None = None) -> int:
    return len(fetch_bot_logs(log_cmd).splitlines())


def poll_bot_logs(
    log_cmd: str | None,
    *,
    since_epoch: float,
    timeout_sec: float,
    poll_interval_sec: float = 0.5,
    event_prefix: str | None = None,
    min_events: int = 1,
) -> tuple[str, list[dict]]:
    """Poll docker logs until enough JSON events appear or timeout."""
    cmd = log_cmd or smoke_log_cmd()
    deadline = time.time() + timeout_sec
    last_tail = ""
    last_events: list[dict] = []
    while time.time() < deadline:
        last_tail = fetch_bot_logs_since(cmd, since_epoch=since_epoch)
        if event_prefix:
            last_events = parse_json_log_events(last_tail, event_prefix=event_prefix)
            if len(last_events) >= min_events:
                return last_tail, last_events
        else:
            if last_tail.strip():
                return last_tail, last_events
        time.sleep(poll_interval_sec)
    return last_tail, last_events


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


@dataclass(frozen=True)
class GenericAutocompleteAssessment:
    ok: bool
    detail: str
    result_count: int | None = None


def assess_quote_series_autocomplete_logs(
    interaction_id: str,
    query: str,
    events: list[dict],
    *,
    match_query_only: bool = False,
) -> QuoteAutocompleteAssessment:
    """Series option uses quote.series_autocomplete + shared quote.autocomplete.responded."""
    if match_query_only:
        search_candidates = [
            event
            for event in events
            if event.get("event") == "quote.series_autocomplete" and event.get("query") == query
        ]
        search = search_candidates[-1] if search_candidates else None
    else:
        search = next(
            (
                event
                for event in events
                if event.get("event") == "quote.series_autocomplete"
                and str(event.get("interactionId")) == interaction_id
                and event.get("query") == query
            ),
            None,
        )
    if search is None:
        failed_only = next(
            (event for event in events if event.get("event") == "quote.series_autocomplete_failed" and event.get("query") == query),
            None,
        )
        if failed_only is not None:
            return QuoteAutocompleteAssessment(
                ok=False,
                interaction_id=interaction_id,
                query=query,
                result_count=None,
                detail=f"series_autocomplete_failed: {failed_only.get('error', 'unknown')}",
            )
        skipped_only = next(
            (
                event
                for event in events
                if event.get("event") in {"quote.autocomplete.respond_skipped", "quote.autocomplete.respond_skip"}
                and event.get("query") == query
            ),
            None,
        )
        if skipped_only is not None:
            error = skipped_only.get("error") or skipped_only.get("reason") or "unknown"
            detail = f"bot skipped respond: {error}"
            if "unknown interaction" in str(error).lower():
                detail = (
                    "autocomplete missed Discord's response window (Unknown interaction) — "
                    "users would see empty or stale choices"
                )
            return QuoteAutocompleteAssessment(
                ok=False,
                interaction_id=interaction_id,
                query=query,
                result_count=None,
                detail=detail,
            )
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=interaction_id,
            query=query,
            result_count=None,
            detail="missing quote.series_autocomplete log line for interaction/query",
        )

    result_count = search.get("resultCount")
    try:
        parsed_count = int(result_count)
    except (TypeError, ValueError):
        parsed_count = -1

    start_idx = events.index(search)
    tail = events[start_idx + 1 :]
    responded = next((event for event in tail if event.get("event") == "quote.autocomplete.responded"), None)
    if responded is not None and responded.get("query") == query:
        responded_count = responded.get("resultCount")
        if responded.get("responded") is True and isinstance(responded_count, int) and responded_count > 0:
            return QuoteAutocompleteAssessment(
                ok=True,
                interaction_id=interaction_id,
                query=query,
                result_count=parsed_count,
                detail=f"series autocomplete responded with {responded_count} choice(s)",
            )
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=interaction_id,
            query=query,
            result_count=parsed_count,
            detail="series responded log present but not successful",
        )

    failed = next((event for event in tail if event.get("event") == "quote.series_autocomplete_failed"), None)
    if failed is not None:
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=interaction_id,
            query=query,
            result_count=parsed_count,
            detail=f"series_autocomplete_failed: {failed.get('error', 'unknown')}",
        )

    skipped = next(
        (
            event
            for event in tail
            if event.get("event") in {"quote.autocomplete.respond_skipped", "quote.autocomplete.respond_skip"}
            and event.get("query") == query
        ),
        None,
    )
    if skipped is not None:
        error = skipped.get("error") or skipped.get("reason") or "unknown"
        detail = f"bot skipped respond: {error}"
        if "unknown interaction" in str(error).lower():
            detail = (
                "autocomplete missed Discord's response window (Unknown interaction) — "
                "users would see empty or stale choices"
            )
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=interaction_id,
            query=query,
            result_count=parsed_count,
            detail=detail,
        )

    return QuoteAutocompleteAssessment(
        ok=False,
        interaction_id=interaction_id,
        query=query,
        result_count=parsed_count,
        detail="series search log found but no respond outcome within next events",
    )


def assess_field_autocomplete_logs(
    events: list[dict],
    *,
    event_name: str,
    query: str,
    field: str | None = None,
    kind: str | None = None,
    min_results: int = 1,
) -> GenericAutocompleteAssessment:
    matches = [
        event
        for event in events
        if event.get("event") == event_name
        and event.get("query") == query
        and (field is None or event.get("field") == field)
        and (kind is None or event.get("kind") == kind)
    ]
    if not matches:
        return GenericAutocompleteAssessment(ok=False, detail=f"missing {event_name} for query={query!r}")

    latest = matches[-1]
    count = latest.get("resultCount")
    try:
        parsed = int(count)
    except (TypeError, ValueError):
        parsed = -1

    if parsed >= min_results:
        return GenericAutocompleteAssessment(
            ok=True,
            detail=f"{event_name} resultCount={parsed}",
            result_count=parsed,
        )
    return GenericAutocompleteAssessment(
        ok=False,
        detail=f"{event_name} resultCount={parsed} (< {min_results})",
        result_count=parsed,
    )


def log_has_event(log_text: str, event_name: str, *, query: str | None = None) -> bool:
    for line in log_text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if payload.get("event") != event_name:
            continue
        if query is not None and payload.get("query") != query:
            continue
        return True
    return False


def log_lacks_event(log_text: str, event_name: str, *, query: str | None = None) -> bool:
    return not log_has_event(log_text, event_name, query=query)


def _quote_search_events(events: list[dict], query: str) -> list[dict]:
    return [event for event in events if event.get("event") == "quote.autocomplete" and event.get("query") == query]


def _quote_respond_outcome_after(
    events: list[dict],
    *,
    start_idx: int,
    query: str,
) -> dict | None:
    tail = events[start_idx + 1 :]
    for event in tail:
        event_name = event.get("event")
        if event_name == "quote.autocomplete.responded" and event.get("query") == query:
            return event
        if event_name in {"quote.autocomplete.respond_skipped", "quote.autocomplete.respond_skip"}:
            if event.get("query") in {query, None}:
                return event
        if event_name == "quote.autocomplete_failed" and event.get("query") == query:
            return event
        if event_name == "quote.autocomplete" and event.get("query") != query:
            break
    return None


def assess_quote_debounce_supersede_logs(
    events: list[dict],
    prefix_query: str,
    final_query: str,
) -> QuoteAutocompleteAssessment:
    """Rapid prefix→final keystrokes: final must win; prefix must not serve stale choices."""
    final_searches = _quote_search_events(events, final_query)
    if not final_searches:
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id="",
            query=final_query,
            result_count=None,
            detail=f"missing quote.autocomplete for final query {final_query!r}",
        )

    final_search = final_searches[-1]
    final_idx = events.index(final_search)
    final_outcome = _quote_respond_outcome_after(events, start_idx=final_idx, query=final_query)
    if final_outcome is None:
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=str(final_search.get("interactionId", "")),
            query=final_query,
            result_count=final_search.get("resultCount"),
            detail="final query search log found but no respond outcome",
        )
    if final_outcome.get("event") != "quote.autocomplete.responded":
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=str(final_search.get("interactionId", "")),
            query=final_query,
            result_count=final_search.get("resultCount"),
            detail=f"final query did not respond successfully: {final_outcome.get('event')}",
        )
    final_count = final_outcome.get("resultCount")
    if not (final_outcome.get("responded") is True and isinstance(final_count, int) and final_count > 0):
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=str(final_search.get("interactionId", "")),
            query=final_query,
            result_count=final_count if isinstance(final_count, int) else None,
            detail=f"final query responded but resultCount={final_count!r}",
        )

    for outcome in (
        event
        for event in events
        if event.get("event") == "quote.autocomplete.responded" and event.get("query") == prefix_query
    ):
        count = outcome.get("resultCount")
        if outcome.get("responded") is True and isinstance(count, int) and count > 0:
            return QuoteAutocompleteAssessment(
                ok=False,
                interaction_id=str(final_search.get("interactionId", "")),
                query=final_query,
                result_count=final_count,
                detail=(
                    f"prefix {prefix_query!r} served {count} stale choice(s) — "
                    "debounce should cancel superseded keystrokes"
                ),
            )

    return QuoteAutocompleteAssessment(
        ok=True,
        interaction_id=str(final_search.get("interactionId", "")),
        query=final_query,
        result_count=final_count,
        detail=f"debounce kept final {final_query!r} ({final_count} choices); prefix did not serve stale hits",
    )


def assess_quote_shaping_logs(events: list[dict], query: str) -> QuoteAutocompleteAssessment:
    """Long match input must shape searchQuery and still respond in time."""
    searches = _quote_search_events(events, query)
    if not searches:
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id="",
            query=query,
            result_count=None,
            detail=f"missing quote.autocomplete for long query {query!r}",
        )

    search = searches[-1]
    shaped = search.get("searchQuery")
    if not isinstance(shaped, str) or shaped.strip() == query.strip():
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=str(search.get("interactionId", "")),
            query=query,
            result_count=search.get("resultCount"),
            detail=f"expected shaped searchQuery != query for long input (got searchQuery={shaped!r})",
        )

    search_idx = events.index(search)
    outcome = _quote_respond_outcome_after(events, start_idx=search_idx, query=query)
    if outcome is None or outcome.get("event") != "quote.autocomplete.responded":
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=str(search.get("interactionId", "")),
            query=query,
            result_count=search.get("resultCount"),
            detail="shaped search log found but no successful respond outcome",
        )
    count = outcome.get("resultCount")
    if not (outcome.get("responded") is True and isinstance(count, int) and count > 0):
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=str(search.get("interactionId", "")),
            query=query,
            result_count=count if isinstance(count, int) else None,
            detail=f"shaped query responded but resultCount={count!r}",
        )

    return QuoteAutocompleteAssessment(
        ok=True,
        interaction_id=str(search.get("interactionId", "")),
        query=query,
        result_count=count,
        detail=f"shaped {query!r} → {shaped!r} with {count} choice(s)",
    )


def assess_quote_min_length_cancel_logs(
    events: list[dict],
    valid_query: str,
    short_query: str,
) -> QuoteAutocompleteAssessment:
    """Deleting below min length must cancel pending debounce and not serve stale choices.

    The below-min path in quote.ts responds with [] immediately and does **not** emit
    `quote.autocomplete` (no FTS). Correlate on `quote.autocomplete.responded` only.
    """
    short_outcomes = [
        event
        for event in events
        if event.get("event") == "quote.autocomplete.responded" and event.get("query") == short_query
    ]
    if not short_outcomes:
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id="",
            query=short_query,
            result_count=None,
            detail=f"missing quote.autocomplete.responded for below-min query {short_query!r}",
        )

    short_outcome = short_outcomes[-1]
    short_count = short_outcome.get("resultCount")
    if not (short_outcome.get("responded") is True and isinstance(short_count, int) and short_count == 0):
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=str(short_outcome.get("interactionId", "")),
            query=short_query,
            result_count=short_count if isinstance(short_count, int) else None,
            detail=(
                f"below-min {short_query!r} should respond with empty choices "
                f"(got resultCount={short_count!r})"
            ),
        )

    for outcome in (
        event
        for event in events
        if event.get("event") == "quote.autocomplete.responded" and event.get("query") == valid_query
    ):
        count = outcome.get("resultCount")
        if outcome.get("responded") is True and isinstance(count, int) and count > 0:
            return QuoteAutocompleteAssessment(
                ok=False,
                interaction_id=str(short_outcome.get("interactionId", "")),
                query=short_query,
                result_count=count,
                detail=(
                    f"valid query {valid_query!r} served {count} stale choice(s) after "
                    f"below-min {short_query!r} — debounce cancel on shrink failed"
                ),
            )

    return QuoteAutocompleteAssessment(
        ok=True,
        interaction_id=str(short_outcome.get("interactionId", "")),
        query=short_query,
        result_count=0,
        detail=f"below-min {short_query!r} cleared pending {valid_query!r} (empty respond)",
    )


def assess_quote_autocomplete_logs(
    interaction_id: str,
    query: str,
    events: list[dict],
    *,
    match_query_only: bool = False,
) -> QuoteAutocompleteAssessment:
    """Correlate structured prod logs for one autocomplete interaction.

    Pass criteria (authoritative for jellybot smoke):
    - `quote.autocomplete` with matching interactionId and query
    - followed by `quote.autocomplete.responded` with responded=true and resultCount>0

    When `match_query_only` is True (live smoke via discord.py-self), correlate the
    latest search event for `query` — client and gateway interaction ids can differ.
    """

    if match_query_only:
        search_candidates = [
            event
            for event in events
            if event.get("event") == "quote.autocomplete" and event.get("query") == query
        ]
        search = search_candidates[-1] if search_candidates else None
    else:
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
    tail = events[start_idx + 1 :]

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
        detail = f"bot skipped respond: {error}"
        if "unknown interaction" in str(error).lower():
            detail = (
                "autocomplete missed Discord's response window (Unknown interaction) — "
                "users would see empty or stale choices"
            )
        return QuoteAutocompleteAssessment(
            ok=False,
            interaction_id=interaction_id,
            query=query,
            result_count=parsed_count,
            detail=detail,
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
