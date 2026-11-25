import { GoogleGenAI } from '@google/genai';

export type AIErrorCode =
  | 'GEMINI_API_KEY_MISSING'
  | 'GEMINI_API_KEY_INVALID'
  | 'GEMINI_RATE_LIMIT'
  | 'GEMINI_TIMEOUT'
  | 'GEMINI_UNAVAILABLE';

export class AIServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: AIErrorCode;
  public readonly retryable: boolean;

  constructor(message: string, statusCode: number, code: AIErrorCode, retryable: boolean) {
    super(message);
    this.name = 'AIServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
  }
}

export const GEMINI_TEXT_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
] as const;

let cachedClient: GoogleGenAI | null = null;
let cachedApiKey: string | null = null;

export function getGeminiClientOrThrow(): GoogleGenAI {
  const rawKey = process.env.GEMINI_API_KEY;
  const trimmedKey = rawKey ? rawKey.trim() : '';

  if (!trimmedKey || trimmedKey === 'MY_GEMINI_API_KEY') {
    throw new AIServiceError(
      'Gemini API key is missing or not configured on the server. Please configure GEMINI_API_KEY in server secrets and try again.',
      503,
      'GEMINI_API_KEY_MISSING',
      false
    );
  }

  if (!cachedClient || cachedApiKey !== trimmedKey) {
    try {
      cachedClient = new GoogleGenAI({
        apiKey: trimmedKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
      cachedApiKey = trimmedKey;
    } catch (err: any) {
      throw new AIServiceError(
        `Failed to initialize Gemini AI client: ${err?.message || 'Configuration error'}`,
        503,
        'GEMINI_API_KEY_INVALID',
        false
      );
    }
  }

  return cachedClient;
}

export function getGeminiClientOptional(): GoogleGenAI | null {
  try {
    return getGeminiClientOrThrow();
  } catch {
    return null;
  }
}

export function classifyGeminiError(err: any): AIServiceError {
  if (err instanceof AIServiceError) {
    return err;
  }

  const msg = String(err?.message || err || '');
  const lower = msg.toLowerCase();

  if (
    err?.name === 'AbortError' ||
    err?.name === 'TimeoutError' ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted')
  ) {
    return new AIServiceError(
      'Gemini AI request timed out. Please retry your request.',
      504,
      'GEMINI_TIMEOUT',
      true
    );
  }

  if (
    msg.includes('API_KEY_INVALID') ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('403') ||
    lower.includes('api key not valid')
  ) {
    return new AIServiceError(
      'Gemini API authentication failed. Please check the server GEMINI_API_KEY configuration.',
      503,
      'GEMINI_API_KEY_INVALID',
      false
    );
  }

  if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || lower.includes('quota')) {
    return new AIServiceError(
      'Gemini AI rate limit reached. Please wait a few seconds and retry.',
      429,
      'GEMINI_RATE_LIMIT',
      true
    );
  }

  return new AIServiceError(
    `Gemini AI service is currently unavailable (${msg || 'upstream error'}). Please retry in a moment.`,
    502,
    'GEMINI_UNAVAILABLE',
    true
  );
}
