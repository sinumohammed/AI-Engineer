CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS doc_chunks (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(768)
);

CREATE INDEX IF NOT EXISTS doc_chunks_embedding_idx
  ON doc_chunks USING hnsw (embedding vector_cosine_ops);

-- Phase 5.6: hybrid search. Pure vector search can't reliably tell apart
-- similar-looking exact codes/IDs (proved live: a made-up equipment code
-- scored nearly as close as the real one). Full-text search's phrase-
-- adjacency lexing of hyphenated tokens (e.g. 'xj' <-> '-2200') gives an
-- exact-match signal vector search can't, so we run both and merge.
ALTER TABLE doc_chunks ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS doc_chunks_content_tsv_idx
  ON doc_chunks USING gin (content_tsv);
