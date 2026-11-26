import express, { Response } from 'express';
import { ragService } from '../services/ragService';
import { vectorStore } from '../services/vectorStore';
import { db, isValidEntityId } from '../db/database';
import { AIServiceError } from '../services/aiClient';
import { AuthenticatedRequest, requireAuth } from '../middleware/authMiddleware';

export const chatRouter = express.Router();
chatRouter.use(requireAuth);

/**
 * POST /api/chat
 * Grounded RAG Question Answering Endpoint
 * Strictly scoped to the verified authenticated user (req.user.id) and selected notebookId.
 */
chatRouter.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { query, notebookId, documentId, history } = req.body || {};

    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'Query parameter is required and cannot be blank.' });
    }

    if (!isValidEntityId(notebookId)) {
      return res.status(400).json({ error: 'Valid notebookId is required for AI Tutor chat.' });
    }

    const nb = await db.getNotebook(notebookId.trim(), userId);
    if (!nb) {
      return res.status(404).json({ error: 'Selected notebook not found for your account.' });
    }

    const response = await ragService.answerQuestion({
      query: query.trim(),
      userId,
      notebookId: nb.id,
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
 * Provides overview of the knowledge base index for the authenticated user
 */
chatRouter.get('/stats', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const totalVectors = await vectorStore.getEntryCount(userId);
    const allDocs = await db.getAllDocuments(userId);
    const completedDocs = allDocs.filter((d) => d.status === 'COMPLETED');

    return res.json({
      totalVectors,
      totalDocuments: allDocs.length,
      completedDocuments: completedDocs.length,
      indexedPages: completedDocs.reduce((acc, d) => acc + (d.totalPages || 0), 0),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to fetch chat stats.' });
  }
});
