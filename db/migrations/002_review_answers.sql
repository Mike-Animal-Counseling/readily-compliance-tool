BEGIN;
ALTER TABLE readily_v1.reviews ADD COLUMN answer_override text;
ALTER TABLE readily_v1.reports ADD FOREIGN KEY (tenant_id)
  REFERENCES readily_v1.tenants ON DELETE CASCADE;
COMMIT;
