export type DocumentStatus =
  | 'UPLOADING'
  | 'UPLOADED'
  | 'PROCESSING'
  | 'EXTRACTING'
  | 'OCR'
  | 'CLEANING'
  | 'CHUNKING'
  | 'EMBEDDING'
  | 'INDEXING'
  | 'COMPLETED'
  | 'FAILED';

export interface DocumentMetrics {
  fileSize: number;
  pageCount: number;
  extractionDurationMs: number;
  ocrPagesCount: number;
  extractedChars: number;
  chunkCount: number;
  skippedChunks: number;
  embeddingCount: number;
  indexingDurationMs: number;
  totalDurationMs: number;
}

export interface UserProfileRecord {
  id: string;
  email: string;
  name: string;
  avatar: string;
  degree: string;
  semester: string;
  university: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotebookRecord {
  id: string;
  userId: string;
  title: string;
  code: string;
  description: string;
  iconName: string;
  accentColor: string;
  progress: number;
  lastStudied: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DocumentRecord {
  id: string;
  userId: string;
  notebookId: string;
  originalFileName: string;
  storageFileName: string;
  storagePath: string;
  mimeType: string;
  fileSize: number;
  fileHash?: string;
  uploadDate: string;
  status: DocumentStatus;
  currentStage: string;
  progress: number;
  message: string;
  processedPages: number;
  totalPages: number;
  chunkCount: number;
  error: string | null;
  metrics?: DocumentMetrics;
}

export interface ExtractedPage {
  pageNumber: number;
  rawText: string;
  charCount: number;
  extractionMethod: 'text' | 'ocr';
}

export interface CleanedPage {
  pageNumber: number;
  cleanedText: string;
  extractionMethod: 'text' | 'ocr';
  headings: string[];
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  userId: string;
  notebookId: string;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  section: string;
  heading: string;
  text: string;
  tokenEstimate: number;
  extractionMethod: 'text' | 'ocr';
  sourceDocName: string;
}

export interface VectorEntry {
  id: string;
  documentId: string;
  userId: string;
  notebookId: string;
  vector: number[];
  text: string;
  metadata: {
    pageStart: number;
    pageEnd: number;
    section: string;
    heading: string;
    extractionMethod: 'text' | 'ocr';
    sourceDocName: string;
  };
}

export interface RetrievalResult {
  chunk: DocumentChunk;
  score: number;
}

export interface GroundedCitation {
  docName: string;
  pageStart: number;
  pageEnd: number;
  section: string;
  snippet: string;
  score: number;
}

export interface RAGAnswerResponse {
  answer: string;
  isGrounded: boolean;
  sources: GroundedCitation[];
  retrievalScore: number;
  documentId?: string;
  insufficientInfo?: boolean;
}

export interface DocumentSummaryRecord {
  documentId: string;
  notebookId: string;
  userId?: string;
  originalFileName: string;
  summary: string;
  pageCount: number;
  fileSize?: string;
  generatedAt: string;
  sourceChunkCount?: number;
}

export interface ChatSummaryRecord {
  notebookId: string;
  userId: string;
  summary: string;
  generatedAt: string;
  messageCount: number;
  lastMessageId?: string;
}

export interface ChatMessageRecord {
  id: string;
  userId: string;
  notebookId: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: string;
  sourceReferences?: Array<{
    docName: string;
    page: number;
    pageEnd?: number;
    section?: string;
    snippet: string;
    score?: number;
  }>;
  isGrounded?: boolean;
  retrievalScore?: number;
  insufficientInfo?: boolean;
}

export type ProcessingJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ProcessingJobRecord {
  id: string;
  documentId: string;
  userId: string;
  notebookId: string;
  status: ProcessingJobStatus;
  provider: 'qstash' | 'inline' | 'local';
  qstashMessageId?: string | null;
  attempts: number;
  maxAttempts: number;
  lastError?: string | null;
  lockedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ExamResultRecord {
  examId: string;
  userId: string;
  notebookId: string;
  notebookTitle: string;
  totalQuestions: number;
  correctCount: number;
  incorrectCount: number;
  skippedCount: number;
  percentage: number;
  timeTakenSeconds: number;
  topicPerformance: any[];
  strongTopics: string[];
  weakTopics: string[];
  recommendation: string;
  reviewQuestions: any[];
  createdAt?: string;
}

export interface RecentActivityRecord {
  id: string;
  userId: string;
  type: 'exam' | 'note' | 'document' | 'chat';
  title: string;
  subtitle: string;
  timestamp: string;
  score?: string;
  notebookTitle: string;
  createdAt?: string;
}
