"""Discord client helpers for jellybot live smoke tests."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from discord_smoke_support import jellybot_repo_root, load_smoke_env


def prepare_discord_import() -> Path:
    load_smoke_env()
    dpy_self_root = Path(
        os.environ.get("DISCORD_PY_SELF_ROOT", "~/coding/discord.py-self")
    ).expanduser().resolve()
    os.environ.setdefault("DISCORD_PY_SELF_ROOT", str(dpy_self_root))
    sys.path.insert(0, str(dpy_self_root))
    return dpy_self_root


def smoke_channel_id() -> int:
    for key in ("JELLYBOT_SMOKE_CHANNEL_ID", "DISCORD_TEST_CHANNEL_ID", "NOTIFICATION_CHANNEL_ID"):
        raw = os.environ.get(key, "").strip()
        if raw:
            return int(raw)
    raise RuntimeError(
        "Set JELLYBOT_SMOKE_CHANNEL_ID, NOTIFICATION_CHANNEL_ID (jellybot .env), "
        "or DISCORD_TEST_CHANNEL_ID (discord.py-self .env)"
    )


def require_smoke_credentials() -> tuple[str, int, int]:
    token = os.environ.get("DISCORD_USER_TOKEN", "").strip()
    app_id = int(os.environ.get("DISCORD_CLIENT_ID", "0"))
    channel_id = smoke_channel_id()
    if not token or not app_id:
        raise RuntimeError(
            "Missing DISCORD_USER_TOKEN or DISCORD_CLIENT_ID "
            "(jellybot-dev/.env + discord.py-self/.env)"
        )
    return token, app_id, channel_id


async def assert_smoke_guild_channel(channel: Any) -> None:
    """Smoke must run in the dev bot guild (Bottitesto), not prod-only channels."""
    expected = os.environ.get("DISCORD_GUILD_ID", "").strip()
    guild = getattr(channel, "guild", None)
    if guild is None:
        raise RuntimeError(
            f"smoke channel {channel.id} has no guild — use a Bottitesto text channel, not a DM"
        )
    if expected and str(guild.id) != expected:
        raise RuntimeError(
            f"smoke channel guild {guild.id} != DISCORD_GUILD_ID {expected} "
            "(point JELLYBOT_SMOKE_CHANNEL_ID at a Bottitesto channel for JellyBot-Dev)"
        )
    print(f"[smoke] guild={guild.id} #{getattr(channel, 'name', '?')}")


async def fire_autocomplete(
    client: Any,
    channel: Any,
    command: Any,
    *,
    option_name: str,
    query: str,
    preset_options: list[dict[str, Any]] | None = None,
) -> Any:
    from discord.enums import InteractionType
    from discord.interactions import _wrapped_interaction
    from discord.utils import _generate_nonce

    options = list(preset_options or [])
    options.append(
        {
            "type": 3,
            "name": option_name,
            "value": query,
            "focused": True,
        }
    )

    data: dict[str, Any] = {
        "application_command": command._data,
        "attachments": [],
        "id": str(command.id),
        "name": command.name,
        "type": 1,
        "version": str(command.version),
        "options": options,
    }
    if command.guild_id:
        data["guild_id"] = str(command.guild_id)
    elif getattr(channel, "guild", None) is not None:
        data["guild_id"] = str(channel.guild.id)

    nonce = _generate_nonce()
    return await _wrapped_interaction(
        client._connection,
        nonce,
        InteractionType.autocomplete,
        command.name,
        await channel._get_channel(),  # type: ignore[attr-defined]
        data,
        application_id=command.application_id,
    )


async def find_slash_command(channel: Any, app_id: int, name: str) -> Any:
    cmds = await channel.application_commands()
    command = next((c for c in cmds if c.application_id == app_id and c.name == name), None)
    if command is None:
        raise RuntimeError(f"/{name} not found for app_id={app_id} in channel {channel.id}")
    return command


def repo_root() -> Path:
    return jellybot_repo_root()
