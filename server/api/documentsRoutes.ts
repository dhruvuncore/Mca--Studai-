import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { db, isValidEntityId } from '../db/database';
import { jobQueueService } from '../queue/jobQueueService';
import { storageService } from '../services/storageService';
import { vectorStore } from '../services/vectorStore';
import { DocumentRecord } from '../db/models';
import { AuthenticatedRequest, requireAuth } from '../middleware/authMiddleware';

export const documentsRouter = express.Router();
documentsRouter.use(requireAuth);

// Memory storage for direct streaming to private Supabase Storage
const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const isExtensionValid = config.ALLOWED_EXTENSIONS.includes(ext);
  const isMimeValid =
    !file.mimetype ||
    file.mimetype === 'application/octet-stream' ||
    config.ALLOWED_MIME_TYPES.includes(file.mimetype) ||
    file.mimetype === 'application/pdf' ||
    file.mimetype.startsWith('text/') ||
    file.mimetype.startsWith('image/') ||
    file.mimetype === 'application/msword' ||
    file.mimetype.includes('wordprocessingml');

  if (!isExtensionValid || !isMimeValid) {
    return cb(
      new Error(
        `Unsupported document type. Supported formats: PDF, Word Documents (.doc, .docx), Images (PNG, JPG, WEBP), and Text files (${config.ALLOWED_EXTENSIONS.join(', ')}).`
      )
    );
  }

  cb(null, true);
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_SIZE_BYTES },
  fileFilter,
});

/**
 * POST /api/documents/upload
 * Validates file type/size, prevents duplicates by SHA-256 hash, uploads to private Supabase Storage,
 * records document + processing job atomically in PostgreSQL, and dispatches reliable processing.
 */
documentsRouter.post('/upload', (req: AuthenticatedRequest, res: Response) => {
  upload.single('file')(req, res, async (err: any) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'File exceeds the 25 MB limit.'
          : err.message || 'File upload failed validation.';
      return res.status(400).json({ error: msg });
    }

    const file = req.file;
    let uploadedStoragePath: string | null = null;

    try {
      const userId = req.user!.id;
      if (!file || !file.buffer || file.buffer.length === 0) {
        return res.status(400).json({ error: 'No document file provided for upload.' });
      }

      const rawNotebookId = typeof req.body.notebookId === 'string' ? req.body.notebookId.trim() : '';
      if (!isValidEntityId(rawNotebookId)) {
        return res.status(400).json({ error: 'A valid notebookId is required for document upload.' });
      }

      const notebook = await db.getNotebook(rawNotebookId, userId);
      if (!notebook) {
        return res.status(404).json({ error: 'Selected notebook not found for your account.' });
      }

      const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

      // Duplicate document check per (user, notebook, fileHash)
      const duplicate = await db.findDuplicateDocument(userId, rawNotebookId, fileHash);
      if (duplicate) {
        if (duplicate.status === 'FAILED') {
          const retryJob = await db.createOrResetRetryJob(duplicate, 'inline');
          const dispatch = await jobQueueService.dispatchDocumentJob(duplicate, retryJob.id);
          const refreshed = (await db.getDocument(duplicate.id, userId)) || duplicate;
          return res.status(202).json({
            success: true,
            documentId: refreshed.id,
            status: refreshed.status,
            message: 'Re-queued previously failed upload for processing.',
            document: refreshed,
            queueProvider: dispatch.provider,
          });
        }
        return res.status(409).json({
          error: `"${duplicate.originalFileName}" is already uploaded in this notebook.`,
          code: 'DUPLICATE_DOCUMENT',
          existingDocumentId: duplicate.id,
        });
      }

      const documentId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      // Upload original file to private Supabase Storage
      const stored = await storageService.uploadBuffer({
        userId,
        notebookId: rawNotebookId,
        documentId,
        originalFileName: file.originalname,
        mimeType: file.mimetype,
        buffer: file.buffer,
      });
      uploadedStoragePath = stored.storagePath;

      const newDoc: DocumentRecord = {
        id: documentId,
        userId,
        notebookId: rawNotebookId,
        originalFileName: file.originalname,
        storageFileName: stored.storageFileName,
        storagePath: stored.storagePath,
        mimeType: file.mimetype || 'application/pdf',
        fileSize: file.size,
        fileHash,
        uploadDate: new Date().toISOString(),
        status: 'UPLOADED',
        currentStage: 'Document uploaded to private storage',
        progress: 20,
        message: 'Upload complete. Queuing document processing job...',
        processedPages: 0,
        totalPages: 1,
        chunkCount: 0,
        error: null,
      };

      await db.createDocumentWithJob(newDoc, {
        id: jobId,
        provider: 'qstash',
      });

      await db.addActivity({
        id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId,
        type: 'document',
        title: `Uploaded ${file.originalname}`,
        subtitle: `Stored in private bucket & queued for indexing`,
        timestamp: 'Just now',
        notebookTitle: notebook.title,
      });

      const dispatch = await jobQueueService.dispatchDocumentJob(newDoc, jobId);
      const latestDoc = (await db.getDocument(documentId, userId)) || newDoc;

      return res.status(dispatch.completedSynchronously ? 200 : 202).json({
        success: true,
        documentId,
        status: latestDoc.status,
        message:
          latestDoc.status === 'COMPLETED'
            ? 'Document uploaded and indexed successfully.'
            : 'Document uploaded successfully. Background processing job started.',
        document: latestDoc,
        queueProvider: dispatch.provider,
      });
    } catch (routeErr: any) {
      if (uploadedStoragePath) {
        await storageService.deleteObject(uploadedStoragePath);
      }
      console.error('Upload route error:', routeErr);
      return res.status(500).json({
        error: routeErr?.message || 'Failed to process document upload.',
      });
    }
  });
});

/**
 * GET /api/documents
 * Lists documents scoped strictly to authenticated user
 */
documentsRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const notebookId = typeof req.query.notebookId === 'string' ? req.query.notebookId : undefined;
    const docs = await db.getAllDocuments(userId, notebookId);
    return res.json({ documents: docs, total: docs.length });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to list documents.' });
  }
});

/**
 * GET /api/documents/:id/status
 * Exposes document processing status, job attempts, and metrics scoped to owner
 */
documentsRouter.get('/:id/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const doc = await db.getDocument(id, userId);

    if (!doc) {
      return res.status(404).json({ error: `Document with ID "${id}" not found.` });
    }

    const job = await db.getLatestProcessingJob(id, userId);

    return res.json({
      document_id: doc.id,
      status: doc.status,
      progress: doc.progress,
      current_stage: doc.currentStage,
      message: doc.message,
      processed_pages: doc.processedPages,
      total_pages: doc.totalPages,
      chunk_count: doc.chunkCount,
      metrics: doc.metrics || null,
      error: doc.error,
      job: job
        ? {
            id: job.id,
            status: job.status,
            provider: job.provider,
            attempts: job.attempts,
            lastError: job.lastError,
          }
        : null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to read document status.' });
  }
});

/**
 * GET /api/documents/:id/download-url
 * Returns a short-lived signed URL (60 seconds) for private Supabase Storage download.
 */
documentsRouter.get('/:id/download-url', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const doc = await db.getDocument(id, userId);

    if (!doc) {
      return res.status(404).json({ error: `Document with ID "${id}" not found.` });
    }

    const signedUrl = await storageService.createSignedDownloadUrl(doc.storagePath, 60);
    return res.json({
      url: signedUrl,
      expiresInSeconds: 60,
      fileName: doc.originalFileName,
    });
  } catch (err: any) {
    return res.status(400).json({
      error: err?.message || 'Unable to generate secure download link.',
    });
  }
});

/**
 * GET /api/documents/:id
 * Detailed document metadata
 */
documentsRouter.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const doc = await db.getDocument(id, userId);

    if (!doc) {
      return res.status(404).json({ error: `Document with ID "${id}" not found.` });
    }

    return res.json({ document: doc });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to fetch document.' });
  }
});

/**
 * GET /api/documents/:id/chunks
 * Inspect chunks generated for this document
 */
documentsRouter.get('/:id/chunks', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const doc = await db.getDocument(id, userId);

    if (!doc) {
      return res.status(404).json({ error: `Document with ID "${id}" not found.` });
    }

    const chunks = await db.getDocumentChunks(id, userId);
    return res.json({
      documentId: id,
      totalChunks: chunks.length,
      chunks,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to fetch document chunks.' });
  }
});

/**
 * POST /api/documents/:id/retry
 * Retry processing for a failed or stalled document using persistent job queue
 */
documentsRouter.post('/:id/retry', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const doc = await db.getDocument(id, userId);

    if (!doc) {
      return res.status(404).json({ error: `Document with ID "${id}" not found.` });
    }

    const job = await db.createOrResetRetryJob(doc, 'qstash');
    const dispatch = await jobQueueService.dispatchDocumentJob(doc, job.id);

    return res.json({
      success: true,
      message: `Retry initiated for document "${doc.originalFileName}".`,
      documentId: id,
      jobId: job.id,
      queueProvider: dispatch.provider,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to retry document processing.' });
  }
});

/**
 * DELETE /api/documents/notebooks/:notebookId
 * Removes all documents, database records, storage objects, and vector embeddings for an owned notebook.
 */
documentsRouter.delete('/notebooks/:notebookId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { notebookId } = req.params;

    if (!isValidEntityId(notebookId)) {
      return res.status(400).json({ error: 'Valid notebookId is required.' });
    }

    const docs = await db.getAllDocuments(userId, notebookId);
    let totalVectors = 0;

    for (const doc of docs) {
      totalVectors += await vectorStore.deleteByDocumentId(doc.id, userId);
      const del = await db.deleteDocument(doc.id, userId);
      if (del.storagePath) {
        await storageService.deleteObject(del.storagePath);
      }
    }
    await db.clearChatSummary(notebookId, userId);

    return res.json({
      success: true,
      message: `Removed ${docs.length} documents and ${totalVectors} vector chunks for notebook "${notebookId}".`,
      deletedDocumentsCount: docs.length,
      deletedVectors: totalVectors,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to remove notebook documents.' });
  }
});

/**
 * DELETE /api/documents/:id
 * Removes private storage file, database record (cascading chunks/vectors/summaries), scoped to owner.
 */
documentsRouter.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const doc = await db.getDocument(id, userId);

    if (!doc) {
      return res.status(404).json({ error: `Document with ID "${id}" not found.` });
    }

    const deletedVectors = await vectorStore.deleteByDocumentId(id, userId);
    const deleted = await db.deleteDocument(id, userId);
    if (deleted.storagePath) {
      await storageService.deleteObject(deleted.storagePath);
    }

    return res.json({
      success: true,
      message: `Document "${doc.originalFileName}" and its ${deletedVectors} vector chunks were permanently removed.`,
      deletedVectors,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to delete document.' });
  }
});

/**
 * POST /api/documents/clear-all
 * Clears ONLY the authenticated user's notebooks, documents, vectors, storage files, and exams.
 */
documentsRouter.post('/clear-all', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const storagePaths = await db.clearAllUserData(userId);
    for (const sp of storagePaths) {
      await storageService.deleteObject(sp);
    }

    return res.json({
      success: true,
      message: 'All your documents, notebooks, vector indices, and exam records have been cleared.',
    });
  } catch (err: any) {
    return res.status(500).json({
      error: `Failed to clear data: ${err?.message || err}`,
    });
  }
});
