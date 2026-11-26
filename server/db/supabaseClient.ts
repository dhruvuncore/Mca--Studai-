import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';

export class ServiceConfigError extends Error {
  public readonly statusCode: number = 503;
  public readonly code: string;

  constructor(message: string, code: string = 'SUPABASE_NOT_CONFIGURED') {
    super(message);
    this.name = 'ServiceConfigError';
    this.code = code;
  }
}

let cachedSupabaseAdmin: SupabaseClient | null = null;
let cachedPool: Pool | null = null;

export function getMissingServerEnvVars(): string[] {
  const missing: string[] = [];
  if (
    !config.SUPABASE_URL ||
    !/^https?:\/\//i.test(config.SUPABASE_URL) ||
    config.SUPABASE_URL.includes('YOUR_PROJECT_REF')
  ) {
    missing.push('SUPABASE_URL');
  }
  if (
    !config.SUPABASE_SERVICE_ROLE_KEY ||
    config.SUPABASE_SERVICE_ROLE_KEY.includes('YOUR_SUPABASE_SERVICE_ROLE_KEY') ||
    config.SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_publishable_')
  ) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }
  if (
    !config.DATABASE_URL ||
    config.DATABASE_URL.includes('YOUR_PROJECT_REF') ||
    config.DATABASE_URL.includes('YOUR_DB_PASSWORD')
  ) {
    missing.push('DATABASE_URL');
  }
  return missing;
}

export function isSupabaseBackendConfigured(): boolean {
  return getMissingServerEnvVars().length === 0;
}

export function getSupabaseAdmin(): SupabaseClient {
  if (config.SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_publishable_')) {
    throw new ServiceConfigError(
      'SUPABASE_SERVICE_ROLE_KEY cannot be a publishable key (sb_publishable_...). Provide your Supabase Secret key (sb_secret_...) or legacy service_role key.',
      'SUPABASE_INVALID_SERVER_KEY'
    );
  }

  if (
    !config.SUPABASE_URL ||
    !/^https?:\/\//i.test(config.SUPABASE_URL) ||
    !config.SUPABASE_SERVICE_ROLE_KEY ||
    config.SUPABASE_URL.includes('YOUR_PROJECT_REF') ||
    config.SUPABASE_SERVICE_ROLE_KEY.includes('YOUR_SUPABASE_SERVICE_ROLE_KEY')
  ) {
    throw new ServiceConfigError(
      'Supabase server credentials (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY) are not configured. Complete Supabase setup and add them to your server environment variables.',
      'SUPABASE_NOT_CONFIGURED'
    );
  }

  if (!cachedSupabaseAdmin) {
    cachedSupabaseAdmin = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }

  return cachedSupabaseAdmin;
}

export function getPgPool(): Pool {
  if (
    !config.DATABASE_URL ||
    config.DATABASE_URL.includes('YOUR_PROJECT_REF') ||
    config.DATABASE_URL.includes('YOUR_DB_PASSWORD')
  ) {
    throw new ServiceConfigError(
      'DATABASE_URL is not configured. Add your Supabase PostgreSQL connection string to server environment variables.',
      'DATABASE_NOT_CONFIGURED'
    );
  }

  if (!cachedPool) {
    const isLocal =
      config.DATABASE_URL.includes('localhost') ||
      config.DATABASE_URL.includes('127.0.0.1');

    cachedPool = new Pool({
      connectionString: config.DATABASE_URL,
      max: process.env.VERCEL ? 5 : 10,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 10000,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
    });

    cachedPool.on('error', (err) => {
      console.error('[PostgreSQL Pool Error]', err);
    });
  }

  return cachedPool;
}

export async function pgQuery<T extends QueryResultRow = any>(
  text: string,
  params: any[] = []
): Promise<QueryResult<T>> {
  const pool = getPgPool();
  return pool.query<T>(text, params);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[PostgreSQL Rollback Error]', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

export function formatVectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || vector.length !== config.DEFAULT_EMBEDDING_DIM) {
    throw new Error(
      `Expected ${config.DEFAULT_EMBEDDING_DIM}-dimensional vector, got length ${vector?.length ?? 0}.`
    );
  }
  const sanitized = vector.map((n) => (Number.isFinite(n) ? Number(n.toFixed(8)) : 0));
  return `[${sanitized.join(',')}]`;
}

export async function testDatabaseConnection(): Promise<{ ok: boolean; pgvectorEnabled: boolean; error?: string }> {
  try {
    const res = await pgQuery<{ ok: number; has_vector: boolean }>(
      `SELECT 1 AS ok, EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector`
    );
    return {
      ok: res.rows[0]?.ok === 1,
      pgvectorEnabled: Boolean(res.rows[0]?.has_vector),
    };
  } catch (err: any) {
    return {
      ok: false,
      pgvectorEnabled: false,
      error: err?.message || 'Database connection failed',
    };
  }
}
