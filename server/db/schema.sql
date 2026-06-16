-- SCM Workflow — PostgreSQL schema
-- Run in pgAdmin: create database first, then open Query Tool on that database and run this file.
--
-- 1. Right-click Databases → Create → Database… → name: scm_workflow
-- 2. Select scm_workflow → Tools → Query Tool → paste & execute this script

CREATE TABLE IF NOT EXISTS workflow_quotes (
  id UUID PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_quotes_saved_by
  ON workflow_quotes ((data->>'savedBy'));

CREATE INDEX IF NOT EXISTS idx_workflow_quotes_saved_at
  ON workflow_quotes ((data->>'savedAt') DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_quotes_kind
  ON workflow_quotes ((data->>'kind'));

COMMENT ON TABLE workflow_quotes IS
  'Quotes, drafts, OVF, PO, and GRN workflow records (full SavedQuoteRecord JSON).';
