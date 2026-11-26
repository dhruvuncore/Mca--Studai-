import { config } from '../config';
import { DocumentChunk, RetrievalResult } from '../db/models';
import { db, isValidEntityId } from '../db/database';
import { formatVectorLiteral, pgQuery } from '../db/supabaseClient';

export interface SearchOptions {
  userId: string;
  documentId?: string;
  notebookId?: string;
  queryText?: string;
  topK?: number;
  threshold?: number;
}

export class VectorStore {
  /**
   * Idempotently upsert chunks with their 128-dim embeddings into PostgreSQL + pgvector
   * inside a single ACID transaction.
   */
  async upsertChunks(chunks: DocumentChunk[], vectors: number[][]): Promise<void> {
    if (chunks.length === 0) return;
    const { documentId, userId, notebookId } = chunks[0];
    await db.saveDocumentChunksAndVectors(documentId, userId, notebookId, chunks, vectors);
  }

  /**
   * Complete vector cleanup when a document is deleted or reprocessed.
   */
  async deleteByDocumentId(documentId: string, userId?: string): Promise<number> {
    return db.deleteVectorsByDocumentId(documentId, userId);
  }

  /**
   * Hybrid similarity search combining pgvector dense cosine similarity (65%)
   * and lexical keyword overlap (35%) with section & heading boosting.
   * Strictly scoped to the authenticated userId and notebookId (and optional documentId).
   * NEVER falls back to documents from other notebooks or other users.
   */
  async similaritySearch(queryVector: number[], options: SearchOptions): Promise<RetrievalResult[]> {
    const {
      userId,
      documentId,
      notebookId,
      queryText = '',
      topK = config.TOP_K,
      threshold = config.SIMILARITY_THRESHOLD,
    } = options;

    if (!isValidEntityId(userId) || (!isValidEntityId(notebookId) && !isValidEntityId(documentId))) {
      return [];
    }

    // Resolve notebookId if only documentId was provided
    let effectiveNotebookId = notebookId;
    if (!effectiveNotebookId && documentId) {
      const doc = await db.getDocument(documentId, userId);
      if (!doc) return [];
      effectiveNotebookId = doc.notebookId;
    }

    if (!effectiveNotebookId) {
      return [];
    }

    const vecLiteral = formatVectorLiteral(queryVector);
    const fetchLimit = Math.max(topK * 5, 25);

    const res = await pgQuery<{
      chunk_id: string;
      document_id: string;
      user_id: string;
      notebook_id: string;
      chunk_index: number;
      page_start: number;
      page_end: number;
      section: string;
      heading: string;
      text: string;
      token_estimate: number;
      extraction_method: string;
      source_doc_name: string;
      cosine_similarity: number;
    }>(
      `SELECT * FROM public.match_document_embeddings($1::uuid, $2::text, $3::text, $4::vector, $5::int)`,
      [userId, effectiveNotebookId, documentId || null, vecLiteral, fetchLimit]
    );

    if (res.rows.length === 0) {
      return [];
    }

    // Pre-process query keywords for lexical scoring
    const stopWords = new Set([
      'a', 'an', 'the', 'is', 'are', 'was', 'were', 'what', 'which', 'who', 'how', 'why',
      'when', 'where', 'can', 'you', 'give', 'me', 'tell', 'about', 'and', 'or', 'in', 'on',
      'at', 'to', 'for', 'of', 'with', 'by', 'from', 'explain', 'describe', 'define',
    ]);
    const queryTokens = (queryText.toLowerCase().match(/[a-z0-9_#$+-]+/g) || []).filter(
      (w) => w.length > 1 && !stopWords.has(w)
    );

    const candidates: Array<{ chunk: DocumentChunk; score: number }> = [];

    for (const row of res.rows) {
      // Double-verify isolation boundaries
      if (row.user_id !== userId || row.notebook_id !== effectiveNotebookId) {
        continue;
      }

      const rawCosine = Number.isFinite(row.cosine_similarity) ? row.cosine_similarity : 0;
      const semanticScore = Math.max(0, Math.min(1, (rawCosine + 1) / 2));

      let lexicalScore = 0;
      if (queryTokens.length > 0) {
        const textLower = (row.text || '').toLowerCase();
        const headingLower = (row.heading || '').toLowerCase();
        const sectionLower = (row.section || '').toLowerCase();

        let matchedTokens = 0;
        let headingBonus = 0;

        for (const token of queryTokens) {
          if (textLower.includes(token)) {
            matchedTokens++;
          }
          if (headingLower.includes(token) || sectionLower.includes(token)) {
            headingBonus += 0.2;
          }
        }

        const tokenOverlapRatio = matchedTokens / queryTokens.length;
        lexicalScore = Math.min(1, tokenOverlapRatio + Math.min(0.3, headingBonus));

        if (queryText.length > 4 && textLower.includes(queryText.toLowerCase())) {
          lexicalScore = Math.min(1, lexicalScore + 0.25);
        }
      }

      const finalScore =
        queryTokens.length > 0 ? 0.65 * semanticScore + 0.35 * lexicalScore : semanticScore;

      candidates.push({
        chunk: {
          id: row.chunk_id,
          documentId: row.document_id,
          userId: row.user_id,
          notebookId: row.notebook_id,
          chunkIndex: Number(row.chunk_index || 0),
          pageStart: Number(row.page_start || 1),
          pageEnd: Number(row.page_end || 1),
          section: row.section || '',
          heading: row.heading || '',
          text: row.text,
          tokenEstimate: Number(row.token_estimate || Math.ceil((row.text || '').length / 4)),
          extractionMethod: row.extraction_method === 'ocr' ? 'ocr' : 'text',
          sourceDocName: row.source_doc_name,
        },
        score: finalScore,
      });
    }

    if (candidates.length === 0) {
      return [];
    }

    candidates.sort((a, b) => b.score - a.score);
    const filtered = candidates.filter((c) => c.score >= threshold);
    const topResults = (
      filtered.length > 0 ? filtered : candidates.slice(0, Math.min(topK, candidates.length))
    ).slice(0, topK);

    return topResults.map((c) => ({
      chunk: c.chunk,
      score: Math.round(c.score * 100) / 100,
    }));
  }

  async getEntryCount(userId: string): Promise<number> {
    return db.getVectorCountForUser(userId);
  }
}

export const vectorStore = new VectorStore();
