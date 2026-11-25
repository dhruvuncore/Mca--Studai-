import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { db, isValidEntityId } from '../db/database';
import { DocumentChunk, DocumentSummaryRecord, ChatSummaryRecord } from '../db/models';
import { pdfExtractor } from './pdfExtractor';
import {
  AIServiceError,
  GEMINI_TEXT_MODELS,
  classifyGeminiError,
  getGeminiClientOrThrow,
} from './aiClient';

export interface ChatMessageInput {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export class SummaryService {
  private modelCooldowns: Map<string, number> = new Map();
  private inFlightChatSummaries: Map<string, Promise<any>> = new Map();
  private inFlightDocSummaries: Map<string, Promise<any>> = new Map();

  private async callGeminiWithFallback(
    client: GoogleGenAI,
    prompt: string,
    systemInstruction: string | undefined,
    timeoutMs: number
  ): Promise<string> {
    const now = Date.now();
    let lastError: AIServiceError | null = null;
    let attempted = false;

    for (const modelName of GEMINI_TEXT_MODELS) {
      const cooldown = this.modelCooldowns.get(modelName) || 0;
      if (now < cooldown) continue;
      attempted = true;

      try {
        const config: Record<string, any> = {
          abortSignal: AbortSignal.timeout(timeoutMs),
        };
        if (systemInstruction) {
          config.systemInstruction = systemInstruction;
        }
        if (modelName !== 'gemini-4-hydrogen') {
          config.temperature = 0.2;
        }

        const response: any = await client.models.generateContent({
          model: modelName,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config,
        });

        const text = response?.text?.trim();
        if (text) {
          return text;
        }
      } catch (err: any) {
        const classified = classifyGeminiError(err);
        lastError = classified;
        if (classified.code === 'GEMINI_API_KEY_INVALID') {
          throw classified;
        }
        const duration = classified.code === 'GEMINI_RATE_LIMIT' ? 45000 : 15000;
        this.modelCooldowns.set(modelName, Date.now() + duration);
      }
    }

    if (lastError) {
      throw lastError;
    }
    if (!attempted) {
      throw new AIServiceError(
        'Gemini AI models are temporarily cooling down after recent rate limits or errors. Please retry shortly.',
        503,
        'GEMINI_RATE_LIMIT',
        true
      );
    }
    throw new AIServiceError(
      'Gemini returned an empty summary response. Please retry.',
      502,
      'GEMINI_UNAVAILABLE',
      true
    );
  }

  /**
   * Generates ONE comprehensive intelligent summary of the entire chat conversation
   * for the given notebook (Section A).
   */
  async generateChatSummary(options: {
    notebookId: string;
    userId: string;
    history: ChatMessageInput[];
    notebookTitle?: string;
    forceRegenerate?: boolean;
  }): Promise<{
    summary: string;
    generatedAt: string;
    messageCount: number;
    hasChat: boolean;
    fromCache: boolean;
  }> {
    const { notebookId, userId, history = [], notebookTitle = 'Course Notebook', forceRegenerate = false } = options;

    if (!isValidEntityId(notebookId) || !isValidEntityId(userId)) {
      throw new Error('Valid notebookId and userId are required to generate chat summary.');
    }

    const validHistory = history.filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0);

    if (validHistory.length === 0) {
      return {
        summary: `> **No Chat History Available**\n\nYou haven't started a conversation in **${notebookTitle}** yet. Ask questions in the AI Tutor chat workspace to build your study dialogue, and generate a comprehensive conversation summary anytime!`,
        generatedAt: new Date().toLocaleString(),
        messageCount: 0,
        hasChat: false,
        fromCache: false,
      };
    }

    // Check cache if not forcing regenerate
    if (!forceRegenerate) {
      const cached = db.getChatSummary(notebookId, userId);
      if (cached && cached.messageCount === validHistory.length) {
        return {
          summary: cached.summary,
          generatedAt: cached.generatedAt,
          messageCount: cached.messageCount,
          hasChat: true,
          fromCache: true,
        };
      }
    }

    // Prevent duplicate concurrent requests for the same notebook
    const lockKey = `${userId}:${notebookId}`;
    const existingPromise = this.inFlightChatSummaries.get(lockKey);
    if (existingPromise) {
      return existingPromise;
    }

    const task = (async () => {
      const client = getGeminiClientOrThrow();

      const transcript = validHistory
        .map((msg, idx) => {
          const speaker = msg.role === 'user' ? 'STUDENT QUESTION' : 'AI TUTOR EXPLANATION';
          return `[Turn ${idx + 1} - ${speaker}]:\n${msg.content.trim()}`;
        })
        .join('\n\n---\n\n');

      const systemInstruction =
        `You are an expert AI Academic Synthesizer. You are creating a Smart Summary of an entire study chat session between a student and an AI Tutor for the notebook "${notebookTitle}".\n\n` +
        `CORE REQUIREMENTS:\n` +
        `1. COMPREHENSIVE SYNTHESIS:\n` +
        `   - Read and synthesize the ENTIRE conversation history provided below (not just the latest turn).\n` +
        `   - Understand every question asked by the student and every explanation provided by the tutor.\n` +
        `   - Combine repeated or follow-up questions on the same subject into one clear, authoritative, unified explanation.\n` +
        `   - Do NOT write per-message or per-turn summaries. Produce ONE cohesive, deeply organized summary document.\n\n` +
        `2. ACADEMIC DEPTH & PRECISION:\n` +
        `   - Preserve all technical terms, definitions, mathematical formulas, algorithms, rules, schemas, and concrete examples discussed.\n` +
        `   - Highlight core principles, clarifications, and key takeaways.\n` +
        `   - Do NOT invent topics, facts, or discussions that never took place in this chat.\n\n` +
        `3. CLEAR STRUCTURED FORMATTING (Markdown):\n` +
        `   - Use clear markdown headers:\n` +
        `     # Chat Conversation Summary: ${notebookTitle}\n` +
        `     ## 1. Study Discussion Scope & Overview\n` +
        `     ## 2. Core Concepts & Topics Explored\n` +
        `     ## 3. Key Definitions, Rules & Formulations\n` +
        `     ## 4. Practical Examples & Walkthroughs\n` +
        `     ## 5. Clarifications & Key Findings\n` +
        `     ## 6. Key Takeaways\n` +
        `   - Use bullet points, bold key terms, and code blocks for schemas/formulas where appropriate.`;

      const prompt = `[FULL CONVERSATION HISTORY - ${validHistory.length} MESSAGES]\n\n${transcript}\n\nPlease generate the comprehensive Smart Chat Summary now:`;

      const summaryText = await this.callGeminiWithFallback(client, prompt, systemInstruction, 30000);

      const generatedAt = new Date().toLocaleString();
      const record: ChatSummaryRecord = {
        notebookId,
        userId,
        summary: summaryText,
        generatedAt,
        messageCount: validHistory.length,
        lastMessageId: `msg_${Date.now()}`,
      };

      db.saveChatSummary(record);

      return {
        summary: summaryText,
        generatedAt,
        messageCount: validHistory.length,
        hasChat: true,
        fromCache: false,
      };
    })();

    this.inFlightChatSummaries.set(lockKey, task);
    try {
      return await task;
    } finally {
      this.inFlightChatSummaries.delete(lockKey);
    }
  }

  /**
   * Generates a separate Smart Summary for an individual uploaded document (Section B).
   * Reads all available extracted pages/chunks without omitting sections.
   */
  async generateDocumentSummary(options: {
    documentId: string;
    notebookId: string;
    userId: string;
    forceRegenerate?: boolean;
  }): Promise<{
    summary: string;
    generatedAt: string;
    pageCount: number;
    fileName: string;
    fromCache: boolean;
    status: 'completed' | 'error';
    error?: string;
  }> {
    const { documentId, notebookId, userId, forceRegenerate = false } = options;

    if (!isValidEntityId(documentId) || !isValidEntityId(userId)) {
      throw new Error('Valid documentId and userId are required.');
    }

    const doc = db.getDocument(documentId);
    if (!doc) {
      return {
        summary: '> **Document Not Found**\n\nThe requested document record could not be found in the knowledge base.',
        generatedAt: new Date().toLocaleString(),
        pageCount: 0,
        fileName: 'Unknown Document',
        fromCache: false,
        status: 'error',
        error: 'Document not found in the knowledge base.',
      };
    }

    if (doc.userId !== userId || (notebookId && doc.notebookId !== notebookId)) {
      return {
        summary: '> **Access Denied**\n\nThis document does not belong to the selected notebook or user.',
        generatedAt: new Date().toLocaleString(),
        pageCount: 0,
        fileName: doc.originalFileName,
        fromCache: false,
        status: 'error',
        error: 'Document does not belong to the active notebook or user.',
      };
    }

    if (doc.status === 'FAILED') {
      return {
        summary: `> **Document Ingestion Failed**\n\nCould not extract content from **${doc.originalFileName}**. Error details: ${doc.error || 'File extraction failed'}. Please re-upload a clean copy.`,
        generatedAt: new Date().toLocaleString(),
        pageCount: doc.totalPages || 1,
        fileName: doc.originalFileName,
        fromCache: false,
        status: 'error',
        error: doc.error || 'Extraction failed',
      };
    }

    // Retrieve ALL chunks of this document
    let chunks = db.getDocumentChunks(documentId);

    // Check cache (invalidate if chunk count changed)
    if (!forceRegenerate) {
      const cached = db.getDocumentSummary(documentId);
      if (
        cached &&
        cached.summary &&
        cached.summary.trim().length > 50 &&
        (!cached.sourceChunkCount || chunks.length === 0 || cached.sourceChunkCount === chunks.length)
      ) {
        return {
          summary: cached.summary,
          generatedAt: cached.generatedAt,
          pageCount: cached.pageCount,
          fileName: cached.originalFileName,
          fromCache: true,
          status: 'completed',
        };
      }
    }

    // Prevent duplicate concurrent requests for the same document
    const lockKey = `${userId}:${documentId}`;
    const existingPromise = this.inFlightDocSummaries.get(lockKey);
    if (existingPromise) {
      return existingPromise;
    }

    const task = (async (): Promise<{
      summary: string;
      generatedAt: string;
      pageCount: number;
      fileName: string;
      fromCache: boolean;
      status: 'completed' | 'error';
      error?: string;
    }> => {
      // If chunks are empty, attempt direct extraction only if source file exists on disk
      if (chunks.length === 0 && doc.storagePath && fs.existsSync(doc.storagePath)) {
        try {
          const pages = await pdfExtractor.extractPages(doc.storagePath, doc.originalFileName);
          if (pages.length > 0) {
            chunks = pages.map((p, idx) => ({
              id: `${doc.id}_chk_${(idx + 1).toString().padStart(4, '0')}`,
              documentId: doc.id,
              userId: doc.userId,
              notebookId: doc.notebookId,
              chunkIndex: idx + 1,
              pageStart: p.pageNumber,
              pageEnd: p.pageNumber,
              section: `Page ${p.pageNumber}`,
              heading: `Section ${idx + 1}`,
              text: p.rawText,
              tokenEstimate: Math.ceil(p.rawText.length / 4),
              extractionMethod: p.extractionMethod,
              sourceDocName: doc.originalFileName,
            }));
          }
        } catch (extractErr) {
          console.warn('Fallback direct page extraction failed:', extractErr);
        }
      }

      if (chunks.length === 0) {
        return {
          summary: `> **No Readable Content Found**\n\n**${doc.originalFileName}** does not contain any extractable text. If this is an empty or unreadable file, please re-upload a valid document.`,
          generatedAt: new Date().toLocaleString(),
          pageCount: doc.totalPages || 1,
          fileName: doc.originalFileName,
          fromCache: false,
          status: 'error',
          error: 'No readable text extracted from this document.',
        };
      }

      const client = getGeminiClientOrThrow();
      const pageCount = doc.totalPages || Math.max(...chunks.map((c) => c.pageEnd || c.pageStart || 1));

      const summaryText = await this.generateDocumentSummaryWithGemini(
        client,
        doc.originalFileName,
        chunks,
        pageCount
      );

      const generatedAt = new Date().toLocaleString();
      const summaryRecord: DocumentSummaryRecord = {
        documentId,
        notebookId: doc.notebookId,
        userId: doc.userId,
        originalFileName: doc.originalFileName,
        summary: summaryText,
        pageCount,
        fileSize: doc.fileSize ? `${(doc.fileSize / 1024).toFixed(1)} KB` : undefined,
        generatedAt,
        sourceChunkCount: chunks.length,
      };

      db.saveDocumentSummary(summaryRecord);

      return {
        summary: summaryText,
        generatedAt,
        pageCount,
        fileName: doc.originalFileName,
        fromCache: false,
        status: 'completed',
      };
    })();

    this.inFlightDocSummaries.set(lockKey, task);
    try {
      return await task;
    } finally {
      this.inFlightDocSummaries.delete(lockKey);
    }
  }

  /**
   * Summarizes all chunks of a document with Gemini, handling long documents with multi-section batching.
   */
  private async generateDocumentSummaryWithGemini(
    client: GoogleGenAI,
    fileName: string,
    chunks: DocumentChunk[],
    pageCount: number
  ): Promise<string> {
    if (chunks.length > 25) {
      return this.multiSectionSummarizeWithGemini(client, fileName, chunks, pageCount);
    }

    const compiledText = chunks
      .map((c) => {
        const pageRange = c.pageEnd && c.pageEnd > c.pageStart ? `Pages ${c.pageStart}–${c.pageEnd}` : `Page ${c.pageStart}`;
        const heading = c.heading ? ` | ${c.heading}` : '';
        return `[SOURCE METADATA: ${pageRange}${heading}]\n${c.text.trim()}`;
      })
      .join('\n\n---\n\n');

    const systemInstruction =
      `You are an expert Academic Document Analyst. Your task is to generate a comprehensive, accurate Smart Summary for the uploaded course document "${fileName}".\n\n` +
      `STRICT REQUIREMENTS:\n` +
      `1. PROCESS THE ENTIRE DOCUMENT:\n` +
      `   - Synthesize all sections, concepts, definitions, and conclusions from the beginning to the end of the document.\n` +
      `   - NEVER combine content from other PDFs or other notebooks.\n` +
      `   - Preserve important technical terms, definitions, formulas, schemas, examples, and algorithmic steps.\n\n` +
      `2. PAGE CITATIONS & ACCURACY:\n` +
      `   - Include explicit page references wherever reliable page metadata is indicated (e.g. [Page 2], [Pages 4-6]).\n` +
      `   - Never invent or fabricate information that does not appear in the text.\n\n` +
      `3. CLEAR STRUCTURED MARKDOWN FORMATTING:\n` +
      `   - Structure your response using these headers:\n` +
      `     # Document Smart Summary: ${fileName}\n` +
      `     ## 1. Document Overview & Primary Subject Matter\n` +
      `     ## 2. Chapter & Section-by-Section Breakdown (with page citations)\n` +
      `     ## 3. Core Theoretical Principles & Concepts\n` +
      `     ## 4. Formal Definitions, Rules & Mathematical Notation\n` +
      `     ## 5. Illustrative Examples, Schemas & Case Studies\n` +
      `     ## 6. Key Takeaways\n` +
      `   - Use bold formatting, bullet points, numbered lists, and code blocks for schemas and algorithms.`;

    const prompt = `[COMPLETE EXTRACTED DOCUMENT CONTENT - ${chunks.length} SECTIONS, ${pageCount} PAGES]\n\n${compiledText}\n\nPlease generate the comprehensive Smart Summary for "${fileName}":`;

    return this.callGeminiWithFallback(client, prompt, systemInstruction, 35000);
  }

  /**
   * Multi-section hierarchical summarization for long documents (> 25 chunks)
   * without silently omitting any document sections.
   */
  private async multiSectionSummarizeWithGemini(
    client: GoogleGenAI,
    fileName: string,
    chunks: DocumentChunk[],
    pageCount: number
  ): Promise<string> {
    const sectionSize = 15;
    const sectionSummaries: string[] = [];

    for (let i = 0; i < chunks.length; i += sectionSize) {
      const slice = chunks.slice(i, i + sectionSize);
      const startPage = slice[0]?.pageStart || 1;
      const endPage = slice[slice.length - 1]?.pageEnd || slice[slice.length - 1]?.pageStart || startPage;

      const sliceText = slice
        .map((c) => `[Page ${c.pageStart}${c.pageEnd > c.pageStart ? `-${c.pageEnd}` : ''} | ${c.heading || ''}]\n${c.text}`)
        .join('\n\n');

      const sectionPrompt =
        `Summarize the following document excerpt from "${fileName}" (Pages ${startPage} to ${endPage}). ` +
        `Preserve all key concepts, technical definitions, formulas, and section topics with page citations [Pages ${startPage}-${endPage}]. Do not invent any facts not present in the text:\n\n${sliceText}`;

      const sectionSummary = await this.callGeminiWithFallback(client, sectionPrompt, undefined, 25000);
      sectionSummaries.push(`### Part ${Math.floor(i / sectionSize) + 1} (Pages ${startPage}–${endPage}):\n${sectionSummary}`);
    }

    const combinedSectionText = sectionSummaries.join('\n\n---\n\n');
    const finalSynthesisPrompt =
      `You are creating the unified, comprehensive Smart Summary for the long document "${fileName}" (${pageCount} total pages).\n` +
      `Here are the summaries of all sections covering the entire document:\n\n${combinedSectionText}\n\n` +
      `Synthesize these into ONE cohesive, deeply structured Smart Summary using these markdown headers:\n` +
      `# Document Smart Summary: ${fileName}\n` +
      `## 1. Document Overview & Primary Subject Matter\n` +
      `## 2. Comprehensive Chapter & Section-by-Section Breakdown\n` +
      `## 3. Core Theoretical Principles & Concepts\n` +
      `## 4. Formal Definitions, Rules & Mathematical Notation\n` +
      `## 5. Illustrative Examples, Schemas & Case Studies\n` +
      `## 6. Key Takeaways\n` +
      `Maintain all page citations (e.g. [Pages X-Y]) from the section summaries without inventing information.`;

    return this.callGeminiWithFallback(client, finalSynthesisPrompt, undefined, 35000);
  }
}

export const summaryService = new SummaryService();
