#!/usr/bin/env python3
"""Live Discord smoke for jellybot /clip using discord.py-self (user token).

Loads:
  - jellybot/.env for DISCORD_CLIENT_ID
  - discord.py-self/.env for DISCORD_USER_TOKEN, DISCORD_TEST_GUILD_ID, DISCORD_TEST_CHANNEL_ID

Non-authoritative adjunct per discord-user-token-smoke-testing skill.
"""

from __future__ import annotations

import asyncio
import os
import sys
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
        os.environ.setdefault(key, val)


def repo_paths() -> tuple[Path, Path]:
    script = Path(__file__).resolve()
    jellybot_root = script.parents[1]
    dpy_self_root = Path.home() / "coding" / "discord.py-self"
    return jellybot_root, dpy_self_root


async def main() -> int:
    jellybot_root, dpy_self_root = repo_paths()
    sys.path.insert(0, str(dpy_self_root))

    load_env(jellybot_root / ".env")
    load_env(dpy_self_root / ".env")

    import discord
    from discord import SlashCommand

    token = os.environ.get("DISCORD_USER_TOKEN", "").strip()
    app_id = int(os.environ.get("DISCORD_CLIENT_ID", "0"))
    channel_id = int(os.environ.get("DISCORD_TEST_CHANNEL_ID", "0"))
    item_id = os.environ.get("JELLYBOT_SMOKE_ITEM_ID", "04805f2c0801c4b6373a10cd265fb610").strip()

    if not token or not app_id or not channel_id:
        print("Missing DISCORD_USER_TOKEN, DISCORD_CLIENT_ID, or DISCORD_TEST_CHANNEL_ID")
        return 2

    client = discord.Client()

    @client.event
    async def on_ready() -> None:
        assert client.user is not None
        print(f"Logged in as {client.user} ({client.user.id})")
        ch = client.get_channel(channel_id) or await client.fetch_channel(channel_id)
        cmds = await ch.application_commands()
        clip = next((c for c in cmds if c.application_id == app_id and c.name == "clip"), None)
        if clip is None:
            print(f"clip command not found for app_id={app_id} in channel {channel_id}")
            await client.close()
            return

        assert isinstance(clip, SlashCommand)
        print("Invoking /clip with known episode id (bypasses autocomplete UI)")
        try:
            interaction = await clip(
                kind="tv",
                media=item_id,
                start="1:00",
                duration="10s",
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[ERR] invoke failed: {type(exc).__name__}: {exc}")
            await client.close()
            return

        print(f"[OK] successful={interaction.successful!r} message={interaction.message!r}")
        await client.close()

    await client.start(token)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        raise SystemExit(130)
