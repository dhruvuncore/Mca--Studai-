import 'dotenv/config';
import path from 'path';

function normalizeSupabaseOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return '';
  }
}

export const config = {
  // Port & Host
  PORT: 3000,
  HOST: '0.0.0.0',

  // Upload limits
  MAX_FILE_SIZE_BYTES: 25 * 1024 * 1024, // 25 MB
  ALLOWED_EXTENSIONS: ['.pdf', '.txt', '.md', '.png', '.jpg', '.jpeg', '.webp', '.doc', '.docx'],
  ALLOWED_MIME_TYPES: [
    'application/pdf',
    'text/plain',
    'text/markdown',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],

  // Temporary local scratch directories (used only for transient temp files if needed)
  DATA_DIR: process.env.VERCEL ? '/tmp/data' : path.resolve(process.cwd(), 'data'),
  STORAGE_DIR: process.env.VERCEL ? '/tmp/data/storage' : path.resolve(process.cwd(), 'data', 'storage'),
  VECTOR_DB_DIR: process.env.VERCEL ? '/tmp/data/vectordb' : path.resolve(process.cwd(), 'data', 'vectordb'),
  DB_DIR: process.env.VERCEL ? '/tmp/data/db' : path.resolve(process.cwd(), 'data', 'db'),

  // Supabase Persistence & Storage (supports both new sb_publishable_/sb_secret_ keys and legacy JWT keys)
  SUPABASE_URL:
    normalizeSupabaseOrigin(process.env.SUPABASE_URL || '') ||
    normalizeSupabaseOrigin(process.env.VITE_SUPABASE_URL || ''),
  SUPABASE_ANON_KEY: (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim(),
  SUPABASE_SERVICE_ROLE_KEY: (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    ''
  ).trim(),
  SUPABASE_STORAGE_BUCKET: (process.env.SUPABASE_STORAGE_BUCKET || 'studyai-documents').trim(),
  DATABASE_URL: (process.env.DATABASE_URL || '').trim(),

  // QStash Queue (Free-tier compatible background job queue for Vercel)
  QSTASH_TOKEN: (process.env.QSTASH_TOKEN || '').trim(),
  QSTASH_CURRENT_SIGNING_KEY: (process.env.QSTASH_CURRENT_SIGNING_KEY || '').trim(),
  QSTASH_NEXT_SIGNING_KEY: (process.env.QSTASH_NEXT_SIGNING_KEY || '').trim(),
  APP_URL: (
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
  ).trim(),

  // RAG Chunking configuration
  CHUNK_SIZE_TOKENS: 650,
  CHUNK_OVERLAP_TOKENS: 120,
  MIN_CHUNK_CHAR_LENGTH: 30,

  // Retrieval configuration
  TOP_K: 5,
  SIMILARITY_THRESHOLD: 0.30,
  MAX_CONTEXT_TOKENS: 3500,

  // Embedding & LLM
  DEFAULT_EMBEDDING_DIM: 128,
  LLM_MODEL: 'gemini-4-hydrogen',
};
