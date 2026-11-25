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
import {
  initialNotebooks,
  sampleQuestions,
} from '../mockData';

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

// Storage keys
const STORAGE_KEYS = {
  NOTEBOOKS: 'studyai_notebooks',
  PROFILE: 'studyai_profile',
  CHATS: 'studyai_chats',
  SMART_NOTES: 'studyai_smart_notes',
  SUMMARY_CHATS: 'studyai_summary_chats',
  SUMMARY_DOCS: 'studyai_summary_docs',
  EXAM_RESULTS: 'studyai_exam_results',
  ACTIVITY: 'studyai_activity',
  ANALYTICS: 'studyai_analytics',
  AUTH: 'studyai_auth_token',
  USERS: 'studyai_registered_users',
  REMEMBER_EMAIL: 'studyai_remembered_email',
};

export interface StoredUser {
  id: string;
  name: string;
  email: string;
  password: string;
  degree: string;
  semester: string;
  university: string;
  avatar: string;
  createdAt: string;
}

const defaultInitialUsers: StoredUser[] = [];

class ApiService {
  constructor() {
    this.enforceCleanDataWipe();
  }

  enforceCleanDataWipe(): void {
    const WIPE_KEY = 'studyai_zero_data_v3';
    try {
      if (typeof window !== 'undefined' && localStorage.getItem(WIPE_KEY) !== 'purged') {
        const theme = localStorage.getItem('study_ai_theme');
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('studyai_') || (k.startsWith('study_ai_') && k !== 'study_ai_theme'))) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach((k) => localStorage.removeItem(k));
        if (theme) {
          localStorage.setItem('study_ai_theme', theme);
        }
        localStorage.setItem(WIPE_KEY, 'purged');
      }
    } catch (e) {
      console.warn('Wipe failed:', e);
    }
  }

  private getStorage<T>(key: string, fallback: T): T {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : fallback;
    } catch {
      return fallback;
    }
  }

  private setStorage<T>(key: string, data: T): void {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      console.warn('Storage save failed:', e);
    }
  }

  // User Scoping Helpers
  getActiveUserId(): string {
    const profile = this.getProfile();
    return profile?.id || 'guest';
  }

  requireActiveUserId(): string {
    const profile = this.getProfile();
    const uid = profile?.id?.trim();
    if (!uid || uid === 'guest' || uid === 'student_demo') {
      throw new ApiError('Please sign in to your StudyAI account to continue.', 'AUTH_REQUIRED', false, 401);
    }
    return uid;
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
        // fall through to default error
      }
    }
    return new ApiError(
      `${defaultMessage} (HTTP ${res.status})`,
      'HTTP_ERROR',
      res.status >= 500 || res.status === 408 || res.status === 429,
      res.status
    );
  }

  private getUserScopedKey(baseKey: string, customUserId?: string): string {
    const uid = customUserId || this.getActiveUserId();
    return `${baseKey}_${uid}`;
  }

  // Authentication
  getProfile(): StudentProfile | null {
    if (!this.isAuthenticated()) {
      return null;
    }
    const profile = this.getStorage<StudentProfile | null>(STORAGE_KEYS.PROFILE, null);
    if (!profile) {
      return null;
    }
    // Filter out old demo user profile
    if (profile.id === 'student_001' || profile.email.toLowerCase() === 'alex.sharma@mca.edu') {
      this.logout();
      return null;
    }
    return profile;
  }

  updateProfile(profile: Partial<StudentProfile>): StudentProfile {
    const current = this.getProfile() || {
      id: 'student_' + Date.now(),
      name: 'Student',
      email: 'student@edu.com',
      avatar: 'ST',
      degree: 'Master of Computer Applications (MCA)',
      semester: 'Semester II',
      university: 'Department of Computer Science',
    };
    const updated = { ...current, ...profile };
    this.setStorage(STORAGE_KEYS.PROFILE, updated);

    // Also update in registered users list
    const users = this.getRegisteredUsers().map((u) => {
      if (u.id === updated.id || u.email.toLowerCase() === updated.email.toLowerCase()) {
        return {
          ...u,
          name: updated.name || u.name,
          degree: updated.degree || u.degree,
          semester: updated.semester || u.semester,
          university: updated.university || u.university,
          avatar: updated.avatar || u.avatar,
        };
      }
      return u;
    });
    this.setStorage(STORAGE_KEYS.USERS, users);
    return updated;
  }

  isAuthenticated(): boolean {
    return !!localStorage.getItem(STORAGE_KEYS.AUTH);
  }

  getRegisteredUsers(): StoredUser[] {
    const users = this.getStorage<StoredUser[]>(STORAGE_KEYS.USERS, []);
    if (!users || !Array.isArray(users)) {
      return [];
    }
    // Filter out demo user
    return users.filter(
      (u) => u.id !== 'student_001' && u.email.toLowerCase() !== 'alex.sharma@mca.edu'
    );
  }

  authenticateUser(
    emailInput: string,
    passwordInput: string
  ): { success: boolean; error?: string; profile?: StudentProfile } {
    const email = (emailInput || '').trim().toLowerCase();
    const password = (passwordInput || '').trim();

    if (!email) {
      return { success: false, error: 'Email address is required.' };
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { success: false, error: 'Please enter a valid email address (e.g., student@university.edu).' };
    }
    if (!password) {
      return { success: false, error: 'Password is required.' };
    }

    const users = this.getRegisteredUsers();
    const user = users.find((u) => u.email.toLowerCase() === email);

    if (!user) {
      return {
        success: false,
        error: `No registered account found for "${email}". Please check the spelling or switch to Register to create a new account.`,
      };
    }

    if (user.password !== password) {
      return {
        success: false,
        error: 'Incorrect password. Please verify your password and try again.',
      };
    }

    const token = 'jwt_token_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    localStorage.setItem(STORAGE_KEYS.AUTH, token);

    const profile: StudentProfile = {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar || user.name.slice(0, 2).toUpperCase(),
      degree: user.degree || 'Master of Computer Applications (MCA)',
      semester: user.semester || 'Semester II',
      university: user.university || 'Department of Computer Science',
    };

    this.setStorage(STORAGE_KEYS.PROFILE, profile);
    return { success: true, profile };
  }

  registerUser(data: {
    name: string;
    email: string;
    password: string;
    degree?: string;
    semester?: string;
    university?: string;
  }): { success: boolean; error?: string; profile?: StudentProfile } {
    const name = (data.name || '').trim();
    const email = (data.email || '').trim().toLowerCase();
    const password = (data.password || '').trim();

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

    const users = this.getRegisteredUsers();
    if (users.some((u) => u.email.toLowerCase() === email)) {
      return {
        success: false,
        error: 'An account with this email address already exists. Please sign in instead.',
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

    const newUser: StoredUser = {
      id: 'student_' + Date.now(),
      name,
      email,
      password,
      degree: data.degree || 'Master of Computer Applications (MCA)',
      semester: data.semester || 'Semester II',
      university: data.university || 'Department of Computer Science',
      avatar: initials,
      createdAt: new Date().toISOString(),
    };

    users.push(newUser);
    this.setStorage(STORAGE_KEYS.USERS, users);

    const token = 'jwt_token_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    localStorage.setItem(STORAGE_KEYS.AUTH, token);

    const profile: StudentProfile = {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      avatar: newUser.avatar,
      degree: newUser.degree,
      semester: newUser.semester,
      university: newUser.university,
    };

    this.setStorage(STORAGE_KEYS.PROFILE, profile);

    // Initialize personal dashboard activity for this new user
    const userActivityKey = this.getUserScopedKey(STORAGE_KEYS.ACTIVITY, newUser.id);
    const welcomeActivity: RecentActivityItem[] = [
      {
        id: 'act_reg_' + Date.now(),
        type: 'document',
        title: 'Personal Workspace Initialized',
        subtitle: `Account created for ${newUser.name} (${newUser.degree})`,
        timestamp: 'Just now',
        notebookTitle: 'Dashboard',
      },
    ];
    this.setStorage(userActivityKey, welcomeActivity);

    // Initialize personal notebooks key to empty array for new user
    const userNotebooksKey = this.getUserScopedKey(STORAGE_KEYS.NOTEBOOKS, newUser.id);
    this.setStorage(userNotebooksKey, []);

    return { success: true, profile };
  }

  getRememberedEmail(): string {
    return localStorage.getItem(STORAGE_KEYS.REMEMBER_EMAIL) || '';
  }

  setRememberedEmail(email: string, remember: boolean): void {
    if (remember && email.trim()) {
      localStorage.setItem(STORAGE_KEYS.REMEMBER_EMAIL, email.trim());
    } else {
      localStorage.removeItem(STORAGE_KEYS.REMEMBER_EMAIL);
    }
  }

  logout(): void {
    localStorage.removeItem(STORAGE_KEYS.AUTH);
    localStorage.removeItem(STORAGE_KEYS.PROFILE);
  }

  // Notebooks
  getNotebooks(customUserId?: string): Notebook[] {
    const uid = customUserId || this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.NOTEBOOKS, uid);
    const existing = localStorage.getItem(key);
    if (existing !== null) {
      try {
        const list: Notebook[] = JSON.parse(existing);
        return (list || []).filter(
          (nb: Notebook) =>
            nb.id !== 'nb_dbms' &&
            nb.id !== 'nb_cn' &&
            nb.id !== 'nb_os' &&
            nb.title !== 'Database Management Systems'
        );
      } catch {
        return [];
      }
    }

    this.setStorage(key, []);
    return [];
  }

  saveNotebooks(notebooks: Notebook[], customUserId?: string): void {
    const uid = customUserId || this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.NOTEBOOKS, uid);
    this.setStorage(key, notebooks);
  }

  getNotebookById(id: string): Notebook | undefined {
    const notebooks = this.getNotebooks();
    return notebooks.find((nb) => nb.id === id);
  }

  createNotebook(
    titleOrData: string | { title: string; code?: string; description?: string },
    description?: string,
    code?: string
  ): Notebook {
    const notebooks = this.getNotebooks();
    const title = typeof titleOrData === 'string' ? titleOrData : titleOrData.title;
    const finalCode =
      typeof titleOrData === 'string'
        ? code || 'MCA-' + (200 + notebooks.length + 1)
        : titleOrData.code || 'MCA-' + (200 + notebooks.length + 1);
    const finalDesc =
      typeof titleOrData === 'string'
        ? description || 'Custom study notebook for student course preparation.'
        : titleOrData.description || 'Custom study notebook for student course preparation.';

    const newNotebook: Notebook = {
      id: 'nb_' + Date.now(),
      title,
      code: finalCode,
      description: finalDesc,
      iconName: 'BookOpen',
      accentColor: '#2563EB',
      documentsCount: 0,
      progress: 0,
      lastStudied: 'Just now',
      documents: [],
    };
    const updated = [newNotebook, ...notebooks];
    this.saveNotebooks(updated);
    this.addActivity({
      type: 'document',
      title: `Created notebook: ${newNotebook.title}`,
      subtitle: 'Ready for PDF source upload and AI indexing',
      notebookTitle: newNotebook.title,
    });
    return newNotebook;
  }

  loadStarterCoursesForActiveUser(): Notebook[] {
    const uid = this.getActiveUserId();
    const starterCourses: Notebook[] = JSON.parse(JSON.stringify(initialNotebooks)).map((nb: Notebook) => ({
      ...nb,
      id: `nb_${nb.id.replace('nb_', '')}_${Date.now().toString(36)}`,
      lastStudied: 'Just now',
      progress: 0,
    }));

    this.saveNotebooks(starterCourses, uid);
    this.addActivity({
      type: 'document',
      title: 'Loaded Starter MCA Courses',
      subtitle: 'DBMS, Computer Networks, and Operating Systems added to your dashboard',
      notebookTitle: 'Personal Dashboard',
    });
    return starterCourses;
  }

  deleteNotebook(id: string): void {
    const uid = this.getActiveUserId();
    const notebooks = this.getNotebooks();
    const target = notebooks.find((nb) => nb.id === id);
    const filtered = notebooks.filter((nb) => nb.id !== id);
    this.saveNotebooks(filtered);

    // Clean up local chat messages for this notebook
    try {
      const chatsKey = this.getUserScopedKey(STORAGE_KEYS.CHATS, uid);
      const stored = this.getStorage<Record<string, ChatMessage[]>>(chatsKey, {});
      if (stored && typeof stored === 'object') {
        const updatedChats = { ...stored };
        delete updatedChats[id];
        this.setStorage(chatsKey, updatedChats);
      }
    } catch {
      // Ignore
    }

    // Record activity
    if (target) {
      this.addActivity({
        type: 'document',
        title: `Deleted notebook "${target.title}"`,
        subtitle: 'All documents and study data cleared',
        notebookTitle: target.title,
      });
    }

    // Inform backend to clean up indexed files and vectors
    const userQuery = uid && uid !== 'guest' ? `?userId=${encodeURIComponent(uid)}` : '';
    fetch(`/api/documents/notebooks/${encodeURIComponent(id)}${userQuery}`, { method: 'DELETE' }).catch((err) => {
      console.warn('Backend notebook deletion notice failed:', err);
    });
  }

  // Documents
  addDocumentToNotebook(notebookId: string, doc: DocumentItem): void {
    const notebooks = this.getNotebooks();
    const updated = notebooks.map((nb) => {
      if (nb.id === notebookId) {
        return {
          ...nb,
          documentsCount: nb.documentsCount + 1,
          lastStudied: 'Just now',
          documents: [doc, ...nb.documents],
        };
      }
      return nb;
    });

    this.saveNotebooks(updated);
    const targetNb = notebooks.find((n) => n.id === notebookId);
    this.addActivity({
      type: 'document',
      title: `Uploaded ${doc.name}`,
      subtitle: `${doc.pages} pages processed • ${doc.extractedChunksCount} vector chunks indexed`,
      notebookTitle: targetNb?.title || 'Notebook',
    });
  }



  deleteDocument(notebookId: string, docId: string): void {
    const notebooks = this.getNotebooks().map((nb) => {
      if (nb.id === notebookId) {
        return {
          ...nb,
          documentsCount: Math.max(0, nb.documentsCount - 1),
          documents: nb.documents.filter((d) => d.id !== docId),
        };
      }
      return nb;
    });
    this.saveNotebooks(notebooks);
  }

  // Chat & AI Tutor
  getChatMessages(notebookId: string): ChatMessage[] {
    const uid = this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.CHATS, uid);
    try {
      const allChats = this.getStorage<Record<string, ChatMessage[]>>(key, {});
      if (allChats && typeof allChats === 'object' && !Array.isArray(allChats)) {
        if (Array.isArray(allChats[notebookId])) {
          return allChats[notebookId];
        }
      }
      return [];
    } catch {
      return [];
    }
  }

  saveChatMessages(notebookId: string, messages: ChatMessage[]): void {
    const uid = this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.CHATS, uid);
    try {
      const stored = this.getStorage<Record<string, ChatMessage[]>>(key, {});
      const allChats = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? { ...stored } : {};
      allChats[notebookId] = messages;
      this.setStorage(key, allChats);
    } catch (e) {
      console.warn('Failed saving chat messages:', e);
    }
  }

  clearChatMessages(notebookId: string): void {
    const uid = this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.CHATS, uid);
    try {
      const stored = this.getStorage<Record<string, ChatMessage[]>>(key, {});
      const allChats = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? { ...stored } : {};
      delete allChats[notebookId];
      this.setStorage(key, allChats);
    } catch (e) {
      console.warn('Failed clearing chat messages:', e);
    }
  }



  // ============================================================
  // SMART SUMMARY SUITE (Notebook Chat & Per-PDF Summaries)
  // ============================================================

  getNotebookChatSummary(notebookId: string): NotebookChatSummary | null {
    const uid = this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.SUMMARY_CHATS, uid);
    try {
      const all = this.getStorage<Record<string, NotebookChatSummary>>(key, {});
      return all[notebookId] || null;
    } catch {
      return null;
    }
  }

  saveNotebookChatSummary(summary: NotebookChatSummary): void {
    const uid = this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.SUMMARY_CHATS, uid);
    try {
      const all = this.getStorage<Record<string, NotebookChatSummary>>(key, {});
      all[summary.notebookId] = summary;
      this.setStorage(key, all);
      this.addActivity({
        type: 'note',
        title: 'Generated Chat Summary',
        subtitle: `Chat conversation summary for ${summary.notebookTitle}`,
        notebookTitle: summary.notebookTitle,
      });
    } catch (e) {
      console.warn('Failed to save chat summary:', e);
    }
  }

  async fetchOrGenerateChatSummary(
    notebookId: string,
    history: ChatMessage[],
    notebookTitle: string = 'Course Notebook',
    forceRegenerate: boolean = false
  ): Promise<NotebookChatSummary> {
    const validHistory = history.filter((m) => m && m.text && m.text.trim().length > 0);

    if (validHistory.length === 0) {
      const emptySummary: NotebookChatSummary = {
        notebookId,
        notebookTitle,
        summary: `> **No Chat History Available**\n\nYou haven't started a conversation in **${notebookTitle}** yet. Ask questions in the AI Tutor chat workspace to build your study dialogue, and generate a comprehensive conversation summary anytime!`,
        generatedAt: new Date().toLocaleString(),
        messageCount: 0,
        hasChat: false,
      };
      return emptySummary;
    }

    // Check localStorage cache if not forced
    if (!forceRegenerate) {
      const cached = this.getNotebookChatSummary(notebookId);
      if (cached && cached.messageCount === validHistory.length && cached.hasChat) {
        return cached;
      }
    }

    const uid = this.requireActiveUserId();
    const payload = {
      notebookId,
      userId: uid,
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
      res = await fetch('/api/summary/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
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
    const uid = this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.SUMMARY_DOCS, uid);
    try {
      const all = this.getStorage<Record<string, DocumentSummary>>(key, {});
      return all[documentId] || null;
    } catch {
      return null;
    }
  }

  saveDocumentSummary(summary: DocumentSummary): void {
    const uid = this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.SUMMARY_DOCS, uid);
    try {
      const all = this.getStorage<Record<string, DocumentSummary>>(key, {});
      all[summary.documentId] = summary;
      this.setStorage(key, all);
      this.addActivity({
        type: 'document',
        title: `Summary for ${summary.fileName}`,
        subtitle: `Smart Document Summary generated (${summary.pageCount} pages)`,
        notebookTitle: 'Document Repository',
      });
    } catch (e) {
      console.warn('Failed to save doc summary:', e);
    }
  }

  getAllDocumentSummaries(notebookId: string): Record<string, DocumentSummary> {
    const uid = this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.SUMMARY_DOCS, uid);
    try {
      const all = this.getStorage<Record<string, DocumentSummary>>(key, {});
      const filtered: Record<string, DocumentSummary> = {};
      Object.entries(all).forEach(([docId, sum]) => {
        if (sum.notebookId === notebookId) {
          filtered[docId] = sum;
        }
      });
      return filtered;
    } catch {
      return {};
    }
  }

  async fetchOrGenerateDocumentSummary(
    documentId: string,
    notebookId: string,
    forceRegenerate: boolean = false
  ): Promise<DocumentSummary> {
    const notebooks = this.getNotebooks();
    const targetNb = notebooks.find((n) => n.id === notebookId);
    const targetDoc = targetNb?.documents.find((d) => d.id === documentId);
    const fileName = targetDoc?.name || 'Document.pdf';
    const pageCount = targetDoc?.pages || 1;
    const fileSize = targetDoc?.size || '1.0 MB';

    // Check localStorage cache if not forced
    if (!forceRegenerate) {
      const cached = this.getDocumentSummary(documentId);
      if (cached && cached.status === 'completed' && cached.summary && cached.summary.length > 50) {
        return cached;
      }
    }

    const uid = this.requireActiveUserId();
    const payload = {
      documentId,
      notebookId,
      userId: uid,
      forceRegenerate,
    };

    let res: Response;
    try {
      res = await fetch('/api/summary/document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
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

  // Questions & Exams
  getQuestions(count: number = 10, topic?: string): PracticeQuestion[] {
    let list = [...sampleQuestions];
    if (topic && topic !== 'All Topics') {
      list = list.filter((q) => q.topic.toLowerCase().includes(topic.toLowerCase()));
    }
    return list.slice(0, count);
  }

  getExamQuestions(notebookId?: string): PracticeQuestion[] {
    return this.getQuestions(10);
  }

  submitExam(
    notebookId: string,
    questions: PracticeQuestion[],
    userAnswers: Record<number, number>,
    timeTakenSeconds: number
  ): ExamResult {
    let correctCount = 0;
    let incorrectCount = 0;
    let skippedCount = 0;

    const topicStats: Record<string, { correct: number; total: number }> = {};

    const reviewQuestions = questions.map((q, idx) => {
      const selected = userAnswers[idx];
      const hasAnswered = selected !== undefined && selected !== null;
      const isCorrect = hasAnswered && selected === q.correctAnswer;

      if (!hasAnswered) {
        skippedCount++;
      } else if (isCorrect) {
        correctCount++;
      } else {
        incorrectCount++;
      }

      // Track by topic
      if (!topicStats[q.topic]) {
        topicStats[q.topic] = { correct: 0, total: 0 };
      }
      topicStats[q.topic].total += 1;
      if (isCorrect) {
        topicStats[q.topic].correct += 1;
      }

      return {
        question: q,
        selectedOption: selected,
        isCorrect,
      };
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
      weakTopics: weakTopics.length ? weakTopics : [],
      recommendation,
      reviewQuestions,
    };

    // Update notebook progress
    if (nb) {
      const updatedNbs = this.getNotebooks().map((n) => {
        if (n.id === notebookId) {
          return {
            ...n,
            progress: Math.min(100, Math.max(n.progress, percentage)),
            lastStudied: 'Just now',
          };
        }
        return n;
      });
      this.saveNotebooks(updatedNbs);
    }

    // Save exam result to user-scoped history
    const uid = this.getActiveUserId();
    const examKey = this.getUserScopedKey(STORAGE_KEYS.EXAM_RESULTS, uid);
    const existingExams = this.getStorage<ExamResult[]>(examKey, []);
    this.setStorage(examKey, [result, ...existingExams]);

    // Add recent activity
    this.addActivity({
      type: 'exam',
      title: `Completed ${nb?.title || 'Course'} Practice Test`,
      subtitle: `Score: ${correctCount} / ${totalQuestions} (${percentage}%) • Time: ${Math.floor(timeTakenSeconds / 60)}m ${timeTakenSeconds % 60}s`,
      timestamp: 'Just now',
      score: `${percentage}%`,
      notebookTitle: nb?.title || 'Course',
    });

    return result;
  }

  // User Exam History & Stats
  getUserExamResults(userId?: string): ExamResult[] {
    const uid = userId || this.getActiveUserId();
    const examKey = this.getUserScopedKey(STORAGE_KEYS.EXAM_RESULTS, uid);
    const stored = this.getStorage<ExamResult[] | null>(examKey, null);
    if (stored !== null) {
      return stored;
    }
    return [];
  }

  getUserExamStats(userId?: string): { examsCompleted: number; averageScore: string } {
    const uid = userId || this.getActiveUserId();
    const exams = this.getUserExamResults(uid);
    if (exams.length === 0) {
      return { examsCompleted: 0, averageScore: '—' };
    }
    const avg = Math.round(exams.reduce((acc, e) => acc + e.percentage, 0) / exams.length);
    return {
      examsCompleted: exams.length,
      averageScore: `${avg}%`,
    };
  }

  // Activity & Analytics
  getRecentActivity(userId?: string): RecentActivityItem[] {
    const uid = userId || this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.ACTIVITY, uid);
    const stored = localStorage.getItem(key);
    if (stored !== null) {
      try {
        return JSON.parse(stored);
      } catch {
        return [];
      }
    }

    return [];
  }

  addActivity(item: Omit<RecentActivityItem, 'id' | 'timestamp'> & { timestamp?: string }): void {
    const uid = this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.ACTIVITY, uid);
    const list = this.getRecentActivity();
    const newItem: RecentActivityItem = {
      id: 'act_' + Date.now(),
      timestamp: item.timestamp || 'Just now',
      ...item,
    };
    this.setStorage(key, [newItem, ...list.slice(0, 15)]);
  }

  clearRecentActivity(userId?: string): void {
    const uid = userId || this.getActiveUserId();
    const key = this.getUserScopedKey(STORAGE_KEYS.ACTIVITY, uid);
    this.setStorage(key, []);
  }

  getAnalytics(userId?: string): AnalyticsData {
    const uid = userId || this.getActiveUserId();
    const notebooks = this.getNotebooks(uid);
    const exams = this.getUserExamResults(uid);

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
      studyProgress: studyProgress,
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
    const uid = this.requireActiveUserId();
    const formData = new FormData();
    formData.append('file', file);
    formData.append('notebookId', notebookId);
    formData.append('userId', uid);

    // 1. Initial stage indication
    if (onStatusUpdate) {
      onStatusUpdate({
        stage: 'Uploading document to server',
        progress: 10,
        message: 'Streaming file to backend storage...',
        status: 'UPLOADING',
      });
    }

    let uploadData: any = null;
    let lastError: ApiError | null = null;

    // Try backend upload with quick retry only on transient network/5xx errors
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) {
        throw new DOMException('Upload aborted by user', 'AbortError');
      }
      try {
        const uploadRes = await fetch('/api/documents/upload', {
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

    if (onStatusUpdate) {
      onStatusUpdate({
        stage: 'Document uploaded and queued',
        progress: 20,
        message: 'File stored securely. Starting extraction worker...',
        status: 'UPLOADED',
      });
    }

    // 2. Poll document processing status
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
              'Document processing timed out before completion. Please retry.',
              'TIMEOUT',
              true,
              504
            )
          );
          return;
        }

        try {
          const statusRes = await fetch(`/api/documents/${encodeURIComponent(documentId)}/status`, { signal });
          const contentType = statusRes.headers.get('content-type') || '';

          if (!statusRes.ok || !contentType.includes('application/json')) {
            consecutiveFailures++;
            const err = await this.parseErrorResponse(statusRes, 'Failed to read document processing status.');
            if (statusRes.status === 404 || !err.retryable || consecutiveFailures >= 5) {
              clearInterval(interval);
              reject(err);
            }
            return;
          }

          let data: any;
          try {
            data = await statusRes.json();
          } catch {
            consecutiveFailures++;
            if (consecutiveFailures >= 5) {
              clearInterval(interval);
              reject(new ApiError('Invalid status response from document processing server.', 'INVALID_RESPONSE', true));
            }
            return;
          }

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
              name: file.name,
              size:
                file.size < 1024 * 1024
                  ? `${(file.size / 1024).toFixed(1)} KB`
                  : `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
              pages: data.total_pages || 1,
              uploadDate: 'Just now',
              status: 'COMPLETED',
              extractedChunksCount: data.chunk_count || 0,
              currentStage: data.current_stage,
              progress: 100,
              message: data.message,
              metrics: data.metrics,
              previewSnippet: `Indexed ${data.chunk_count} vector chunks across ${data.total_pages} pages into persistent knowledge base.`,
            };

            this.appendDocumentToNotebook(notebookId, docItem);
            resolve({ documentId, document: docItem });
          } else if (data.status === 'FAILED') {
            clearInterval(interval);
            reject(
              new ApiError(
                data.error || data.message || `Document ingestion failed for "${file.name}".`,
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
      }, 350);
    });
  }

  appendDocumentToNotebook(notebookId: string, doc: DocumentItem): void {
    const notebooks = this.getNotebooks().map((nb) => {
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

    this.saveNotebooks(notebooks);
    const targetNb = notebooks.find((n) => n.id === notebookId);
    this.addActivity({
      type: 'document',
      title: `Indexed ${doc.name}`,
      subtitle: `${doc.pages} pages processed • ${doc.extractedChunksCount} vector embeddings stored`,
      notebookTitle: targetNb?.title || 'Course',
    });
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
    const uid = this.requireActiveUserId();
    let res: Response;
    try {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          notebookId,
          documentId,
          userId: uid,
          history,
        }),
      });
    } catch (err: any) {
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
    const uid = this.getActiveUserId();
    const userQuery = uid && uid !== 'guest' ? `?userId=${encodeURIComponent(uid)}` : '';
    try {
      await fetch(`/api/documents/${encodeURIComponent(documentId)}${userQuery}`, { method: 'DELETE' });
    } catch (e) {
      console.warn('Backend delete document failed:', e);
    }
    this.deleteDocument(notebookId, documentId);
  }

  async fetchDocumentChunks(documentId: string): Promise<any[]> {
    const uid = this.getActiveUserId();
    const userQuery = uid && uid !== 'guest' ? `?userId=${encodeURIComponent(uid)}` : '';
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/chunks${userQuery}`);
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

  clearAllLoginData(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.AUTH);
      localStorage.removeItem(STORAGE_KEYS.PROFILE);
      localStorage.removeItem(STORAGE_KEYS.USERS);
      localStorage.removeItem(STORAGE_KEYS.REMEMBER_EMAIL);
    } catch (e) {
      console.warn('Failed clearing login data:', e);
    }
  }

  async clearAllData(): Promise<void> {
    // 1. Call backend to clear documents, chunks, vectors, and physical storage
    try {
      await fetch('/api/documents/clear-all', { method: 'POST' });
    } catch (e) {
      console.warn('Backend clear-all endpoint error:', e);
    }

    // 2. Clear ALL browser local state keys including auth, profile, and users
    try {
      const theme = localStorage.getItem('study_ai_theme');
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('studyai_') || (k.startsWith('study_ai_') && k !== 'study_ai_theme'))) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
      if (theme) {
        localStorage.setItem('study_ai_theme', theme);
      }
      localStorage.setItem('studyai_zero_data_v3', 'purged');
    } catch (e) {
      console.warn('Failed clearing client storage:', e);
    }
  }
}

export const apiService = new ApiService();
