import express, { Request, Response } from 'express';
import { getQStashReceiver } from '../queue/jobQueueService';
import { documentProcessor } from '../queue/documentProcessor';
import { extractBearerToken, requireAuth, AuthenticatedRequest } from '../middleware/authMiddleware';
import { db, isValidEntityId } from '../db/database';

export const jobsRouter = express.Router();

/**
 * POST /api/jobs/process-document
 * Background ingestion worker endpoint triggered by Upstash QStash (signed webhook)
 * or authenticated owner retry trigger.
 */
jobsRouter.post('/process-document', async (req: Request, res: Response) => {
  try {
    const upstashSignature = req.headers['upstash-signature'] as string | undefined;
    const receiver = getQStashReceiver();

    if (upstashSignature && receiver) {
      const rawBody = (req as any).rawBody || JSON.stringify(req.body || {});
      const isValid = await receiver
        .verify({
          signature: upstashSignature,
          body: rawBody,
        })
        .catch(() => false);

      if (!isValid) {
        return res.status(401).json({ error: 'Invalid QStash webhook signature.' });
      }
    } else {
      // Fallback: require verified user session if not invoked via valid QStash signature
      const bearer = extractBearerToken(req.headers.authorization);
      if (!bearer) {
        return res.status(401).json({
          error: 'Unauthorized job execution trigger. Missing QStash signature or user authorization.',
        });
      }

      let authorized = false;
      await requireAuth(req as AuthenticatedRequest, res, () => {
        authorized = true;
      });
      if (!authorized) {
        return;
      }

      const authUserId = (req as AuthenticatedRequest).user!.id;
      const docId = req.body?.documentId;
      if (!isValidEntityId(docId)) {
        return res.status(400).json({ error: 'Valid documentId is required.' });
      }
      const doc = await db.getDocument(docId, authUserId);
      if (!doc) {
        return res.status(404).json({ error: 'Document not found for this user.' });
      }
    }

    const { documentId } = req.body || {};
    if (!isValidEntityId(documentId)) {
      return res.status(400).json({ error: 'Valid documentId is required.' });
    }

    const result = await documentProcessor.processDocument(documentId);
    return res.json({
      success: result.processed,
      documentId,
      status: result.status,
    });
  } catch (err: any) {
    console.error('[JobsRoute] Document job processing failed:', err);
    return res.status(500).json({
      error: err?.message || 'Document processing job failed.',
    });
  }
});
