BEGIN;
ALTER TABLE readily_v1.reviews ADD COLUMN answer_override text;
COMMIT;
