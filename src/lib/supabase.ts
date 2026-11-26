import { createClient, SupabaseClient } from '@supabase/supabase-js';

const rawSupabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseConfigError';
  }
}

function isPlaceholder(val: string, markers: string[]): boolean {
  if (!val) return true;
  return markers.some((m) => val.includes(m));
}

function normalizeSupabaseProjectUrl(raw: string): string {
  if (!raw || !/^https?:\/\//i.test(raw)) return '';
  if (isPlaceholder(raw, ['YOUR_PROJECT_REF'])) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

const supabaseUrl = normalizeSupabaseProjectUrl(rawSupabaseUrl);

export function getMissingClientEnvVars(): string[] {
  const missing: string[] = [];
  if (!supabaseUrl) {
    missing.push('VITE_SUPABASE_URL');
  }
  if (
    !supabaseAnonKey ||
    isPlaceholder(supabaseAnonKey, ['YOUR_SUPABASE_ANON_KEY']) ||
    supabaseAnonKey.startsWith('sb_secret_')
  ) {
    missing.push('VITE_SUPABASE_ANON_KEY');
  }
  return missing;
}

export function isSupabaseClientConfigured(): boolean {
  return getMissingClientEnvVars().length === 0;
}

let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (supabaseAnonKey.startsWith('sb_secret_')) {
    throw new SupabaseConfigError(
      'Security error: Do not use a Supabase Secret key (sb_secret_...) in VITE_SUPABASE_ANON_KEY. Use your Publishable key (sb_publishable_...) or legacy anon key instead.'
    );
  }

  if (rawSupabaseUrl && !/^https?:\/\//i.test(rawSupabaseUrl)) {
    throw new SupabaseConfigError(
      'Invalid VITE_SUPABASE_URL: Expected your Supabase Project HTTPS URL (https://<project-ref>.supabase.co), not a PostgreSQL connection string.'
    );
  }

  if (!isSupabaseClientConfigured()) {
    throw new SupabaseConfigError(
      'Supabase client authentication is not configured yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (sb_publishable_... or anon key) in your environment variables.'
    );
  }

  if (!cachedClient) {
    cachedClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'studyai_supabase_auth',
      },
    });
  }

  return cachedClient;
}
