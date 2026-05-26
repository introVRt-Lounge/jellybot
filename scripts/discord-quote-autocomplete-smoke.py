#!/usr/bin/env python3
"""Live Discord smoke for jellybot /quote match autocomplete (user token).

Canonical entry: `bun run smoke:discord:quote` (see docs/DISCORD_SMOKE_TESTING.md).

Loads:
  - jellybot/.env for DISCORD_CLIENT_ID
  - $DISCORD_PY_SELF_ROOT/.env for DISCORD_USER_TOKEN, DISCORD_TEST_CHANNEL_ID

Pass/fail is determined by structured prod bot logs (quote.autocomplete.responded),
not client-side choice payloads (discord.py-self often reports client_choices=0).
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from discord_smoke_support import (
    assess_quote_autocomplete_logs,
    fetch_bot_logs,
    jellybot_repo_root,
    load_env,
    parse_json_log_events,
)


def repo_paths() -> tuple[Path, Path]:
    jellybot_root = jellybot_repo_root()
    dpy_self_root = Path(os.environ["DISCORD_PY_SELF_ROOT"]).expanduser().resolve()
    return jellybot_root, dpy_self_root


async def main() -> int:
    jellybot_root, dpy_self_root = repo_paths()
    sys.path.insert(0, str(dpy_self_root))

    load_env(jellybot_root / ".env")
    load_env(dpy_self_root / ".env")

    import discord
    from discord import SlashCommand
    from discord.enums import InteractionType
    from discord.interactions import _wrapped_interaction
    from discord.utils import _generate_nonce

    token = os.environ.get("DISCORD_USER_TOKEN", "").strip()
    app_id = int(os.environ.get("DISCORD_CLIENT_ID", "0"))
    channel_id = int(os.environ.get("DISCORD_TEST_CHANNEL_ID", "0"))
    query = os.environ.get("JELLYBOT_SMOKE_QUOTE_QUERY", "carrot").strip()
    log_cmd = os.environ.get("JELLYBOT_SMOKE_LOG_CMD", "docker logs jellybot 2>&1").strip()

    if not token or not app_id or not channel_id:
        print("Missing DISCORD_USER_TOKEN, DISCORD_CLIENT_ID, or DISCORD_TEST_CHANNEL_ID")
        return 2

    exit_code = 1
    client = discord.Client()

    @client.event
    async def on_ready() -> None:
        nonlocal exit_code
        assert client.user is not None
        print(f"Logged in as {client.user} ({client.user.id})")
        ch = client.get_channel(channel_id) or await client.fetch_channel(channel_id)
        cmds = await ch.application_commands()
        quote = next((c for c in cmds if c.application_id == app_id and c.name == "quote"), None)
        if quote is None:
            print(f"[FAIL] quote command not found for app_id={app_id} in channel {channel_id}")
            exit_code = 1
            await client.close()
            return

        assert isinstance(quote, SlashCommand)
        match_opt = next((o for o in quote.options if o.name == "match"), None)
        print(
            f"Found /quote id={quote.id} version={quote.version} "
            f"match_autocomplete={getattr(match_opt, 'autocomplete', None)}"
        )

        data = {
            "application_command": quote._data,
            "attachments": [],
            "id": str(quote.id),
            "name": quote.name,
            "type": 1,
            "version": str(quote.version),
            "options": [
                {
                    "type": 3,
                    "name": "match",
                    "value": query,
                    "focused": True,
                }
            ],
        }
        if quote.guild_id:
            data["guild_id"] = str(quote.guild_id)

        nonce = _generate_nonce()
        print(f"Sending autocomplete for match={query!r} nonce={nonce}")
        try:
            interaction = await _wrapped_interaction(
                client._connection,
                nonce,
                InteractionType.autocomplete,
                quote.name,
                await ch._get_channel(),  # type: ignore[attr-defined]
                data,
                application_id=quote.application_id,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[FAIL] autocomplete invoke failed: {type(exc).__name__}: {exc}")
            exit_code = 1
            await client.close()
            return

        interaction_id = str(interaction.id)
        await asyncio.sleep(1.5)
        print(
            f"[INFO] interaction_id={interaction_id} "
            f"client_successful={interaction.successful!r} "
            f"(client choice payloads not used as pass gate)"
        )

        log_text = fetch_bot_logs(log_cmd)
        events = parse_json_log_events(log_text, event_prefix="quote.autocomplete")
        assessment = assess_quote_autocomplete_logs(interaction_id, query, events)

        if assessment.search_line:
            print(f"  search: {assessment.search_line}")
        if assessment.outcome_line:
            print(f"  outcome: {assessment.outcome_line}")

        if assessment.ok:
            print(f"[OK] {assessment.detail}")
            exit_code = 0
        else:
            print(f"[FAIL] {assessment.detail}")
            if not events:
                print(f"  hint: no quote.autocomplete events in bot logs; check JELLYBOT_SMOKE_LOG_CMD={log_cmd!r}")
            exit_code = 1

        await client.close()

    await client.start(token)
    return exit_code


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        raise SystemExit(130)
