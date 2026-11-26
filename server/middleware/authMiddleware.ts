import { Request, Response, NextFunction } from 'express';
import { getSupabaseAdmin, pgQuery, ServiceConfigError } from '../db/supabaseClient';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  degree: string;
  semester: string;
  university: string;
  avatar: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export function extractBearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null;
  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
  const token = trimmed.slice(7).trim();
  if (!token || token === 'null' || token === 'undefined') return null;
  return token;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({
        error: 'Authentication required. Please sign in to your StudyAI account.',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const supabaseAdmin = getSupabaseAdmin();
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      res.status(401).json({
        error: 'Your session is invalid or has expired. Please sign in again.',
        code: 'INVALID_SESSION',
      });
      return;
    }

    const supaUser = data.user;
    const email = (supaUser.email || '').toLowerCase();
    const meta = (supaUser.user_metadata || {}) as Record<string, any>;
    const defaultName = email ? email.split('@')[0] : 'Student';
    const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : defaultName;
    const avatar =
      typeof meta.avatar === 'string' && meta.avatar.trim()
        ? meta.avatar.trim().slice(0, 2).toUpperCase()
        : name
            .split(' ')
            .filter(Boolean)
            .map((p) => p[0])
            .join('')
            .slice(0, 2)
            .toUpperCase() || 'ST';

    const degree =
      typeof meta.degree === 'string' && meta.degree.trim()
        ? meta.degree.trim()
        : 'Master of Computer Applications (MCA)';
    const semester =
      typeof meta.semester === 'string' && meta.semester.trim()
        ? meta.semester.trim()
        : 'Semester II';
    const university =
      typeof meta.university === 'string' && meta.university.trim()
        ? meta.university.trim()
        : 'Department of Computer Science';

    // Ensure profile row exists in public.users for FK integrity
    const profileRes = await pgQuery<{
      id: string;
      email: string;
      name: string;
      avatar: string;
      degree: string;
      semester: string;
      university: string;
    }>(
      `INSERT INTO public.users (id, email, name, avatar, degree, semester, university)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         email = COALESCE(NULLIF(EXCLUDED.email, ''), public.users.email)
       RETURNING id, email, name, avatar, degree, semester, university`,
      [supaUser.id, email, name, avatar, degree, semester, university]
    );

    const row = profileRes.rows[0];
    req.user = {
      id: row.id,
      email: row.email,
      name: row.name,
      avatar: row.avatar || avatar,
      degree: row.degree,
      semester: row.semester,
      university: row.university,
    };

    next();
  } catch (err: any) {
    if (err instanceof ServiceConfigError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    console.error('[AuthMiddleware] Verification error:', err);
    res.status(500).json({ error: 'Failed to verify authentication session.' });
  }
}
