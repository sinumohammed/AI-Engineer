#!/bin/bash
# Starts the Phase 10 copy on this Mac: Docker + Postgres + Redis, the API server (3002), the web UI (5174).
# Postgres and Redis are the same local containers the frozen app uses, started from their own
# folders (phase5-rag, phase6-ui) - nothing in those folders is changed.
# Usage: ./start.sh     (Ctrl+C stops the API server and web UI; Postgres and Redis keep running)

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"
API_PORT="${PORT:-3002}"
API_PID=""
WEB_PID=""

# npm spawns node as a child, so killing npm alone leaves the server running - kill the whole tree
kill_tree() {
  local child
  for child in $(pgrep -P "$1"); do
    kill_tree "$child"
  done
  kill -TERM "$1" 2>/dev/null
}

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Stopping API server and web UI (Postgres and Redis keep running)..."
  [ -n "$API_PID" ] && kill_tree "$API_PID"
  [ -n "$WEB_PID" ] && kill_tree "$WEB_PID"
  wait 2>/dev/null
  exit 0
}

if [ ! -f "$DIR/.env" ]; then
  echo "No .env in $DIR. Copy .env.example to .env first."
  exit 1
fi

# --- 1. Docker ---
if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker Desktop..."
  open -ga Docker
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  if ! docker info >/dev/null 2>&1; then
    echo "Docker did not start within 2 minutes. Open Docker Desktop and try again."
    exit 1
  fi
fi
echo "Docker is running."

# --- 2. Postgres and Redis (the frozen app's containers) ---
(cd "$ROOT/phase5-rag" && docker compose up -d) || exit 1
(cd "$ROOT/phase6-ui" && docker compose up -d) || exit 1
for i in $(seq 1 30); do
  (cd "$ROOT/phase6-ui" && docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG) && break
  sleep 1
done
if ! (cd "$ROOT/phase6-ui" && docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG); then
  echo "Redis did not come up. Check: cd ../phase6-ui && docker compose logs redis"
  exit 1
fi
echo "Postgres is on port 5432, Redis on port 6379."

# --- 3. Ollama (the agent needs it; just warn) ---
if ! curl -s -m 2 -o /dev/null http://localhost:11434; then
  echo "WARNING: Ollama is not responding on port 11434. Open the Ollama app."
fi

trap cleanup INT TERM EXIT

# --- 4. API server ---
if lsof -iTCP:"$API_PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
  echo "Port $API_PORT is already in use - assuming the API server is already running, not starting another."
else
  (cd "$DIR/api" && exec npm start) </dev/null > >(sed -l 's/^/[api] /') 2>&1 &
  API_PID=$!
fi

# --- 5. Web UI ---
(cd "$DIR/web" && exec npm run dev) </dev/null > >(sed -l 's/^/[web] /') 2>&1 &
WEB_PID=$!

echo "Started. Open http://localhost:5174 - press Ctrl+C to stop the API server and web UI."

# Stay up until either process exits (bash 3.2 on macOS has no `wait -n`)
while true; do
  [ -n "$API_PID" ] && ! kill -0 "$API_PID" 2>/dev/null && { echo "API server exited."; break; }
  ! kill -0 "$WEB_PID" 2>/dev/null && { echo "Web UI exited."; break; }
  sleep 1
done
cleanup
