#!/bin/bash
set -euo pipefail

git pull origin main

docker compose up -d --build

echo "Waiting for container to become healthy..."
TIMEOUT=180
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' counterpart-monitor 2>/dev/null || echo "not_found")
  case "$STATUS" in
    healthy)
      echo "Container is healthy."
      docker compose ps
      exit 0
      ;;
    unhealthy)
      echo "ERROR: Container is unhealthy."
      docker compose logs --tail=200 monitor
      exit 1
      ;;
    *)
      sleep 10
      ELAPSED=$((ELAPSED + 10))
      ;;
  esac
done

echo "ERROR: Health check timed out after ${TIMEOUT}s."
docker compose logs --tail=200 monitor
exit 1
