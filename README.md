# AI Engineer

A hands-on learning project: build an AI system one capability at a time, on a local model, and prove
each step works before starting the next. It goes from a first model call to a multi-agent chat app
with retrieval over company documents.

Everything runs locally with [Ollama](https://ollama.com). No cloud model is needed.

## Start here

| Read | For |
|---|---|
| **[Learning guide (web page with diagrams)](https://sinumohammed.github.io/AI-Engineer/)** | The whole project step by step, with a flow diagram for each mechanism |
| [`LEARNING_GUIDE.md`](LEARNING_GUIDE.md) | The same guide as Markdown, plus the commit for each step |
| [`ROADMAP.md`](ROADMAP.md) | The detailed log: every experiment, measurement and dead end |

## What is in here

| Folder | Phase | What it is |
|---|---|---|
| `phase2-node-ollama/` | 2 | Calling a local model from Node.js |
| `phase3-node-agent/` | 3 | A hand-written agent loop with tools |
| `phase4-mcp/` | 4 | The same tools behind an MCP server |
| `phase5-rag/` | 5, 5.5, 5.6 | RAG over company documents: Postgres + pgvector, hybrid search |
| `phase6-ui/` | 6 to 6.11, 8c | The chat app: React, Express, Redis sessions |
| `phase7-reliability/` | 7 | The eval suite |
| `phase8-framework/` | 8a | The agent rebuilt with LangChain.js |
| `phase8b-multi-agent/` | 8b | A router plus three specialist agents, hand-written and in LangGraph |

## Run the chat app

You need Node, Ollama and Docker Desktop.

```bash
ollama pull qwen3-coder:30b
ollama pull nomic-embed-text

cd phase5-rag
cp .env.example .env
npm install
docker compose up -d
docker exec -i phase5-rag-db-1 psql -U rag -d rag < schema.sql   # new database only
npm run ingest

cd ../phase6-ui
(cd server && npm install) && (cd web && npm install)
./start.sh
```

Then open http://localhost:5173. The header has a switch between the single agent and the
multi-agent supervisor, so the same question can be asked both ways.

`qwen3-coder:30b` needs about 21 GB of memory when loaded. To use a smaller model, change `CHAT_MODEL`
in `phase5-rag/.env`.

## Run the tests

```bash
cd phase7-reliability && node --env-file=../phase5-rag/.env eval.js   # single agent
cd phase8b-multi-agent && npm install && npm run eval                  # multi-agent
```

## What the project taught

- A prompt is advice, not a rule. Three times a stricter prompt failed where a change in code worked.
- If code can decide, let code decide.
- Re-run old tests after every change: most bugs were regressions.
- More agents means more places to fail.
- A bigger model is not always needed: a 4 GB model matched a 21 GB one for reading a document and answering.

The full list, with the evidence behind each, is in the learning guide.
