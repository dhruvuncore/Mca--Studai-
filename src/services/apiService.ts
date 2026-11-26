import {
  Notebook,
  DocumentItem,
  ChatMessage,
  NotebookChatSummary,
  DocumentSummary,
  PracticeQuestion,
  ExamResult,
  AnalyticsData,
  RecentActivityItem,
  StudentProfile,
  SourceReference,
} from '../types';
import { sampleQuestions } from '../mockData';
import { getMissingClientEnvVars, getSupabaseClient, isSupabaseClientConfigured } from '../lib/supabase';

export class ApiError extends Error {
  code?: string;
  retryable: boolean;
  statusCode?: number;

  constructor(message: string, code?: string, retryable: boolean = false, statusCode?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

const STORAGE_KEYS = {
  REMEMBER_EMAIL: 'studyai_remembered_email',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateLabel(raw?: string): string {
  if (!raw) return 'Just now';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function mapServerDocumentToItem(raw: any): DocumentItem {
  if (!raw) {
    return {
      id: '',
      notebookId: '',
      name: 'Document',
      size: '0 KB',
      pages: 1,
      uploadDate: 'Just now',
      status: 'UPLOADED',
      extractedChunksCount: 0,
    };
  }

  const sizeLabel =
    typeof raw.size === 'string'
      ? raw.size
      : formatBytes(Number(raw.fileSize || raw.file_size || 0));

  const pages = Number(raw.pages || raw.totalPages || raw.total_pages || 1);
  const chunkCount = Number(
    raw.extractedChunksCount ?? raw.chunkCount ?? raw.chunk_count ?? 0
  );

  return {
    id: raw.id,
    notebookId: raw.notebookId || raw.notebook_id || '',
    name: raw.name || raw.originalFileName || raw.original_file_name || 'Document',
    size: sizeLabel,
    pages,
    uploadDate: formatDateLabel(raw.uploadDate || raw.upload_date),
    status: raw.status || 'UPLOADED',
    extractedChunksCount: chunkCount,
    currentStage: raw.currentStage || raw.current_stage,
    progress: typeof raw.progress === 'number' ? raw.progress : undefined,
    message: raw.message,
    error: raw.error ?? null,
    metrics: raw.metrics,
    previewSnippet:
      raw.previewSnippet ||
      (raw.status === 'COMPLETED'
        ? `Indexed ${chunkCount} vector chunks across ${pages} pages in PostgreSQL + pgvector.`
        : raw.message || 'Document stored securely in private Supabase Storage.'),
  };
}

function mapServerNotebook(raw: any): Notebook {
  const docs = Array.isArray(raw.documents) ? raw.documents.map(mapServerDocumentToItem) : [];
  return {
    id: raw.id,
    title: raw.title || 'Untitled Notebook',
    code: raw.code || '',
    description: raw.description || '',
    iconName: raw.iconName || raw.icon_name || 'BookOpen',
    accentColor: raw.accentColor || raw.accent_color || '#2563EB',
    documentsCount: typeof raw.documentsCount === 'number' ? raw.documentsCount : docs.length,
    progress: Number(raw.progress || 0),
    lastStudied: raw.lastStudied || raw.last_studied || 'Just now',
    documents: docs,
  };
}

class ApiService {
  private accessToken: string | null = null;
  private profile: StudentProfile | null = null;
  private notebooks: Notebook[] = [];
  private chatsByNotebook: Record<string, ChatMessage[]> = {};
  private chatSummaries: Record<string, NotebookChatSummary> = {};
  private docSummaries: Record<string, DocumentSummary> = {};
  private examResults: ExamResult[] = [];
  private recentActivity: RecentActivityItem[] = [];

  constructor() {
    this.scrubLegacyLocalAuthAndData();
  }

  private scrubLegacyLocalAuthAndData(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (
          k &&
          k !== 'study_ai_theme' &&
          k !== STORAGE_KEYS.REMEMBER_EMAIL &&
          k !== 'studyai_supabase_auth' &&
          (k.startsWith('studyai_') || k.startsWith('study_ai_'))
        ) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {
      // Ignore storage access errors
    }
  }

  private clearInMemoryCaches(): void {
    this.accessToken = null;
    this.profile = null;
    this.notebooks = [];
    this.chatsByNotebook = {};
    this.chatSummaries = {};
    this.docSummaries = {};
    this.examResults = [];
    this.recentActivity = [];
  }

  private async getValidAccessToken(): Promise<string> {
    if (!isSupabaseClientConfigured()) {
      throw new ApiError(
        'Supabase authentication is not configured. Please add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
        'AUTH_NOT_CONFIGURED',
        false,
        503
      );
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
      this.accessToken = null;
      throw new ApiError('Your session has expired. Please sign in again.', 'AUTH_REQUIRED', false, 401);
    }

    this.accessToken = data.session.access_token;
    return this.accessToken;
  }

  async authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const token = await this.getValidAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);

    let res = await fetch(input, { ...init, headers });

    // If token expired just before request, try one Supabase session refresh
    if (res.status === 401 && isSupabaseClientConfigured()) {
      const supabase = getSupabaseClient();
      const { data: refreshed } = await supabase.auth.refreshSession();
      if (refreshed.session?.access_token) {
        this.accessToken = refreshed.session.access_token;
        headers.set('Authorization', `Bearer ${this.accessToken}`);
        res = await fetch(input, { ...init, headers });
      }
    }

    return res;
  }

  private async parseErrorResponse(res: Response, defaultMessage: string): Promise<ApiError> {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const errJson = await res.json();
        const message = errJson?.error || errJson?.message || defaultMessage;
        const code = typeof errJson?.code === 'string' ? errJson.code : undefined;
        const retryable =
          typeof errJson?.retryable === 'boolean'
            ? errJson.retryable
            : res.status >= 500 || res.status === 408 || res.status === 429;
        return new ApiError(message, code, retryable, res.status);
      } catch {
        // fall through
      }
    }
    return new ApiError(
      `${defaultMessage} (HTTP ${res.status})`,
      'HTTP_ERROR',
      res.status >= 500 || res.status === 408 || res.status === 429,
      res.status
    );
  }

  // ============================================================
  // AUTHENTICATION & SESSION HYDRATION (SUPABASE AUTH)
  // ============================================================

  isAuthenticated(): boolean {
    return Boolean(this.accessToken && this.profile);
  }

  getActiveUserId(): string {
    return this.profile?.id || '';
  }

  requireActiveUserId(): string {
    const uid = this.profile?.id?.trim();
    if (!uid) {
      throw new ApiError('Please sign in to your StudyAI account to continue.', 'AUTH_REQUIRED', false, 401);
    }
    return uid;
  }

  getProfile(): StudentProfile | null {
    return this.profile;
  }

  async getConfigurationStatus(): Promise<{
    clientConfigured: boolean;
    serverConfigured: boolean;
    missingClientVars: string[];
    missingServerVars: string[];
    databaseConnected: boolean;
  }> {
    const missingClientVars = getMissingClientEnvVars();
    const clientConfigured = missingClientVars.length === 0;

    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        const missingServerVars = Array.isArray(data.missingServerConfig)
          ? (data.missingServerConfig as string[])
          : [];
        return {
          clientConfigured,
          serverConfigured: Boolean(data.supabaseConfigured),
          missingClientVars,
          missingServerVars,
          databaseConnected: Boolean(data.databaseConnected),
        };
      }
    } catch {
      // Backend health endpoint unreachable; fall back to client configuration check
    }

    return {
      clientConfigured,
      serverConfigured: false,
      missingClientVars,
      missingServerVars: [],
      databaseConnected: false,
    };
  }

  async initializeSession(): Promise<StudentProfile | null> {
    if (!isSupabaseClientConfigured()) {
      this.clearInMemoryCaches();
      return null;
    }

    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        this.clearInMemoryCaches();
        return null;
      }

      this.accessToken = data.session.access_token;
      await this.bootstrapUserData();
      return this.profile;
    } catch (err) {
      console.warn('Session restoration notice:', err);
      this.clearInMemoryCaches();
      return null;
    }
  }

  subscribeToAuthChanges(onChange: (profile: StudentProfile | null) => void): () => void {
    if (!isSupabaseClientConfigured()) {
      return () => {};
    }

    const supabase = getSupabaseClient();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT' || !session?.access_token) {
        this.clearInMemoryCaches();
        onChange(null);
        return;
      }

      this.accessToken = session.access_token;
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') {
        try {
          await this.bootstrapUserData();
          onChange(this.profile);
        } catch (err) {
          console.warn('Auth state sync error:', err);
        }
      }
    });

    return () => subscription.unsubscribe();
  }

  async bootstrapUserData(): Promise<void> {
    const [meRes, nbRes, examsRes, actRes] = await Promise.all([
      this.authFetch('/api/auth/me'),
      this.authFetch('/api/notebooks'),
      this.authFetch('/api/exams'),
      this.authFetch('/api/activity'),
    ]);

    if (!meRes.ok) {
      throw await this.parseErrorResponse(meRes, 'Failed to load authenticated student profile.');
    }

    const meData = await meRes.json();
    this.profile = meData.profile;

    if (nbRes.ok) {
      const nbData = await nbRes.json();
      this.notebooks = Array.isArray(nbData.notebooks)
        ? nbData.notebooks.map(mapServerNotebook)
        : [];
    }

    if (examsRes.ok) {
      const examData = await examsRes.json();
      this.examResults = Array.isArray(examData.exams) ? examData.exams : [];
    }

    if (actRes.ok) {
      const actData = await actRes.json();
      this.recentActivity = Array.isArray(actData.activity) ? actData.activity : [];
    }
  }

  async authenticateUser(
    emailInput: string,
    passwordInput: string
  ): Promise<{ success: boolean; error?: string; profile?: StudentProfile }> {
    const email = (emailInput || '').trim().toLowerCase();
    const password = passwordInput || '';

    if (!email) return { success: false, error: 'Email address is required.' };
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { success: false, error: 'Please enter a valid email address (e.g., student@university.edu).' };
    }
    if (!password) return { success: false, error: 'Password is required.' };

    if (!isSupabaseClientConfigured()) {
      return {
        success: false,
        error: 'Supabase authentication is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
      };
    }

    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) {
        return {
          success: false,
          error: error.message || 'Invalid login credentials.',
        };
      }

      if (!data.session?.access_token) {
        return {
          success: false,
          error: 'Please confirm your email address before signing in.',
        };
      }

      this.accessToken = data.session.access_token;
      await this.bootstrapUserData();

      if (!this.profile) {
        return { success: false, error: 'Unable to load student profile after sign-in.' };
      }

      return { success: true, profile: this.profile };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'Unable to reach authentication service.',
      };
    }
  }

  async registerUser(data: {
    name: string;
    email: string;
    password: string;
    degree?: string;
    semester?: string;
    university?: string;
  }): Promise<{
    success: boolean;
    error?: string;
    profile?: StudentProfile;
    needsEmailVerification?: boolean;
    message?: string;
  }> {
    const name = (data.name || '').trim();
    const email = (data.email || '').trim().toLowerCase();
    const password = data.password || '';

    if (!name || name.length < 2) {
      return { success: false, error: 'Full name must be at least 2 characters.' };
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return { success: false, error: 'Please enter a valid email address format.' };
    }
    if (!password || password.length < 6) {
      return { success: false, error: 'Password must be at least 6 characters long.' };
    }

    if (!isSupabaseClientConfigured()) {
      return {
        success: false,
        error: 'Supabase authentication is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
      };
    }

    const initials =
      name
        .split(' ')
        .filter(Boolean)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase() || 'ST';

    try {
      const supabase = getSupabaseClient();
      const { data: authData, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            name,
            avatar: initials,
            degree: data.degree || 'Master of Computer Applications (MCA)',
            semester: data.semester || 'Semester II',
            university: data.university || 'Department of Computer Science',
          },
        },
      });

      if (error) {
        return { success: false, error: error.message || 'Registration failed.' };
      }

      if (!authData.session?.access_token) {
        return {
          success: true,
          needsEmailVerification: true,
          message: `Account created for ${email}. Please check your inbox and click the confirmation link to activate your account, then sign in.`,
        };
      }

      this.accessToken = authData.session.access_token;
      await this.bootstrapUserData();

      return {
        success: true,
        profile: this.profile || undefined,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'Unable to register student account.',
      };
    }
  }

  async requestPasswordReset(emailInput: string): Promise<{ success: boolean; error?: string }> {
    const email = (emailInput || '').trim().toLowerCase();
    if (!email) {
      return { success: false, error: 'Please enter your student email address.' };
    }
    if (!isSupabaseClientConfigured()) {
      return { success: false, error: 'Supabase authentication is not configured.' };
    }

    try {
      const supabase = getSupabaseClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      });
      if (error) {
        return { success: false, error: error.message };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to send password reset email.' };
    }
  }

  getRememberedEmail(): string {
    try {
      return localStorage.getItem(STORAGE_KEYS.REMEMBER_EMAIL) || '';
    } catch {
      return '';
    }
  }

  setRememberedEmail(email: string, remember: boolean): void {
    try {
      if (remember && email.trim()) {
        localStorage.setItem(STORAGE_KEYS.REMEMBER_EMAIL, email.trim());
      } else {
        localStorage.removeItem(STORAGE_KEYS.REMEMBER_EMAIL);
      }
    } catch {
      // ignore
    }
  }

  async logout(): Promise<void> {
    this.clearInMemoryCaches();
    if (isSupabaseClientConfigured()) {
      try {
        const supabase = getSupabaseClient();
        await supabase.auth.signOut();
      } catch (err) {
        console.warn('Sign out warning:', err);
      }
    }
  }

  async updateProfile(profileUpdates: Partial<StudentProfile>): Promise<StudentProfile> {
    const res = await this.authFetch('/api/auth/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: profileUpdates.name,
        degree: profileUpdates.degree,
        semester: profileUpdates.semester,
        university: profileUpdates.university,
        avatar: profileUpdates.avatar,
      }),
    });

    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to update profile.');
    }

    const data = await res.json();
    this.profile = data.profile;
    return data.profile;
  }

  // ============================================================
  // NOTEBOOKS (BACKED BY POSTGRESQL)
  // ============================================================

  getNotebooks(): Notebook[] {
    return this.notebooks;
  }

  getNotebookById(id: string): Notebook | undefined {
    return this.notebooks.find((nb) => nb.id === id);
  }

  async refreshNotebooks(): Promise<Notebook[]> {
    const res = await this.authFetch('/api/notebooks');
    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to refresh notebooks.');
    }
    const data = await res.json();
    this.notebooks = Array.isArray(data.notebooks)
      ? data.notebooks.map(mapServerNotebook)
      : [];
    return this.notebooks;
  }

  async createNotebook(
    titleOrData: string | { title: string; code?: string; description?: string },
    description?: string,
    code?: string
  ): Promise<Notebook> {
    const title = typeof titleOrData === 'string' ? titleOrData : titleOrData.title;
    const finalCode = typeof titleOrData === 'string' ? code : titleOrData.code;
    const finalDesc = typeof titleOrData === 'string' ? description : titleOrData.description;

    const res = await this.authFetch('/api/notebooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        code: finalCode,
        description: finalDesc,
      }),
    });

    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to create notebook.');
    }

    const data = await res.json();
    const created = mapServerNotebook(data.notebook);
    this.notebooks = [created, ...this.notebooks.filter((n) => n.id !== created.id)];
    await this.fetchRecentActivity().catch(() => {});
    return created;
  }

  async deleteNotebook(id: string): Promise<void> {
    const res = await this.authFetch(`/api/notebooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to delete notebook.');
    }

    this.notebooks = this.notebooks.filter((nb) => nb.id !== id);
    delete this.chatsByNotebook[id];
    delete this.chatSummaries[id];
    await this.fetchRecentActivity().catch(() => {});
  }

  // ============================================================
  // CHAT MESSAGES (BACKED BY POSTGRESQL)
  // ============================================================

  getChatMessages(notebookId: string): ChatMessage[] {
    return this.chatsByNotebook[notebookId] || [];
  }

  async fetchChatMessages(notebookId: string): Promise<ChatMessage[]> {
    const res = await this.authFetch(`/api/notebooks/${encodeURIComponent(notebookId)}/messages`);
    if (!res.ok) {
      if (res.status === 404) return [];
      throw await this.parseErrorResponse(res, 'Failed to load chat history.');
    }
    const data = await res.json();
    const list: ChatMessage[] = Array.isArray(data.messages) ? data.messages : [];
    this.chatsByNotebook[notebookId] = list;
    return list;
  }

  async persistChatMessage(notebookId: string, message: ChatMessage): Promise<ChatMessage> {
    const current = this.chatsByNotebook[notebookId] || [];
    if (!current.some((m) => m.id === message.id)) {
      this.chatsByNotebook[notebookId] = [...current, message];
    }

    const res = await this.authFetch(`/api/notebooks/${encodeURIComponent(notebookId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to save chat message.');
    }
    const data = await res.json();
    return data.message || message;
  }

  async clearChatMessages(notebookId: string): Promise<void> {
    const res = await this.authFetch(`/api/notebooks/${encodeURIComponent(notebookId)}/messages`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to clear chat history.');
    }
    delete this.chatsByNotebook[notebookId];
    delete this.chatSummaries[notebookId];
  }

  // ============================================================
  // SMART SUMMARY SUITE (POSTGRESQL + GEMINI BACKEND)
  // ============================================================

  getNotebookChatSummary(notebookId: string): NotebookChatSummary | null {
    return this.chatSummaries[notebookId] || null;
  }

  saveNotebookChatSummary(summary: NotebookChatSummary): void {
    this.chatSummaries[summary.notebookId] = summary;
  }

  async fetchNotebookSummaries(notebookId: string): Promise<{
    chatSummary: NotebookChatSummary | null;
    documentSummaries: DocumentSummary[];
  }> {
    const res = await this.authFetch(`/api/summary/notebook/${encodeURIComponent(notebookId)}`);
    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to load saved summaries.');
    }
    const data = await res.json();
    const nb = this.getNotebookById(notebookId);

    let chatSummary: NotebookChatSummary | null = null;
    if (data.chatSummary) {
      chatSummary = {
        notebookId,
        notebookTitle: nb?.title || data.chatSummary.notebookTitle || 'Course Notebook',
        summary: data.chatSummary.summary,
        generatedAt: data.chatSummary.generatedAt,
        messageCount: data.chatSummary.messageCount || 0,
        hasChat: true,
      };
      this.chatSummaries[notebookId] = chatSummary;
    }

    const documentSummaries: DocumentSummary[] = [];
    if (Array.isArray(data.documentSummaries)) {
      for (const d of data.documentSummaries) {
        const mapped: DocumentSummary = {
          documentId: d.documentId,
          notebookId: d.notebookId,
          fileName: d.originalFileName || d.fileName,
          summary: d.summary,
          generatedAt: d.generatedAt,
          pageCount: d.pageCount || 1,
          fileSize: d.fileSize,
          status: 'completed',
        };
        this.docSummaries[mapped.documentId] = mapped;
        documentSummaries.push(mapped);
      }
    }

    return { chatSummary, documentSummaries };
  }

  async fetchOrGenerateChatSummary(
    notebookId: string,
    history: ChatMessage[],
    notebookTitle: string = 'Course Notebook',
    forceRegenerate: boolean = false
  ): Promise<NotebookChatSummary> {
    const validHistory = history.filter((m) => m && m.text && m.text.trim().length > 0);

    if (validHistory.length === 0) {
      return {
        notebookId,
        notebookTitle,
        summary: `> **No Chat History Available**\n\nYou haven't started a conversation in **${notebookTitle}** yet. Ask questions in the AI Tutor chat workspace to build your study dialogue, and generate a comprehensive conversation summary anytime!`,
        generatedAt: new Date().toLocaleString(),
        messageCount: 0,
        hasChat: false,
      };
    }

    if (!forceRegenerate) {
      const cached = this.getNotebookChatSummary(notebookId);
      if (cached && cached.messageCount === validHistory.length && cached.hasChat) {
        return cached;
      }
    }

    const payload = {
      notebookId,
      notebookTitle,
      forceRegenerate,
      history: validHistory.map((m) => ({
        role: m.sender === 'user' ? 'user' : 'assistant',
        content: m.text,
        timestamp: m.timestamp,
      })),
    };

    let res: Response;
    try {
      res = await this.authFetch('/api/summary/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        err?.message || 'Unable to connect to the summary server. Please check your connection and try again.',
        'NETWORK_ERROR',
        true
      );
    }

    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to generate notebook chat summary.');
    }

    const data = await res.json();
    const summaryObj: NotebookChatSummary = {
      notebookId,
      notebookTitle,
      summary: data.summary,
      generatedAt: data.generatedAt || new Date().toLocaleString(),
      messageCount: data.messageCount || validHistory.length,
      hasChat: data.hasChat !== false,
    };
    this.saveNotebookChatSummary(summaryObj);
    return summaryObj;
  }

  getDocumentSummary(documentId: string): DocumentSummary | null {
    return this.docSummaries[documentId] || null;
  }

  saveDocumentSummary(summary: DocumentSummary): void {
    this.docSummaries[summary.documentId] = summary;
  }

  getAllDocumentSummaries(notebookId: string): Record<string, DocumentSummary> {
    const filtered: Record<string, DocumentSummary> = {};
    Object.entries(this.docSummaries).forEach(([docId, sum]) => {
      if (sum.notebookId === notebookId) {
        filtered[docId] = sum;
      }
    });
    return filtered;
  }

  async fetchOrGenerateDocumentSummary(
    documentId: string,
    notebookId: string,
    forceRegenerate: boolean = false
  ): Promise<DocumentSummary> {
    const targetNb = this.notebooks.find((n) => n.id === notebookId);
    const targetDoc = targetNb?.documents.find((d) => d.id === documentId);
    const fileName = targetDoc?.name || 'Document.pdf';
    const pageCount = targetDoc?.pages || 1;
    const fileSize = targetDoc?.size || '1.0 MB';

    if (!forceRegenerate) {
      const cached = this.getDocumentSummary(documentId);
      if (cached && cached.status === 'completed' && cached.summary && cached.summary.length > 50) {
        return cached;
      }
    }

    let res: Response;
    try {
      res = await this.authFetch('/api/summary/document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId,
          notebookId,
          forceRegenerate,
        }),
      });
    } catch (err: any) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        err?.message || 'Unable to connect to the summary server. Please check your connection and try again.',
        'NETWORK_ERROR',
        true
      );
    }

    if (!res.ok) {
      throw await this.parseErrorResponse(res, `Failed to generate summary for "${fileName}".`);
    }

    const data = await res.json();
    const isErrorStatus = data.status === 'error';
    const summaryObj: DocumentSummary = {
      documentId,
      notebookId,
      fileName: data.fileName || fileName,
      summary: data.summary || '',
      generatedAt: data.generatedAt || new Date().toLocaleString(),
      pageCount: data.pageCount || pageCount,
      fileSize,
      status: isErrorStatus ? 'error' : 'completed',
      error: data.error,
    };
    if (!isErrorStatus) {
      this.saveDocumentSummary(summaryObj);
    }
    return summaryObj;
  }

  // ============================================================
  // QUESTIONS & EXAMS (PERSISTED TO POSTGRESQL)
  // ============================================================

  getQuestions(count: number = 10, topic?: string): PracticeQuestion[] {
    let list = [...sampleQuestions];
    if (topic && topic !== 'All Topics') {
      list = list.filter((q) => q.topic.toLowerCase().includes(topic.toLowerCase()));
    }
    return list.slice(0, count);
  }

  getExamQuestions(_notebookId?: string): PracticeQuestion[] {
    return this.getQuestions(10);
  }

  async submitExam(
    notebookId: string,
    questions: PracticeQuestion[],
    userAnswers: Record<number, number>,
    timeTakenSeconds: number
  ): Promise<ExamResult> {
    let correctCount = 0;
    let incorrectCount = 0;
    let skippedCount = 0;
    const topicStats: Record<string, { correct: number; total: number }> = {};

    const reviewQuestions = questions.map((q, idx) => {
      const selected = userAnswers[idx];
      const hasAnswered = selected !== undefined && selected !== null;
      const isCorrect = hasAnswered && selected === q.correctAnswer;

      if (!hasAnswered) skippedCount++;
      else if (isCorrect) correctCount++;
      else incorrectCount++;

      if (!topicStats[q.topic]) topicStats[q.topic] = { correct: 0, total: 0 };
      topicStats[q.topic].total += 1;
      if (isCorrect) topicStats[q.topic].correct += 1;

      return { question: q, selectedOption: selected, isCorrect };
    });

    const totalQuestions = questions.length;
    const percentage = Math.round((correctCount / (totalQuestions || 1)) * 100);

    const topicPerformance = Object.keys(topicStats).map((topic) => {
      const { correct, total } = topicStats[topic];
      const pct = Math.round((correct / total) * 100);
      return {
        topic,
        score: correct,
        total,
        percentage: pct,
        status: (pct >= 80 ? 'strong' : pct < 60 ? 'weak' : 'moderate') as 'strong' | 'weak' | 'moderate',
      };
    });

    const strongTopics = topicPerformance.filter((t) => t.percentage >= 75).map((t) => t.topic);
    const weakTopics = topicPerformance.filter((t) => t.percentage < 70).map((t) => t.topic);

    const recommendation =
      weakTopics.length > 0
        ? `Revise ${weakTopics.join(' and ')} from your uploaded unit notes and attempt another practice exam.`
        : 'Outstanding performance! You have mastered the key concepts in this unit.';

    const nb = this.getNotebookById(notebookId);
    const result: ExamResult = {
      examId: 'exam_' + Date.now(),
      notebookId,
      notebookTitle: nb?.title || 'Course Practice Test',
      totalQuestions,
      correctCount,
      incorrectCount,
      skippedCount,
      percentage,
      timeTakenSeconds,
      topicPerformance,
      strongTopics: strongTopics.length ? strongTopics : ['General Concepts'],
      weakTopics,
      recommendation,
      reviewQuestions,
    };

    const res = await this.authFetch('/api/exams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });

    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to save exam result.');
    }

    const saved = await res.json();
    const persistedResult: ExamResult = saved.exam || result;

    this.examResults = [persistedResult, ...this.examResults];
    this.notebooks = this.notebooks.map((n) =>
      n.id === notebookId
        ? { ...n, progress: Math.min(100, Math.max(n.progress, percentage)), lastStudied: 'Just now' }
        : n
    );
    await this.fetchRecentActivity().catch(() => {});

    return persistedResult;
  }

  getUserExamResults(): ExamResult[] {
    return this.examResults;
  }

  getUserExamStats(): { examsCompleted: number; averageScore: string } {
    const exams = this.examResults;
    if (exams.length === 0) {
      return { examsCompleted: 0, averageScore: '—' };
    }
    const avg = Math.round(exams.reduce((acc, e) => acc + e.percentage, 0) / exams.length);
    return {
      examsCompleted: exams.length,
      averageScore: `${avg}%`,
    };
  }

  // ============================================================
  // ACTIVITY & ANALYTICS
  // ============================================================

  getRecentActivity(): RecentActivityItem[] {
    return this.recentActivity;
  }

  async fetchRecentActivity(): Promise<RecentActivityItem[]> {
    const res = await this.authFetch('/api/activity');
    if (res.ok) {
      const data = await res.json();
      this.recentActivity = Array.isArray(data.activity) ? data.activity : [];
    }
    return this.recentActivity;
  }

  async clearRecentActivity(): Promise<void> {
    const res = await this.authFetch('/api/activity', { method: 'DELETE' });
    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to clear recent activity.');
    }
    this.recentActivity = [];
  }

  getAnalytics(): AnalyticsData {
    const notebooks = this.notebooks;
    const exams = this.examResults;

    const totalDocs = notebooks.reduce((acc, n) => acc + n.documentsCount, 0);
    const totalQuestions = exams.reduce((acc, e) => acc + e.totalQuestions, 0);
    const avgPct =
      exams.length > 0
        ? Math.round(exams.reduce((acc, e) => acc + e.percentage, 0) / exams.length)
        : 0;

    const studyProgress =
      notebooks.length > 0
        ? Math.round(notebooks.reduce((acc, n) => acc + n.progress, 0) / notebooks.length)
        : 0;

    const scoreHistory = exams.map((e, idx) => ({
      date: `Test ${idx + 1}`,
      score: e.percentage,
      subject: e.notebookTitle.split(' ')[0] || 'Exam',
    }));

    const weakMap: Record<string, { count: number; subject: string; recommendation: string }> = {};
    const strongMap: Record<string, { count: number; subject: string }> = {};

    exams.forEach((e) => {
      e.weakTopics.forEach((t) => {
        if (!weakMap[t]) {
          weakMap[t] = { count: 0, subject: e.notebookTitle, recommendation: e.recommendation };
        }
        weakMap[t].count++;
      });
      e.strongTopics.forEach((t) => {
        if (!strongMap[t]) {
          strongMap[t] = { count: 0, subject: e.notebookTitle };
        }
        strongMap[t].count++;
      });
    });

    const weakTopics = Object.entries(weakMap).map(([topic, val]) => ({
      topic,
      score: 52,
      subject: val.subject,
      recommendation: val.recommendation,
    }));

    const strongTopics = Object.entries(strongMap).map(([topic, val]) => ({
      topic,
      score: 88,
      subject: val.subject,
    }));

    const topicAccuracy = notebooks.map((nb) => ({
      topic: nb.title.split('(')[0].trim(),
      accuracy: nb.progress,
      totalQuestions: nb.documentsCount * 10,
    }));

    return {
      totalNotebooks: notebooks.length,
      totalDocuments: totalDocs,
      examsCompleted: exams.length,
      averageScore: avgPct,
      questionsAnswered: totalQuestions,
      studyProgress,
      scoreHistory: scoreHistory.length > 0 ? scoreHistory : [{ date: 'Today', score: 0, subject: 'None' }],
      topicAccuracy: topicAccuracy.length > 0 ? topicAccuracy : [{ topic: 'General', accuracy: 0, totalQuestions: 0 }],
      weakTopics,
      strongTopics,
      studyRecommendation:
        weakTopics.length > 0
          ? `Focus on weak areas in ${weakTopics[0].topic} (${weakTopics[0].subject}).`
          : exams.length === 0
          ? 'Take your first practice exam to generate diagnostic insights and weak topic tracking.'
          : 'Great work! Continue regular practice tests to maintain topic mastery.',
    };
  }

  // ============================================================
  // DOCUMENT UPLOAD, STORAGE SIGNED URLS, RETRY & VECTOR RAG
  // ============================================================

  async uploadDocumentToBackend(
    file: File,
    notebookId: string,
    onStatusUpdate?: (status: {
      stage: string;
      progress: number;
      message: string;
      totalPages?: number;
      chunkCount?: number;
      status: string;
      metrics?: any;
      error?: string | null;
    }) => void,
    signal?: AbortSignal
  ): Promise<{ documentId: string; document: DocumentItem }> {
    this.requireActiveUserId();
    const formData = new FormData();
    formData.append('file', file);
    formData.append('notebookId', notebookId);

    if (onStatusUpdate) {
      onStatusUpdate({
        stage: 'Uploading document to server',
        progress: 10,
        message: 'Streaming file to private Supabase Storage...',
        status: 'UPLOADING',
      });
    }

    let uploadData: any = null;
    let lastError: ApiError | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) {
        throw new DOMException('Upload aborted by user', 'AbortError');
      }
      try {
        const uploadRes = await this.authFetch('/api/documents/upload', {
          method: 'POST',
          body: formData,
          signal,
        });

        const contentType = uploadRes.headers.get('content-type') || '';
        if (uploadRes.ok && contentType.includes('application/json')) {
          uploadData = await uploadRes.json();
          break;
        }

        lastError = await this.parseErrorResponse(uploadRes, 'Document upload failed.');
        if (!lastError.retryable || attempt === 1) {
          throw lastError;
        }
        await new Promise((r) => setTimeout(r, 600));
      } catch (err: any) {
        if (signal?.aborted || err?.name === 'AbortError') {
          throw new DOMException('Upload aborted by user', 'AbortError');
        }
        if (err instanceof ApiError && !err.retryable) {
          throw err;
        }
        lastError =
          err instanceof ApiError
            ? err
            : new ApiError(err?.message || 'Unable to reach document upload server.', 'NETWORK_ERROR', true);
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }

    if (!uploadData || !uploadData.documentId) {
      throw lastError || new ApiError('Document upload failed on the server. Please retry.', 'UPLOAD_FAILED', true);
    }

    const documentId = uploadData.documentId;

    // If synchronous processing already finished (e.g. Vercel inline fallback)
    if (uploadData.status === 'COMPLETED' && uploadData.document) {
      const completedDoc = mapServerDocumentToItem(uploadData.document);
      if (onStatusUpdate) {
        onStatusUpdate({
          stage: completedDoc.currentStage || 'COMPLETED',
          progress: 100,
          message: completedDoc.message || 'Document indexed successfully.',
          totalPages: completedDoc.pages,
          chunkCount: completedDoc.extractedChunksCount,
          status: 'COMPLETED',
          metrics: completedDoc.metrics,
        });
      }
      this.appendDocumentToNotebook(notebookId, completedDoc);
      await this.fetchRecentActivity().catch(() => {});
      return { documentId, document: completedDoc };
    }

    if (onStatusUpdate) {
      onStatusUpdate({
        stage: 'Document uploaded and queued',
        progress: 20,
        message: 'File stored securely in private bucket. Processing job queued...',
        status: 'UPLOADED',
      });
    }

    return this.pollDocumentStatus(documentId, notebookId, file.name, formatBytes(file.size), onStatusUpdate, signal);
  }

  private pollDocumentStatus(
    documentId: string,
    notebookId: string,
    fileName: string,
    fileSizeLabel: string,
    onStatusUpdate?: (status: any) => void,
    signal?: AbortSignal
  ): Promise<{ documentId: string; document: DocumentItem }> {
    return new Promise((resolve, reject) => {
      let pollAttempts = 0;
      let consecutiveFailures = 0;
      const MAX_POLL_ATTEMPTS = 350;

      const interval = setInterval(async () => {
        if (signal?.aborted) {
          clearInterval(interval);
          reject(new DOMException('Upload aborted by user', 'AbortError'));
          return;
        }
        pollAttempts++;
        if (pollAttempts > MAX_POLL_ATTEMPTS) {
          clearInterval(interval);
          reject(
            new ApiError(
              'Document processing timed out before completion. You can check status or retry shortly.',
              'TIMEOUT',
              true,
              504
            )
          );
          return;
        }

        try {
          const statusRes = await this.authFetch(
            `/api/documents/${encodeURIComponent(documentId)}/status`,
            { signal }
          );
          const contentType = statusRes.headers.get('content-type') || '';

          if (!statusRes.ok || !contentType.includes('application/json')) {
            consecutiveFailures++;
            const err = await this.parseErrorResponse(statusRes, 'Failed to read document processing status.');
            if (statusRes.status === 404 || statusRes.status === 401 || !err.retryable || consecutiveFailures >= 5) {
              clearInterval(interval);
              reject(err);
            }
            return;
          }

          const data = await statusRes.json();
          consecutiveFailures = 0;

          if (onStatusUpdate) {
            onStatusUpdate({
              stage: data.current_stage || data.status,
              progress: data.progress || 0,
              message: data.message || '',
              totalPages: data.total_pages,
              chunkCount: data.chunk_count,
              status: data.status,
              metrics: data.metrics,
              error: data.error,
            });
          }

          if (data.status === 'COMPLETED') {
            clearInterval(interval);
            const docItem: DocumentItem = {
              id: documentId,
              notebookId,
              name: fileName,
              size: fileSizeLabel,
              pages: data.total_pages || 1,
              uploadDate: 'Just now',
              status: 'COMPLETED',
              extractedChunksCount: data.chunk_count || 0,
              currentStage: data.current_stage,
              progress: 100,
              message: data.message,
              metrics: data.metrics,
              previewSnippet: `Indexed ${data.chunk_count} vector chunks across ${data.total_pages} pages in PostgreSQL + pgvector.`,
            };

            this.appendDocumentToNotebook(notebookId, docItem);
            await this.fetchRecentActivity().catch(() => {});
            resolve({ documentId, document: docItem });
          } else if (data.status === 'FAILED') {
            clearInterval(interval);
            await this.refreshNotebooks().catch(() => {});
            reject(
              new ApiError(
                data.error || data.message || `Document ingestion failed for "${fileName}".`,
                'INGESTION_FAILED',
                true
              )
            );
          }
        } catch (err: any) {
          if (signal?.aborted || err?.name === 'AbortError') {
            clearInterval(interval);
            reject(new DOMException('Upload aborted by user', 'AbortError'));
            return;
          }
          consecutiveFailures++;
          if (consecutiveFailures >= 5) {
            clearInterval(interval);
            reject(
              new ApiError(
                err?.message || 'Lost connection while checking document processing status. Please retry.',
                'NETWORK_ERROR',
                true
              )
            );
          }
        }
      }, 450);
    });
  }

  appendDocumentToNotebook(notebookId: string, doc: DocumentItem): void {
    this.notebooks = this.notebooks.map((nb) => {
      if (nb.id === notebookId) {
        const filteredDocs = nb.documents.filter((d) => d.id !== doc.id);
        return {
          ...nb,
          documentsCount: filteredDocs.length + 1,
          lastStudied: 'Just now',
          documents: [doc, ...filteredDocs],
        };
      }
      return nb;
    });
  }

  async retryDocumentProcessing(documentId: string, notebookId: string): Promise<void> {
    const res = await this.authFetch(`/api/documents/${encodeURIComponent(documentId)}/retry`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to retry document processing.');
    }
    const targetNb = this.getNotebookById(notebookId);
    const doc = targetNb?.documents.find((d) => d.id === documentId);
    await this.pollDocumentStatus(
      documentId,
      notebookId,
      doc?.name || 'Document',
      doc?.size || '0 KB'
    );
  }

  async getDocumentDownloadUrl(documentId: string): Promise<{
    url: string;
    expiresInSeconds: number;
    fileName: string;
  }> {
    const res = await this.authFetch(`/api/documents/${encodeURIComponent(documentId)}/download-url`);
    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Unable to generate secure download link.');
    }
    return await res.json();
  }

  async sendRAGQuery(
    notebookId: string,
    query: string,
    documentId?: string,
    history?: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<{
    answer: string;
    sources: SourceReference[];
    isGrounded: boolean;
    retrievalScore: number;
    insufficientInfo: boolean;
  }> {
    this.requireActiveUserId();
    let res: Response;
    try {
      res = await this.authFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          notebookId,
          documentId,
          history,
        }),
      });
    } catch (err: any) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        err?.message || 'Unable to connect to the StudyAI Tutor server. Please check your connection and try again.',
        'NETWORK_ERROR',
        true
      );
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw await this.parseErrorResponse(res, 'StudyAI Tutor returned an unexpected response.');
    }

    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'StudyAI Tutor failed to generate a response.');
    }

    const data = await res.json();
    const sources: SourceReference[] = (data.sources || []).map((s: any) => ({
      docName: s.docName,
      page: s.pageStart,
      pageEnd: s.pageEnd,
      section: s.section,
      snippet: s.snippet,
      score: s.score,
    }));

    return {
      answer: data.answer,
      sources,
      isGrounded: data.isGrounded,
      retrievalScore: data.retrievalScore || 0,
      insufficientInfo: data.insufficientInfo || false,
    };
  }

  async deleteDocumentFromBackend(documentId: string, notebookId: string): Promise<void> {
    const res = await this.authFetch(`/api/documents/${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to delete document.');
    }

    this.notebooks = this.notebooks.map((nb) => {
      if (nb.id === notebookId) {
        const remaining = nb.documents.filter((d) => d.id !== documentId);
        return {
          ...nb,
          documentsCount: remaining.length,
          documents: remaining,
        };
      }
      return nb;
    });
    delete this.docSummaries[documentId];
  }

  async fetchDocumentChunks(documentId: string): Promise<any[]> {
    try {
      const res = await this.authFetch(`/api/documents/${encodeURIComponent(documentId)}/chunks`);
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        return data.chunks || [];
      }
    } catch (e) {
      console.warn('Fetch document chunks failed:', e);
    }
    return [];
  }

  async clearAllData(): Promise<void> {
    const res = await this.authFetch('/api/documents/clear-all', { method: 'POST' });
    if (!res.ok) {
      throw await this.parseErrorResponse(res, 'Failed to wipe user account data.');
    }
    await this.logout();
  }
}

export const apiService = new ApiService();
