import express, { Response } from 'express';
import { summaryService } from '../services/summaryService';
import { db, isValidEntityId } from '../db/database';
import { AIServiceError } from '../services/aiClient';
import { AuthenticatedRequest, requireAuth } from '../middleware/authMiddleware';

export const summaryRouter = express.Router();
summaryRouter.use(requireAuth);

/**
 * POST /api/summary/chat
 * Generates or regenerates ONE comprehensive summary of the entire chat conversation
 * for the given notebook owned by the authenticated user.
 */
summaryRouter.post('/chat', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      notebookId,
      history = [],
      notebookTitle = 'Course Notebook',
      forceRegenerate = false,
    } = req.body || {};

    if (!isValidEntityId(notebookId)) {
      return res.status(400).json({ error: 'Valid notebookId is required.' });
    }

    const nb = await db.getNotebook(notebookId.trim(), userId);
    if (!nb) {
      return res.status(404).json({ error: 'Selected notebook not found for your account.' });
    }

    const result = await summaryService.generateChatSummary({
      notebookId: nb.id,
      userId,
      history,
      notebookTitle: notebookTitle || nb.title,
      forceRegenerate: Boolean(forceRegenerate),
    });

    return res.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('Chat summary generation error:', err);
    if (err instanceof AIServiceError) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
    }
    return res.status(500).json({
      error: err?.message || 'Failed to generate chat summary.',
      retryable: true,
    });
  }
});

/**
 * GET /api/summary/chat/:notebookId
 */
summaryRouter.get('/chat/:notebookId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { notebookId } = req.params;
    const cached = await db.getChatSummary(notebookId, userId);

    if (!cached) {
      return res.json({
        hasSummary: false,
        summary: null,
      });
    }

    return res.json({
      hasSummary: true,
      summary: cached.summary,
      generatedAt: cached.generatedAt,
      messageCount: cached.messageCount,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to fetch chat summary.' });
  }
});

/**
 * POST /api/summary/document
 * Generates or regenerates an individual Smart Summary for a single uploaded document.
 */
summaryRouter.post('/document', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      documentId,
      notebookId,
      forceRegenerate = false,
    } = req.body || {};

    if (!isValidEntityId(documentId)) {
      return res.status(400).json({ error: 'Valid documentId is required.' });
    }

    const result = await summaryService.generateDocumentSummary({
      documentId: documentId.trim(),
      notebookId: isValidEntityId(notebookId) ? notebookId.trim() : '',
      userId,
      forceRegenerate: Boolean(forceRegenerate),
    });

    return res.json({
      success: result.status === 'completed',
      ...result,
    });
  } catch (err: any) {
    console.error('Document summary generation error:', err);
    if (err instanceof AIServiceError) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
    }
    return res.status(500).json({
      error: err?.message || 'Failed to generate document summary.',
      retryable: true,
    });
  }
});

/**
 * GET /api/summary/document/:documentId
 */
summaryRouter.get('/document/:documentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { documentId } = req.params;
    const cached = await db.getDocumentSummary(documentId, userId);

    if (!cached) {
      return res.json({
        hasSummary: false,
        summary: null,
      });
    }

    return res.json({
      hasSummary: true,
      summary: cached.summary,
      generatedAt: cached.generatedAt,
      pageCount: cached.pageCount,
      fileName: cached.originalFileName,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to fetch document summary.' });
  }
});

/**
 * GET /api/summary/notebook/:notebookId
 */
summaryRouter.get('/notebook/:notebookId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { notebookId } = req.params;
    const chatSummary = (await db.getChatSummary(notebookId, userId)) || null;
    const documentSummaries = await db.getAllDocumentSummaries(notebookId, userId);

    return res.json({
      notebookId,
      chatSummary,
      documentSummaries,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to fetch notebook summaries.' });
  }
});
