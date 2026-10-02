# Phase 6 UI - How to start the app

Three things need to be running, in this order:

1. Redis (in Docker) - session storage, port 6379
2. API server - port 3001
3. Web UI (Vite) - port 5173

Ollama must also be running (it is whenever the Ollama app is open).

## Quick start (one command)

```bash
cd ~/Code/AI-Engineer/phase6-ui
./start.sh
```

This opens Docker Desktop if needed, starts Redis, then runs the API server and
web UI together in one terminal (lines are prefixed `[api]` and `[web]`).
Press `Ctrl+C` to stop the API server and web UI. Redis keeps running.

The manual steps below do the same thing one piece at a time.

## 1. Docker and Redis

Open the Docker Desktop app and wait until the engine is running.

Redis is set to `restart: unless-stopped`, so it normally starts by itself.
Check the **Containers** tab: `phase6-ui` > `redis-1` should show as running.

- If it shows as stopped, click the **Start** (play) button next to `phase6-ui`.
- If `phase6-ui` is not in the list at all, create it from the terminal:

```bash
cd ~/Code/AI-Engineer/phase6-ui
docker compose up -d
docker compose ps        # redis should show as "Up"
```

## 2. API server

In a new terminal tab:

```bash
cd ~/Code/AI-Engineer/phase6-ui/server
npm start
```

Wait for `Phase 6 API listening on http://localhost:3001`.

## 3. Web UI

In another terminal tab:

```bash
cd ~/Code/AI-Engineer/phase6-ui/web
npm run dev
```

Open the URL it prints (default http://localhost:5173).

## Stopping and restarting

- **API server or web UI:** press `Ctrl+C` in its terminal, then run the same command again.
- **Redis:** from `phase6-ui`, `docker compose restart redis` restarts it and `docker compose stop` stops it.
  `docker compose down` removes the container, so the next start needs `docker compose up -d`.

## Troubleshooting

- **`[sessionStore] Redis connection error` repeating, server never says "listening":**
  Redis is not running. Do step 1, the server connects by itself once Redis is up.
- **Port 3001 already in use:** another copy of the API server is running.
  Find it with `lsof -iTCP:3001 -sTCP:LISTEN` and stop it with `kill <PID>`.
- **`Cannot connect to the Docker daemon`:** Docker Desktop is not open yet.
