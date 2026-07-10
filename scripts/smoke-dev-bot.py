#!/usr/bin/env python3
"""Discord bot smoke — user-token slash commands against JellyBot-Dev on Bottitesto.

This is the real smoke gate: impersonate a user (discord.py-self), fire autocomplete
and commands in a guild channel, and pass only when bot logs prove a timely response.
Catches "Unknown interaction" / empty autocomplete before users do.

NOT smoke: in-container Jellyfin/SQLite checks (see src/cli/smoke-live.ts preflight).

Reads host .env only — no GitHub Secrets.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from discord_smoke_lib import (
    assert_smoke_guild_channel,
    fire_autocomplete,
    find_slash_command,
    prepare_discord_import,
    require_smoke_credentials,
)
from discord_smoke_support import (
    assess_field_autocomplete_logs,
    assess_quote_autocomplete_logs,
    assess_quote_debounce_supersede_logs,
    assess_quote_min_length_cancel_logs,
    assess_quote_series_autocomplete_logs,
    assess_quote_shaping_logs,
    assert_health_responsive,
    bot_log_line_count,
    fetch_bot_logs_tail,
    load_smoke_env,
    log_has_event,
    log_lacks_event,
    parse_json_log_events,
    poll_bot_logs,
    smoke_health_url,
    wait_for_health,
)


def env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


def extended_smoke_enabled() -> bool:
    return env("JELLYBOT_SMOKE_EXTENDED", "0") in {"1", "true", "yes"}


async def run_discord_smokes() -> list[str]:
    prepare_discord_import()
    from discord import SlashCommand

    token, app_id, channel_id = require_smoke_credentials()
    failures: list[str] = []
    print(f"[smoke] channel={channel_id} app_id={app_id} (JellyBot-Dev)")

    quote_query = env("JELLYBOT_SMOKE_QUOTE_QUERY", "arrested")
    series_query = env("JELLYBOT_SMOKE_SERIES_QUERY", "Simp")
    log_cmd = os.environ.get("JELLYBOT_SMOKE_LOG_CMD", "docker logs jellybot-dev")
    poll_sec = float(env("JELLYBOT_SMOKE_LOG_POLL_SEC", "45"))
    retry_count = int(env("JELLYBOT_SMOKE_RETRY_COUNT", "2"))
    retry_gap_sec = float(env("JELLYBOT_SMOKE_RETRY_GAP_SEC", "3"))

    client = __import__("discord").Client()

    @client.event
    async def on_ready() -> None:
        assert client.user is not None
        print(f"[smoke] user client {client.user} ({client.user.id})")
        channel = client.get_channel(channel_id) or await client.fetch_channel(channel_id)
        await assert_smoke_guild_channel(channel)

        async def check(name: str, ok: bool, detail: str) -> None:
            status = "OK" if ok else "FAIL"
            print(f"[{status}] {name}: {detail}")
            if not ok:
                failures.append(f"{name}: {detail}")

        async def autocomplete_quote(option: str, query: str, assess) -> None:
            recover_sec = int(env("JELLYBOT_SMOKE_HEALTH_RECOVER_SEC", "45"))
            for attempt in range(1, retry_count + 2):
                try:
                    wait_for_health(smoke_health_url(), timeout_sec=recover_sec)
                    assert_health_responsive(smoke_health_url(), timeout_sec=2.0)
                except TimeoutError as exc:
                    last_detail = str(exc)
                    if attempt <= retry_count:
                        print(
                            f"[smoke] health wedged before /quote {option}, "
                            f"retry {attempt}/{retry_count} (recover window {recover_sec}s)"
                        )
                        await asyncio.sleep(retry_gap_sec)
                        continue
                    await check(f"quote.{option}_autocomplete", False, last_detail)
                    return

                fire_at = time.time()
                quote = await find_slash_command(channel, app_id, "quote")
                assert isinstance(quote, SlashCommand)
                interaction = await fire_autocomplete(
                    client, channel, quote, option_name=option, query=query
                )
                print(
                    f"[smoke] fired /quote {option}={query!r} attempt={attempt} "
                    f"interaction_id={interaction.id} client_ok={interaction.successful!r}"
                )
                _, events = poll_bot_logs(
                    log_cmd,
                    since_epoch=fire_at,
                    timeout_sec=poll_sec,
                    event_prefix="quote.",
                    min_events=1,
                )
                result = assess(str(interaction.id), query, events, match_query_only=True)
                last_detail = result.detail
                if result.ok:
                    await check(f"quote.{option}_autocomplete", True, result.detail)
                    return
                if interaction.successful is False and "missing quote" in result.detail:
                    last_detail = (
                        f"{result.detail} (Discord client_ok=False — bot may still be processing; "
                        "increase JELLYBOT_SMOKE_LOG_POLL_SEC if logs arrive late)"
                    )
                if attempt <= retry_count:
                    print(f"[smoke] retry /quote {option} ({last_detail})")
                    await asyncio.sleep(retry_gap_sec)
                    continue
                await check(f"quote.{option}_autocomplete", False, last_detail)
                return

        # --- Required: the latency class that broke prod UX ---
        # Series first — lighter than FTS match search; match can wedge the loop briefly.
        try:
            await autocomplete_quote("series", series_query, assess_quote_series_autocomplete_logs)
        except Exception as exc:  # noqa: BLE001
            await check("quote.series_autocomplete", False, f"{type(exc).__name__}: {exc}")

        await asyncio.sleep(float(env("JELLYBOT_SMOKE_BETWEEN_QUOTE_SEC", "3")))

        try:
            await autocomplete_quote("match", quote_query, assess_quote_autocomplete_logs)
        except Exception as exc:  # noqa: BLE001
            await check("quote.match_autocomplete", False, f"{type(exc).__name__}: {exc}")

        long_quote_query = env(
            "JELLYBOT_SMOKE_LONG_QUOTE_QUERY",
            "that's it baby if you've got it flaunt it",
        )
        # Debounce/min-length supersede needs overlapping autocomplete HTTP posts.
        # discord.py-self's _wrapped_interaction awaits the full round-trip and
        # effectively serializes fires (~300ms+ between interaction snowflakes),
        # so prefix always completes before the next keystroke. Keep those gates
        # opt-in; unit tests cover the assessors + TS covers debounce behavior.
        debounce_live = env("JELLYBOT_SMOKE_DEBOUNCE_LIVE", "0") in {"1", "true", "yes"}
        debounce_prefix = env("JELLYBOT_SMOKE_DEBOUNCE_PREFIX", "arrest")
        debounce_final = env("JELLYBOT_SMOKE_DEBOUNCE_FINAL", "arrested")
        short_cancel_valid = env("JELLYBOT_SMOKE_SHORT_CANCEL_VALID", "arrested")
        short_cancel_below = env("JELLYBOT_SMOKE_SHORT_CANCEL_BELOW", "ab")
        burst_gap_sec = float(env("JELLYBOT_SMOKE_DEBOUNCE_BURST_MS", "80")) / 1000.0

        async def autocomplete_quote_burst(
            name: str,
            queries: list[str],
            assess_events,
            *,
            gap_sec: float,
            min_events: int = 1,
        ) -> None:
            recover_sec = int(env("JELLYBOT_SMOKE_HEALTH_RECOVER_SEC", "45"))
            for attempt in range(1, retry_count + 2):
                try:
                    wait_for_health(smoke_health_url(), timeout_sec=recover_sec)
                    assert_health_responsive(smoke_health_url(), timeout_sec=2.0)
                except TimeoutError as exc:
                    last_detail = str(exc)
                    if attempt <= retry_count:
                        print(
                            f"[smoke] health wedged before {name}, "
                            f"retry {attempt}/{retry_count} (recover window {recover_sec}s)"
                        )
                        await asyncio.sleep(retry_gap_sec)
                        continue
                    await check(name, False, last_detail)
                    return

                fire_at = time.time()
                quote = await find_slash_command(channel, app_id, "quote")
                assert isinstance(quote, SlashCommand)
                # Best-effort overlap: create_task + gap. Still often serializes
                # inside discord.py-self; see JELLYBOT_SMOKE_DEBOUNCE_LIVE note.
                fire_tasks: list[asyncio.Task] = []
                for index, query in enumerate(queries):
                    fire_tasks.append(
                        asyncio.create_task(
                            fire_autocomplete(
                                client, channel, quote, option_name="match", query=query
                            )
                        )
                    )
                    if index < len(queries) - 1:
                        await asyncio.sleep(gap_sec)
                interactions = await asyncio.gather(*fire_tasks)
                for index, (query, interaction) in enumerate(zip(queries, interactions)):
                    print(
                        f"[smoke] fired /quote match={query!r} burst={index + 1}/{len(queries)} "
                        f"interaction_id={interaction.id} client_ok={interaction.successful!r}"
                    )

                _, events = poll_bot_logs(
                    log_cmd,
                    since_epoch=fire_at,
                    timeout_sec=poll_sec,
                    event_prefix="quote.",
                    min_events=min_events,
                )
                result = assess_events(events)
                last_detail = result.detail
                if result.ok:
                    await check(name, True, result.detail)
                    return
                if attempt <= retry_count:
                    print(f"[smoke] retry {name} ({last_detail})")
                    await asyncio.sleep(retry_gap_sec)
                    continue
                await check(name, False, last_detail)
                return

        await asyncio.sleep(float(env("JELLYBOT_SMOKE_BETWEEN_QUOTE_SEC", "3")))

        try:
            await autocomplete_quote_burst(
                "quote.match_long_query_shaping",
                [long_quote_query],
                lambda events: assess_quote_shaping_logs(events, long_quote_query),
                gap_sec=0.0,
                min_events=2,
            )
        except Exception as exc:  # noqa: BLE001
            await check("quote.match_long_query_shaping", False, f"{type(exc).__name__}: {exc}")

        if debounce_live:
            await asyncio.sleep(float(env("JELLYBOT_SMOKE_BETWEEN_QUOTE_SEC", "3")))
            try:
                await autocomplete_quote_burst(
                    "quote.match_debounce_supersede",
                    [debounce_prefix, debounce_final],
                    lambda events: assess_quote_debounce_supersede_logs(
                        events, debounce_prefix, debounce_final
                    ),
                    gap_sec=burst_gap_sec,
                    min_events=2,
                )
            except Exception as exc:  # noqa: BLE001
                await check(
                    "quote.match_debounce_supersede", False, f"{type(exc).__name__}: {exc}"
                )

            await asyncio.sleep(float(env("JELLYBOT_SMOKE_BETWEEN_QUOTE_SEC", "3")))
            try:
                await autocomplete_quote_burst(
                    "quote.match_min_length_cancel",
                    [short_cancel_valid, short_cancel_below],
                    lambda events: assess_quote_min_length_cancel_logs(
                        events, short_cancel_valid, short_cancel_below
                    ),
                    gap_sec=burst_gap_sec,
                    min_events=1,
                )
            except Exception as exc:  # noqa: BLE001
                await check(
                    "quote.match_min_length_cancel", False, f"{type(exc).__name__}: {exc}"
                )
        else:
            print(
                "[smoke] skip quote debounce/min-length live gates "
                "(set JELLYBOT_SMOKE_DEBOUNCE_LIVE=1 to attempt; "
                "discord.py-self serializes autocomplete round-trips)"
            )

        if extended_smoke_enabled():
            clip_media_query = env("JELLYBOT_SMOKE_CLIP_MEDIA_QUERY", "Red")
            clip_item_id = env("JELLYBOT_SMOKE_ITEM_ID", "6ef4f7234b7793e6788f1bf9ccc19b70")
            supercut_series_query = env("JELLYBOT_SMOKE_SUPERCUT_SERIES_QUERY", "Red")

            try:
                log_start = bot_log_line_count(log_cmd)
                clip = await find_slash_command(channel, app_id, "clip")
                assert isinstance(clip, SlashCommand)
                await fire_autocomplete(
                    client,
                    channel,
                    clip,
                    option_name="media",
                    query=clip_media_query,
                    preset_options=[{"type": 3, "name": "kind", "value": "tv"}],
                )
                await asyncio.sleep(poll_sec if poll_sec <= 8 else 8)
                events = parse_json_log_events(
                    fetch_bot_logs_tail(log_cmd, since_line=log_start), event_prefix="clip."
                )
                result = assess_field_autocomplete_logs(
                    events,
                    event_name="clip.autocomplete",
                    query=clip_media_query,
                    field="media",
                    kind="tv",
                )
                await check("clip.media_autocomplete", result.ok, result.detail)
            except Exception as exc:  # noqa: BLE001
                await check("clip.media_autocomplete", False, f"{type(exc).__name__}: {exc}")

            try:
                clip = await find_slash_command(channel, app_id, "clip")
                assert isinstance(clip, SlashCommand)
                print(f"[smoke] invoking /clip tv item={clip_item_id[:8]}…")
                log_start = bot_log_line_count(log_cmd)
                interaction = await clip(
                    kind="tv", media=clip_item_id, start="1:00", duration="8s"
                )
                await asyncio.sleep(poll_sec if poll_sec <= 8 else 8)
                logs = fetch_bot_logs_tail(log_cmd, since_line=log_start)
                ok = interaction.successful and log_has_event(logs, "clip.requested")
                ok = ok and log_lacks_event(logs, "clip.error")
                await check(
                    "clip.invoke",
                    ok,
                    f"successful={interaction.successful!r}, clip.requested={log_has_event(logs, 'clip.requested')}",
                )
            except Exception as exc:  # noqa: BLE001
                await check("clip.invoke", False, f"{type(exc).__name__}: {exc}")

            try:
                log_start = bot_log_line_count(log_cmd)
                supercut = await find_slash_command(channel, app_id, "supercut")
                await fire_autocomplete(
                    client,
                    channel,
                    supercut,
                    option_name="series",
                    query=supercut_series_query,
                    preset_options=[{"type": 3, "name": "phrase", "value": "yeah"}],
                )
                await asyncio.sleep(poll_sec if poll_sec <= 8 else 8)
                events = parse_json_log_events(
                    fetch_bot_logs_tail(log_cmd, since_line=log_start),
                    event_prefix="supercut.",
                )
                result = assess_field_autocomplete_logs(
                    events,
                    event_name="supercut.autocomplete",
                    query=supercut_series_query,
                    field="series",
                )
                await check("supercut.series_autocomplete", result.ok, result.detail)
            except Exception as exc:  # noqa: BLE001
                await check("supercut.series_autocomplete", False, f"{type(exc).__name__}: {exc}")

        await client.close()

    await client.start(token)
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Smoke: user-token slash commands on JellyBot-Dev (Bottitesto)"
    )
    parser.add_argument("--skip-health", action="store_true")
    parser.add_argument("--discord-only", action="store_true")
    args = parser.parse_args()
    skip_health = args.skip_health or args.discord_only

    load_smoke_env()

    if not skip_health:
        print("=== smoke: wait for dev bot ===")
        try:
            health = wait_for_health(
                smoke_health_url(),
                timeout_sec=int(env("JELLYBOT_SMOKE_HEALTH_TIMEOUT_SEC", "120")),
            )
            assert_health_responsive(smoke_health_url(), timeout_sec=2.0)
            index = health.get("subtitleIndex") or {}
            print(
                f"[OK] JellyBot-Dev up: discord={health.get('discord')} "
                f"subtitleItems={index.get('itemCount')}"
            )
        except TimeoutError as exc:
            print(f"[FAIL] {exc}")
            return 1

    settle = int(env("JELLYBOT_SMOKE_SETTLE_SEC", "20"))
    print(f"=== smoke: discord user impersonation (settle {settle}s) ===")
    time.sleep(settle)

    failures = asyncio.run(run_discord_smokes())

    if failures:
        print("\n=== smoke FAILED — users would hit this in Discord ===")
        for item in failures:
            print(f"  - {item}")
        return 1

    print("\n=== smoke PASSED — quote autocomplete + long-query shaping OK ===")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
