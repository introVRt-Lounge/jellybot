.PHONY: test register-commands index-subtitles dev-refresh up logs health build-runtime

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
	docker logs -f jellybot

health:
	curl -fsS http://127.0.0.1:8080/healthz | jq .
