import express, { Request, Response } from 'express';
import { summaryService } from '../services/summaryService';
import { db, isValidEntityId } from '../db/database';
import { AIServiceError } from '../services/aiClient';

export const summaryRouter = express.Router();

/**
 * POST /api/summary/chat
 * Generates or regenerates ONE comprehensive intelligent summary of the entire chat conversation
 * for the given notebook (Section A).
 */
summaryRouter.post('/chat', async (req: Request, res: Response) => {
  try {
    const {
      notebookId,
      userId,
      history = [],
      notebookTitle = 'Course Notebook',
      forceRegenerate = false,
    } = req.body;

    if (!isValidEntityId(notebookId)) {
      return res.status(400).json({ error: 'Valid notebookId is required.' });
    }

    if (!isValidEntityId(userId) || userId === 'student_demo' || userId === 'guest') {
      return res.status(400).json({ error: 'Authenticated userId is required.' });
    }

    const result = await summaryService.generateChatSummary({
      notebookId: notebookId.trim(),
      userId: userId.trim(),
      history,
      notebookTitle,
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
 * Fetches previously generated chat summary for the given notebook.
 */
summaryRouter.get('/chat/:notebookId', (req: Request, res: Response) => {
  const { notebookId } = req.params;
  const userId = req.query.userId as string | undefined;
  const cached = db.getChatSummary(notebookId, userId);

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
});

/**
 * POST /api/summary/document
 * Generates or regenerates an individual Smart Summary for a single uploaded PDF (Section B).
 */
summaryRouter.post('/document', async (req: Request, res: Response) => {
  try {
    const {
      documentId,
      notebookId,
      userId,
      forceRegenerate = false,
    } = req.body;

    if (!isValidEntityId(documentId)) {
      return res.status(400).json({ error: 'Valid documentId is required.' });
    }

    if (!isValidEntityId(userId) || userId === 'student_demo' || userId === 'guest') {
      return res.status(400).json({ error: 'Authenticated userId is required.' });
    }

    const result = await summaryService.generateDocumentSummary({
      documentId: documentId.trim(),
      notebookId: isValidEntityId(notebookId) ? notebookId.trim() : '',
      userId: userId.trim(),
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
 * Fetches previously generated summary for a single document.
 */
summaryRouter.get('/document/:documentId', (req: Request, res: Response) => {
  const { documentId } = req.params;
  const userId = req.query.userId as string | undefined;
  const cached = db.getDocumentSummary(documentId);

  if (!cached || (userId && cached.userId && cached.userId !== userId)) {
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
});

/**
 * GET /api/summary/notebook/:notebookId
 * Fetches all summaries (chat + all documents) for the given notebook.
 */
summaryRouter.get('/notebook/:notebookId', (req: Request, res: Response) => {
  const { notebookId } = req.params;
  const userId = req.query.userId as string | undefined;
  const chatSummary = db.getChatSummary(notebookId, userId) || null;
  const documentSummaries = db.getAllDocumentSummaries(notebookId, userId);

  return res.json({
    notebookId,
    chatSummary,
    documentSummaries,
  });
});
