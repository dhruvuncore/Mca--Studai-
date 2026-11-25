import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { DocumentRecord, DocumentChunk, DocumentSummaryRecord, ChatSummaryRecord } from './models';

export function isValidEntityId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== 'undefined' &&
    trimmed !== 'null' &&
    trimmed !== 'NaN' &&
    !trimmed.startsWith('undefined_')
  );
}

class Database {
  private docsFile: string;
  private chunksFile: string;
  private summariesFile: string;
  private documents: Map<string, DocumentRecord> = new Map();
  private chunks: Map<string, DocumentChunk[]> = new Map(); // docId -> DocumentChunk[]
  private docSummaries: Map<string, DocumentSummaryRecord> = new Map(); // docId -> DocumentSummaryRecord
  private chatSummaries: Map<string, ChatSummaryRecord> = new Map(); // notebookId -> ChatSummaryRecord

  constructor() {
    this.docsFile = path.join(config.DB_DIR, 'documents.json');
    this.chunksFile = path.join(config.DB_DIR, 'chunks.json');
    this.summariesFile = path.join(config.DB_DIR, 'summaries.json');
    this.init();
  }

  private init() {
    try {
      if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
      if (!fs.existsSync(config.STORAGE_DIR)) fs.mkdirSync(config.STORAGE_DIR, { recursive: true });
      if (!fs.existsSync(config.VECTOR_DB_DIR)) fs.mkdirSync(config.VECTOR_DB_DIR, { recursive: true });
      if (!fs.existsSync(config.DB_DIR)) fs.mkdirSync(config.DB_DIR, { recursive: true });

      if (fs.existsSync(this.docsFile)) {
        const raw = fs.readFileSync(this.docsFile, 'utf-8');
        const list: DocumentRecord[] = JSON.parse(raw);
        if (Array.isArray(list)) {
          list.forEach((doc) => {
            if (
              doc &&
              isValidEntityId(doc.id) &&
              isValidEntityId(doc.userId) &&
              isValidEntityId(doc.notebookId)
            ) {
              this.documents.set(doc.id, doc);
            } else {
              console.warn('[Database] Skipped invalid document record on load:', doc?.originalFileName || doc);
            }
          });
        }
      }

      if (fs.existsSync(this.chunksFile)) {
        const raw = fs.readFileSync(this.chunksFile, 'utf-8');
        const map: Record<string, DocumentChunk[]> = JSON.parse(raw);
        if (map && typeof map === 'object') {
          Object.entries(map).forEach(([docId, chks]) => {
            if (!isValidEntityId(docId) || !Array.isArray(chks)) {
              console.warn('[Database] Skipped invalid chunks key on load:', docId);
              return;
            }
            const validChunks = chks.filter(
              (c) =>
                c &&
                isValidEntityId(c.id) &&
                isValidEntityId(c.documentId) &&
                c.documentId === docId &&
                isValidEntityId(c.userId) &&
                isValidEntityId(c.notebookId)
            );
            if (validChunks.length > 0) {
              this.chunks.set(docId, validChunks);
            }
          });
        }
      }

      if (fs.existsSync(this.summariesFile)) {
        const raw = fs.readFileSync(this.summariesFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.docSummaries && typeof parsed.docSummaries === 'object') {
          Object.entries(parsed.docSummaries).forEach(([id, rec]) => {
            const summary = rec as DocumentSummaryRecord;
            if (
              isValidEntityId(id) &&
              summary &&
              isValidEntityId(summary.documentId || id) &&
              isValidEntityId(summary.notebookId)
            ) {
              this.docSummaries.set(id, { ...summary, documentId: summary.documentId || id });
            } else {
              console.warn('[Database] Skipped invalid document summary on load:', id);
            }
          });
        }
        if (parsed.chatSummaries && typeof parsed.chatSummaries === 'object') {
          Object.entries(parsed.chatSummaries).forEach(([nbId, rec]) => {
            const summary = rec as ChatSummaryRecord;
            if (isValidEntityId(nbId) && summary && isValidEntityId(summary.notebookId || nbId)) {
              this.chatSummaries.set(nbId, { ...summary, notebookId: summary.notebookId || nbId });
            } else {
              console.warn('[Database] Skipped invalid chat summary on load:', nbId);
            }
          });
        }
      }
    } catch (err) {
      console.error('Database init error:', err);
    }
  }

  private saveDocuments() {
    try {
      const list = Array.from(this.documents.values());
      fs.writeFileSync(this.docsFile, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save documents to disk:', err);
    }
  }

  private saveChunks() {
    try {
      const obj: Record<string, DocumentChunk[]> = {};
      this.chunks.forEach((val, key) => {
        if (isValidEntityId(key)) {
          obj[key] = val;
        }
      });
      fs.writeFileSync(this.chunksFile, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save chunks to disk:', err);
    }
  }

  private saveSummaries() {
    try {
      const docObj: Record<string, DocumentSummaryRecord> = {};
      this.docSummaries.forEach((val, key) => {
        if (isValidEntityId(key)) {
          docObj[key] = val;
        }
      });
      const chatObj: Record<string, ChatSummaryRecord> = {};
      this.chatSummaries.forEach((val, key) => {
        if (isValidEntityId(key)) {
          chatObj[key] = val;
        }
      });
      fs.writeFileSync(
        this.summariesFile,
        JSON.stringify({ docSummaries: docObj, chatSummaries: chatObj }, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('Failed to save summaries to disk:', err);
    }
  }

  // Document operations
  createDocument(doc: Partial<DocumentRecord> & { originalFileName: string; storagePath: string }): DocumentRecord {
    const id = doc.id || `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    if (!isValidEntityId(id)) {
      throw new Error('Cannot create document without a valid document ID.');
    }
    if (!isValidEntityId(doc.userId)) {
      throw new Error('Cannot create document without a valid userId.');
    }
    if (!isValidEntityId(doc.notebookId)) {
      throw new Error('Cannot create document without a valid notebookId.');
    }

    const fullDoc: DocumentRecord = {
      id: id.trim(),
      userId: doc.userId.trim(),
      notebookId: doc.notebookId.trim(),
      originalFileName: doc.originalFileName,
      storageFileName: doc.storageFileName || path.basename(doc.storagePath),
      storagePath: doc.storagePath,
      mimeType: doc.mimeType || 'application/pdf',
      fileSize: doc.fileSize || 0,
      uploadDate: doc.uploadDate || new Date().toISOString(),
      status: doc.status || 'UPLOADED',
      currentStage: doc.currentStage || 'Uploaded',
      progress: doc.progress || 20,
      message: doc.message || 'Ready for processing',
      processedPages: doc.processedPages || 0,
      totalPages: doc.totalPages || 1,
      chunkCount: doc.chunkCount || 0,
      error: doc.error || null,
      metrics: doc.metrics,
    };
    this.documents.set(fullDoc.id, fullDoc);
    this.saveDocuments();
    return fullDoc;
  }

  getDocument(id: string): DocumentRecord | undefined {
    if (!isValidEntityId(id)) return undefined;
    return this.documents.get(id);
  }

  getAllDocuments(userId?: string, notebookId?: string): DocumentRecord[] {
    let list = Array.from(this.documents.values());
    if (userId) {
      list = list.filter((d) => d.userId === userId);
    }
    if (notebookId) {
      list = list.filter((d) => d.notebookId === notebookId);
    }
    return list.sort((a, b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime());
  }

  updateDocument(id: string, updates: Partial<DocumentRecord>): DocumentRecord | undefined {
    if (!isValidEntityId(id)) return undefined;
    const existing = this.documents.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...updates, id: existing.id };
    this.documents.set(existing.id, updated);
    this.saveDocuments();
    return updated;
  }

  deleteDocument(id: string): boolean {
    if (!isValidEntityId(id)) return false;
    const doc = this.documents.get(id);
    if (!doc) return false;

    // Remove original file
    try {
      if (doc.storagePath && fs.existsSync(doc.storagePath)) {
        fs.unlinkSync(doc.storagePath);
      }
    } catch (e) {
      console.warn('Could not remove file on disk:', e);
    }

    this.documents.delete(id);
    this.chunks.delete(id);
    this.docSummaries.delete(id);
    this.saveDocuments();
    this.saveChunks();
    this.saveSummaries();
    return true;
  }

  // Chunks operations
  saveDocumentChunks(documentId: string, chunks: DocumentChunk[]) {
    if (!isValidEntityId(documentId)) {
      throw new Error('Cannot save chunks without a valid documentId.');
    }
    const sanitized = chunks.filter(
      (c) =>
        c &&
        isValidEntityId(c.id) &&
        isValidEntityId(c.documentId) &&
        c.documentId === documentId &&
        isValidEntityId(c.userId) &&
        isValidEntityId(c.notebookId)
    );
    if (sanitized.length !== chunks.length) {
      throw new Error('One or more document chunks have invalid IDs or metadata.');
    }
    this.chunks.set(documentId, sanitized);
    this.saveChunks();
  }

  getDocumentChunks(documentId: string): DocumentChunk[] {
    if (!isValidEntityId(documentId)) return [];
    return this.chunks.get(documentId) || [];
  }

  getAllChunksForUser(userId: string): DocumentChunk[] {
    if (!isValidEntityId(userId)) return [];
    const res: DocumentChunk[] = [];
    this.chunks.forEach((chunkList) => {
      chunkList.forEach((c) => {
        if (c.userId === userId) res.push(c);
      });
    });
    return res;
  }

  // Summary operations (Requirements #1, #2, #4)
  saveDocumentSummary(summary: DocumentSummaryRecord): DocumentSummaryRecord {
    const docId = summary.documentId || (summary as any).id;
    if (!isValidEntityId(docId)) {
      throw new Error('Cannot save document summary without a valid documentId.');
    }
    if (!isValidEntityId(summary.notebookId)) {
      throw new Error('Cannot save document summary without a valid notebookId.');
    }
    const record: DocumentSummaryRecord = { ...summary, documentId: docId.trim() };
    this.docSummaries.set(record.documentId, record);
    this.saveSummaries();
    return record;
  }

  getDocumentSummary(documentId: string): DocumentSummaryRecord | undefined {
    if (!isValidEntityId(documentId)) return undefined;
    return this.docSummaries.get(documentId);
  }

  getAllDocumentSummaries(notebookId: string, userId?: string): DocumentSummaryRecord[] {
    if (!isValidEntityId(notebookId)) return [];
    const res: DocumentSummaryRecord[] = [];
    this.docSummaries.forEach((sum) => {
      if (sum.notebookId !== notebookId) return;
      if (userId) {
        if (sum.userId && sum.userId !== userId) return;
        const doc = this.documents.get(sum.documentId);
        if (doc && doc.userId !== userId) return;
      }
      res.push(sum);
    });
    return res;
  }

  deleteDocumentSummary(documentId: string): boolean {
    if (!isValidEntityId(documentId)) return false;
    const deleted = this.docSummaries.delete(documentId);
    if (deleted) {
      this.saveSummaries();
    }
    return deleted;
  }

  saveChatSummary(summary: ChatSummaryRecord): ChatSummaryRecord {
    if (!isValidEntityId(summary.notebookId)) {
      throw new Error('Cannot save chat summary without a valid notebookId.');
    }
    if (!isValidEntityId(summary.userId)) {
      throw new Error('Cannot save chat summary without a valid userId.');
    }
    this.chatSummaries.set(summary.notebookId, summary);
    this.saveSummaries();
    return summary;
  }

  getChatSummary(notebookId: string, userId?: string): ChatSummaryRecord | undefined {
    if (!isValidEntityId(notebookId)) return undefined;
    const summary = this.chatSummaries.get(notebookId);
    if (!summary) return undefined;
    if (userId && summary.userId && summary.userId !== userId) {
      return undefined;
    }
    return summary;
  }

  clearChatSummary(notebookId: string): boolean {
    if (!isValidEntityId(notebookId)) return false;
    const deleted = this.chatSummaries.delete(notebookId);
    if (deleted) {
      this.saveSummaries();
    }
    return deleted;
  }

  clearAll() {
    this.documents.clear();
    this.chunks.clear();
    this.docSummaries.clear();
    this.chatSummaries.clear();
    this.saveDocuments();
    this.saveChunks();
    this.saveSummaries();
  }
}

export const db = new Database();
