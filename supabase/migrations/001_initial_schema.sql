-- ============================================================================
-- StudyAI Phase 2: Initial PostgreSQL + pgvector + Supabase Auth + Storage Schema
-- Run this script in your Supabase Project -> SQL Editor
-- ============================================================================

-- 1. Required Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Users Profile Table (Synced 1:1 with Supabase Auth auth.users)
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar TEXT,
  degree TEXT NOT NULL DEFAULT 'Master of Computer Applications (MCA)',
  semester TEXT NOT NULL DEFAULT 'Semester II',
  university TEXT NOT NULL DEFAULT 'Department of Computer Science',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Automatically create/sync public.users profile when a user registers via Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT;
  v_avatar TEXT;
BEGIN
  v_name := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'name'), ''),
    SPLIT_PART(COALESCE(NEW.email, 'Student'), '@', 1)
  );
  v_avatar := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'avatar'), ''),
    UPPER(LEFT(v_name, 2))
  );

  INSERT INTO public.users (id, email, name, avatar, degree, semester, university)
  VALUES (
    NEW.id,
    LOWER(COALESCE(NEW.email, '')),
    v_name,
    v_avatar,
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'degree'), ''), 'Master of Computer Applications (MCA)'),
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'semester'), ''), 'Semester II'),
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'university'), ''), 'Department of Computer Science')
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    name = COALESCE(NULLIF(EXCLUDED.name, ''), public.users.name),
    updated_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. Notebooks Table
CREATE TABLE IF NOT EXISTS public.notebooks (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  icon_name TEXT NOT NULL DEFAULT 'BookOpen',
  accent_color TEXT NOT NULL DEFAULT '#2563EB',
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  last_studied TEXT NOT NULL DEFAULT 'Just now',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notebooks_user_id ON public.notebooks(user_id, created_at DESC);

-- 4. Documents Table
CREATE TABLE IF NOT EXISTS public.documents (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES public.notebooks(id) ON DELETE CASCADE,
  original_file_name TEXT NOT NULL,
  storage_file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL DEFAULT 0 CHECK (file_size >= 0),
  file_hash TEXT,
  upload_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'UPLOADED' CHECK (
    status IN (
      'UPLOADING', 'UPLOADED', 'PROCESSING', 'EXTRACTING',
      'OCR', 'CLEANING', 'CHUNKING', 'EMBEDDING',
      'INDEXING', 'COMPLETED', 'FAILED'
    )
  ),
  current_stage TEXT NOT NULL DEFAULT 'Uploaded',
  progress INTEGER NOT NULL DEFAULT 20 CHECK (progress >= 0 AND progress <= 100),
  message TEXT NOT NULL DEFAULT '',
  processed_pages INTEGER NOT NULL DEFAULT 0,
  total_pages INTEGER NOT NULL DEFAULT 1,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  metrics JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_user_notebook ON public.documents(user_id, notebook_id, upload_date DESC);

-- Prevent duplicate uploads of the exact same file content in the same notebook
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_unique_file_hash
  ON public.documents(user_id, notebook_id, file_hash)
  WHERE file_hash IS NOT NULL;

-- 5. Document Chunks Table
CREATE TABLE IF NOT EXISTS public.document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES public.notebooks(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  page_start INTEGER NOT NULL DEFAULT 1,
  page_end INTEGER NOT NULL DEFAULT 1,
  section TEXT NOT NULL DEFAULT '',
  heading TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  extraction_method TEXT NOT NULL DEFAULT 'text' CHECK (extraction_method IN ('text', 'ocr')),
  source_doc_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON public.document_chunks(document_id, chunk_index ASC);
CREATE INDEX IF NOT EXISTS idx_document_chunks_user_nb ON public.document_chunks(user_id, notebook_id);

-- 6. Vector Embeddings Table (pgvector 128-dim unit vectors)
CREATE TABLE IF NOT EXISTS public.vector_embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES public.document_chunks(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES public.notebooks(id) ON DELETE CASCADE,
  embedding VECTOR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vector_embeddings_user_nb ON public.vector_embeddings(user_id, notebook_id);
CREATE INDEX IF NOT EXISTS idx_vector_embeddings_doc ON public.vector_embeddings(document_id);
CREATE INDEX IF NOT EXISTS idx_vector_embeddings_cosine_hnsw
  ON public.vector_embeddings USING hnsw (embedding vector_cosine_ops);

-- 7. Chat Messages Table
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES public.notebooks(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'ai')),
  text TEXT NOT NULL,
  timestamp_label TEXT NOT NULL,
  source_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_grounded BOOLEAN NOT NULL DEFAULT FALSE,
  retrieval_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  insufficient_info BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_nb ON public.chat_messages(user_id, notebook_id, created_at ASC);

-- 8. Document Summaries Table (Section B)
CREATE TABLE IF NOT EXISTS public.document_summaries (
  document_id TEXT PRIMARY KEY REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES public.notebooks(id) ON DELETE CASCADE,
  original_file_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 1,
  file_size TEXT,
  source_chunk_count INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_summaries_user_nb ON public.document_summaries(user_id, notebook_id);

-- 9. Notebook Chat Summaries Table (Section A)
CREATE TABLE IF NOT EXISTS public.chat_summaries (
  notebook_id TEXT PRIMARY KEY REFERENCES public.notebooks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_summaries_user ON public.chat_summaries(user_id, notebook_id);

-- 10. Background Processing Jobs Table (Replaces unreliable setImmediate)
CREATE TABLE IF NOT EXISTS public.processing_jobs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES public.notebooks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  provider TEXT NOT NULL DEFAULT 'qstash' CHECK (provider IN ('qstash', 'inline', 'local')),
  qstash_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  locked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processing_jobs_doc ON public.processing_jobs(document_id, created_at DESC);
-- Guarantee only one active (QUEUED or RUNNING) job per document
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_single_active
  ON public.processing_jobs(document_id)
  WHERE status IN ('QUEUED', 'RUNNING');

-- 11. Exam Results Table
CREATE TABLE IF NOT EXISTS public.exam_results (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES public.notebooks(id) ON DELETE CASCADE,
  notebook_title TEXT NOT NULL,
  total_questions INTEGER NOT NULL,
  correct_count INTEGER NOT NULL,
  incorrect_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  percentage INTEGER NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  time_taken_seconds INTEGER NOT NULL,
  topic_performance JSONB NOT NULL DEFAULT '[]'::jsonb,
  strong_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  weak_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation TEXT NOT NULL DEFAULT '',
  review_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exam_results_user ON public.exam_results(user_id, created_at DESC);

-- 12. Recent Activity Timeline Table
CREATE TABLE IF NOT EXISTS public.recent_activity (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('exam', 'note', 'document', 'chat')),
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL,
  timestamp_label TEXT NOT NULL DEFAULT 'Just now',
  score TEXT,
  notebook_title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recent_activity_user ON public.recent_activity(user_id, created_at DESC);

-- 13. Strict pgvector Cosine Similarity Search RPC (User + Notebook Isolated)
CREATE OR REPLACE FUNCTION public.match_document_embeddings(
  p_user_id UUID,
  p_notebook_id TEXT,
  p_document_id TEXT DEFAULT NULL,
  p_query_embedding VECTOR(128) DEFAULT NULL,
  p_match_count INTEGER DEFAULT 25
)
RETURNS TABLE (
  chunk_id TEXT,
  document_id TEXT,
  user_id UUID,
  notebook_id TEXT,
  chunk_index INTEGER,
  page_start INTEGER,
  page_end INTEGER,
  section TEXT,
  heading TEXT,
  text TEXT,
  token_estimate INTEGER,
  extraction_method TEXT,
  source_doc_name TEXT,
  cosine_similarity DOUBLE PRECISION
)
LANGUAGE SQL
STABLE
AS $$
  SELECT
    dc.id AS chunk_id,
    dc.document_id,
    dc.user_id,
    dc.notebook_id,
    dc.chunk_index,
    dc.page_start,
    dc.page_end,
    dc.section,
    dc.heading,
    dc.text,
    dc.token_estimate,
    dc.extraction_method,
    dc.source_doc_name,
    1 - (ve.embedding <=> p_query_embedding) AS cosine_similarity
  FROM public.vector_embeddings ve
  INNER JOIN public.document_chunks dc ON dc.id = ve.chunk_id
  INNER JOIN public.documents d ON d.id = dc.document_id
  WHERE ve.user_id = p_user_id
    AND ve.notebook_id = p_notebook_id
    AND d.status = 'COMPLETED'
    AND (p_document_id IS NULL OR ve.document_id = p_document_id)
  ORDER BY ve.embedding <=> p_query_embedding ASC
  LIMIT GREATEST(1, LEAST(p_match_count, 100));
$$;

-- 14. Row Level Security (RLS) Policies for Full User Isolation
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notebooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vector_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recent_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_own_profile ON public.users;
CREATE POLICY users_own_profile ON public.users
  FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS notebooks_owner_isolation ON public.notebooks;
CREATE POLICY notebooks_owner_isolation ON public.notebooks
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS documents_owner_isolation ON public.documents;
CREATE POLICY documents_owner_isolation ON public.documents
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS chunks_owner_isolation ON public.document_chunks;
CREATE POLICY chunks_owner_isolation ON public.document_chunks
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS vectors_owner_isolation ON public.vector_embeddings;
CREATE POLICY vectors_owner_isolation ON public.vector_embeddings
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS chat_messages_owner_isolation ON public.chat_messages;
CREATE POLICY chat_messages_owner_isolation ON public.chat_messages
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS doc_summaries_owner_isolation ON public.document_summaries;
CREATE POLICY doc_summaries_owner_isolation ON public.document_summaries
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS chat_summaries_owner_isolation ON public.chat_summaries;
CREATE POLICY chat_summaries_owner_isolation ON public.chat_summaries
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS jobs_owner_isolation ON public.processing_jobs;
CREATE POLICY jobs_owner_isolation ON public.processing_jobs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS exam_results_owner_isolation ON public.exam_results;
CREATE POLICY exam_results_owner_isolation ON public.exam_results
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS activity_owner_isolation ON public.recent_activity;
CREATE POLICY activity_owner_isolation ON public.recent_activity
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 15. Private Storage Bucket & Storage RLS Policies
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'studyai-documents',
  'studyai-documents',
  FALSE,
  26214400, -- 25 MB
  ARRAY[
    'application/pdf',
    'text/plain',
    'text/markdown',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = FALSE,
  file_size_limit = 26214400;

DROP POLICY IF EXISTS "Users can upload own study documents" ON storage.objects;
CREATE POLICY "Users can upload own study documents"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'studyai-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can read own study documents" ON storage.objects;
CREATE POLICY "Users can read own study documents"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'studyai-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can delete own study documents" ON storage.objects;
CREATE POLICY "Users can delete own study documents"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'studyai-documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
