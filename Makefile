.PHONY: test register-commands index-subtitles dev-refresh up logs health build-runtime smoke smoke-preflight smoke-ci smoke-discord smoke-discord-quote smoke-discord-all smoke-discord-support-test

build-runtime:
	docker compose --profile app build jellybot

test:
	docker compose --profile test build jellybot-tests
	docker compose --profile test run --rm jellybot-tests

register-commands: build-runtime
	docker compose --profile register run --rm jellybot-register-commands

index-subtitles: build-runtime
	docker compose --profile index run --rm jellybot-index-subtitles

index-subtitles-incremental: build-runtime
	docker compose --profile index run --rm jellybot-index-subtitles bun run src/cli/index-subtitles.ts --incremental

dev-refresh:
	docker compose --profile app up -d --build jellybot

up:
	docker compose --profile app up -d --build

logs:
	docker logs -f jellybot-dev

health:
	curl -fsS $${JELLYBOT_SMOKE_HEALTH_URL:-http://127.0.0.1:8093/healthz} | jq .

smoke:
	DISCORD_PY_SELF_ROOT=$${DISCORD_PY_SELF_ROOT:-$$HOME/coding/discord.py-self} \
	JELLYBOT_SMOKE_LOG_CMD=$${JELLYBOT_SMOKE_LOG_CMD:-docker logs jellybot-dev} \
	JELLYBOT_SMOKE_HEALTH_URL=$${JELLYBOT_SMOKE_HEALTH_URL:-http://127.0.0.1:8093/healthz} \
	python3 scripts/smoke-dev-bot.py

smoke-preflight:
	docker compose --profile app exec -T jellybot bun run src/cli/smoke-live.ts

smoke-ci:
	bash scripts/smoke-ci.sh

smoke-discord-support-test:
	python3 scripts/test_discord_smoke_support.py

smoke-discord-quote:
	DISCORD_PY_SELF_ROOT=$${DISCORD_PY_SELF_ROOT:-$$HOME/coding/discord.py-self} bun run smoke:discord:quote

smoke-discord:
	DISCORD_PY_SELF_ROOT=$${DISCORD_PY_SELF_ROOT:-$$HOME/coding/discord.py-self} bun run smoke:discord

smoke-discord-all:
	DISCORD_PY_SELF_ROOT=$${DISCORD_PY_SELF_ROOT:-$$HOME/coding/discord.py-self} bun run smoke:discord:all
