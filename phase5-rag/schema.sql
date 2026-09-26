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
