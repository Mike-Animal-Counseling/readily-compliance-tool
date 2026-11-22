BEGIN;
ALTER TABLE readily_v1.index_entries ADD COLUMN IF NOT EXISTS rerank_text text
  CHECK (char_length(rerank_text) <= 1200);
COMMIT;
