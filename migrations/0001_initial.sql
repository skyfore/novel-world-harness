BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  language text NOT NULL DEFAULT 'zh-CN',
  status text NOT NULL DEFAULT 'building',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_path text,
  title text NOT NULL,
  content_sha256 text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS source_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  parent_segment_id uuid REFERENCES source_segments(id) ON DELETE SET NULL,
  kind text NOT NULL,
  ordinal bigint NOT NULL,
  start_offset bigint,
  end_offset bigint,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(document_id, kind, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_source_segments_document ON source_segments(document_id, ordinal);

CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  canonical_name text NOT NULL,
  stable_key text NOT NULL,
  immutable_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, stable_key)
);

CREATE INDEX IF NOT EXISTS idx_entities_project_type ON entities(project_id, entity_type);

CREATE TABLE IF NOT EXISTS entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias text NOT NULL,
  valid_from jsonb,
  valid_until jsonb,
  evidence_segment_id uuid REFERENCES source_segments(id) ON DELETE SET NULL,
  UNIQUE(entity_id, alias)
);

CREATE TABLE IF NOT EXISTS claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  predicate text NOT NULL,
  object_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  object_value jsonb,
  claim_type text NOT NULL,
  confidence double precision NOT NULL DEFAULT 1.0,
  valid_from jsonb,
  valid_until jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  segment_id uuid NOT NULL REFERENCES source_segments(id) ON DELETE CASCADE,
  weight double precision NOT NULL DEFAULT 1.0,
  PRIMARY KEY(claim_id, segment_id)
);

CREATE TABLE IF NOT EXISTS relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate text NOT NULL,
  object_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  valid_from jsonb,
  valid_until jsonb,
  confidence double precision NOT NULL DEFAULT 1.0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(project_id, subject_entity_id, predicate);
CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(project_id, object_entity_id, predicate);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stable_key text NOT NULL,
  event_type text NOT NULL,
  title text,
  time_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  location_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  preconditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence double precision NOT NULL DEFAULT 1.0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, stable_key)
);

CREATE TABLE IF NOT EXISTS event_participants (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'participant',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(event_id, entity_id, role)
);

CREATE TABLE IF NOT EXISTS event_evidence (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  segment_id uuid NOT NULL REFERENCES source_segments(id) ON DELETE CASCADE,
  weight double precision NOT NULL DEFAULT 1.0,
  PRIMARY KEY(event_id, segment_id)
);

CREATE TABLE IF NOT EXISTS state_deltas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  reducer_version text NOT NULL DEFAULT 'v1',
  operations jsonb NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  parent_branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  fork_event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  fork_time jsonb,
  is_canon boolean NOT NULL DEFAULT false,
  divergence_score double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS runtime_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  sequence_no bigint NOT NULL,
  actor_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  proposal jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_delta jsonb NOT NULL DEFAULT '[]'::jsonb,
  committed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(branch_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS world_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  sequence_no bigint NOT NULL,
  world_time jsonb,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(branch_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS knowledge_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  actor_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  proposition jsonb NOT NULL,
  epistemic_status text NOT NULL,
  confidence double precision NOT NULL DEFAULT 1.0,
  learned_at_sequence bigint,
  invalidated_at_sequence bigint,
  source_runtime_event_id uuid REFERENCES runtime_events(id) ON DELETE SET NULL,
  source_canon_event_id uuid REFERENCES events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_actor ON knowledge_facts(branch_id, actor_entity_id);

CREATE TABLE IF NOT EXISTS character_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  character_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  objective jsonb NOT NULL,
  priority double precision NOT NULL,
  valid_from jsonb,
  valid_until jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence double precision NOT NULL DEFAULT 0.5
);

CREATE TABLE IF NOT EXISTS character_models (
  character_entity_id uuid PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  model_version text NOT NULL DEFAULT 'v1',
  traits jsonb NOT NULL DEFAULT '{}'::jsonb,
  values_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  cognitive_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  social_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence double precision NOT NULL DEFAULT 0.5,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS harness_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  target_type text,
  target_id text,
  priority double precision NOT NULL DEFAULT 0.5,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_harness_jobs_pick ON harness_jobs(project_id, status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS harness_metrics (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  metric text NOT NULL,
  value double precision NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  measured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, metric)
);

COMMIT;
