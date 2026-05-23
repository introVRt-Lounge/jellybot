.PHONY: test register-commands dev-refresh up logs health

test:
	docker compose --profile test build jellybot-tests
	docker compose --profile test run --rm jellybot-tests

register-commands:
	docker compose --profile register run --rm jellybot-register-commands

dev-refresh:
	docker compose --profile app up -d --build --force-recreate jellybot

up:
	docker compose --profile app up -d --build

logs:
	docker logs -f jellybot

health:
	curl -fsS http://127.0.0.1:8080/healthz | jq .
