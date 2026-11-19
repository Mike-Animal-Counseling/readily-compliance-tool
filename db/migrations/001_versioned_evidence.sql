BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS readily_v1;

CREATE TABLE readily_v1.tenants (
  id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  active_snapshot_id uuid
);

CREATE TABLE readily_v1.api_keys (
  digest text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES readily_v1.tenants ON DELETE CASCADE,
  label text NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE readily_v1.document_versions (
  tenant_id uuid NOT NULL REFERENCES readily_v1.tenants ON DELETE CASCADE,
  id uuid NOT NULL,
  document_key text NOT NULL,
  file_name text NOT NULL,
  sha256 text NOT NULL,
  pdf bytea NOT NULL,
  parser_version text NOT NULL,
  warnings jsonb NOT NULL,
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 30),
  effective_from date NOT NULL,
  effective_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE readily_v1.parents (
  tenant_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  id text NOT NULL,
  block jsonb NOT NULL,
  PRIMARY KEY (tenant_id, document_version_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES readily_v1.document_versions ON DELETE CASCADE
);

CREATE TABLE readily_v1.clause_locations (
  tenant_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  parent_id text NOT NULL,
  clause text NOT NULL,
  PRIMARY KEY (tenant_id, document_version_id, parent_id, clause),
  FOREIGN KEY (tenant_id, document_version_id, parent_id) REFERENCES readily_v1.parents ON DELETE CASCADE
);

CREATE TABLE readily_v1.snapshots (
  tenant_id uuid NOT NULL REFERENCES readily_v1.tenants ON DELETE CASCADE,
  id uuid NOT NULL,
  embedding_version text NOT NULL,
  index_version text NOT NULL,
  entry_count integer NOT NULL CHECK (entry_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE readily_v1.tenants ADD FOREIGN KEY (id, active_snapshot_id)
  REFERENCES readily_v1.snapshots (tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE readily_v1.snapshot_documents (
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, snapshot_id, document_version_id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES readily_v1.snapshots ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES readily_v1.document_versions
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE readily_v1.index_entries (
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  parent_id text NOT NULL,
  child_id text NOT NULL,
  unit_ids text[] NOT NULL CHECK (cardinality(unit_ids) > 0),
  clauses text[] NOT NULL,
  search tsvector NOT NULL,
  embedding vector(128) NOT NULL,
  PRIMARY KEY (tenant_id, snapshot_id, document_version_id, child_id),
  FOREIGN KEY (tenant_id, snapshot_id, document_version_id) REFERENCES readily_v1.snapshot_documents ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_version_id, parent_id) REFERENCES readily_v1.parents
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE readily_v1.activations (
  tenant_id uuid NOT NULL REFERENCES readily_v1.tenants ON DELETE CASCADE,
  id bigint GENERATED ALWAYS AS IDENTITY,
  new_snapshot_id uuid NOT NULL,
  previous_snapshot_id uuid,
  activated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE readily_v1.reports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  as_of date NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES readily_v1.snapshots
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE readily_v1.reviews (
  tenant_id uuid NOT NULL,
  report_id uuid NOT NULL,
  revision bigint GENERATED ALWAYS AS IDENTITY,
  reviewer text NOT NULL,
  state text NOT NULL CHECK (state IN ('approved', 'needs_review')),
  notes text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, report_id, revision),
  FOREIGN KEY (tenant_id, report_id) REFERENCES readily_v1.reports ON DELETE CASCADE
);

CREATE TABLE readily_v1.requests (
  tenant_id uuid NOT NULL REFERENCES readily_v1.tenants ON DELETE CASCADE,
  operation text NOT NULL,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation, request_key)
);

COMMIT;
