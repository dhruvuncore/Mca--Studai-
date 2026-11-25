import express, { Request, Response } from 'express';
import { ragService } from '../services/ragService';
import { vectorStore } from '../services/vectorStore';
import { db, isValidEntityId } from '../db/database';
import { AIServiceError } from '../services/aiClient';

export const chatRouter = express.Router();

/**
 * POST /api/chat
 * Grounded RAG Question Answering Endpoint
 * Strictly scoped to the authenticated userId and selected notebookId.
 */
chatRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { query, userId, notebookId, documentId, history } = req.body;

    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'Query parameter is required and cannot be blank.' });
    }

    if (!isValidEntityId(userId) || userId === 'student_demo' || userId === 'guest') {
      return res.status(400).json({ error: 'Authenticated userId is required for AI Tutor chat.' });
    }

    if (!isValidEntityId(notebookId)) {
      return res.status(400).json({ error: 'Valid notebookId is required for AI Tutor chat.' });
    }

    const response = await ragService.answerQuestion({
      query: query.trim(),
      userId: userId.trim(),
      notebookId: notebookId.trim(),
      documentId: isValidEntityId(documentId) ? documentId.trim() : undefined,
      history: Array.isArray(history) ? history : undefined,
    });

    return res.json({
      success: true,
      answer: response.answer,
      isGrounded: response.isGrounded,
      sources: response.sources,
      retrievalScore: response.retrievalScore,
      documentId: response.documentId,
      insufficientInfo: response.insufficientInfo || false,
    });
  } catch (err: any) {
    console.error('Chat RAG endpoint error:', err);
    if (err instanceof AIServiceError) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
    }
    return res.status(500).json({
      error: err?.message || 'An error occurred while answering your question.',
      retryable: true,
    });
  }
});

/**
 * GET /api/chat/stats
 * Provides overview of the knowledge base index
 */
chatRouter.get('/stats', (req: Request, res: Response) => {
  const userId = req.query.userId as string | undefined;
  const totalVectors = vectorStore.getEntryCount();
  const allDocs = db.getAllDocuments(userId);
  const completedDocs = allDocs.filter((d) => d.status === 'COMPLETED');

  return res.json({
    totalVectors,
    totalDocuments: allDocs.length,
    completedDocuments: completedDocs.length,
    indexedPages: completedDocs.reduce((acc, d) => acc + (d.totalPages || 0), 0),
  });
});
