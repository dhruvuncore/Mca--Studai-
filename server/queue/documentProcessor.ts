import { db } from '../db/database';
import { DocumentMetrics } from '../db/models';
import { storageService } from '../services/storageService';
import { pdfExtractor } from '../services/pdfExtractor';
import { textCleaner } from '../services/textCleaner';
import { structureDetector } from '../services/structureDetector';
import { chunker } from '../services/chunker';
import { chunkValidator } from '../services/chunkValidator';
import { embeddingService } from '../services/embeddingService';
import { vectorStore } from '../services/vectorStore';

export class DocumentProcessor {
  /**
   * Persistent, idempotent document ingestion pipeline.
   * Atomically claims a QUEUED/FAILED job in `processing_jobs`, downloads the file from
   * private Supabase Storage, extracts & chunks pages, generates 128-dim embeddings,
   * and atomically upserts chunks + pgvector embeddings inside a PostgreSQL transaction.
   */
  async processDocument(documentId: string): Promise<{ processed: boolean; status: string }> {
    const startTime = Date.now();

    const doc = await db.getDocument(documentId);
    if (!doc) {
      console.error(`[DocumentProcessor] Document ${documentId} not found in database.`);
      return { processed: false, status: 'NOT_FOUND' };
    }

    const claimedJob = await db.claimProcessingJob(documentId);
    if (!claimedJob) {
      // Either another worker already claimed/is running this job, or it already completed
      console.log(`[DocumentProcessor] Job for ${documentId} already running or completed; skipping duplicate run.`);
      return { processed: false, status: doc.status };
    }

    try {
      await db.updateDocument(documentId, {
        status: 'PROCESSING',
        currentStage: 'Initializing ingestion pipeline',
        progress: 25,
        message: 'Downloading document from private storage and initializing pipeline...',
        error: null,
      });

      const fileBuffer = await storageService.downloadBuffer(doc.storagePath);

      const extractStart = Date.now();
      await db.updateDocument(documentId, {
        status: 'EXTRACTING',
        currentStage: 'Page-by-page text extraction',
        progress: 35,
        message: 'Parsing document structure and extracting text per page...',
      });

      const extractedPages = await pdfExtractor.extractPagesFromBuffer(fileBuffer, doc.originalFileName);
      const extractDuration = Date.now() - extractStart;
      const totalPages = extractedPages.length || 1;
      const ocrPages = extractedPages.filter((p) => p.extractionMethod === 'ocr');

      let totalExtractedChars = 0;
      extractedPages.forEach((p) => {
        totalExtractedChars += p.charCount;
      });

      if (ocrPages.length > 0) {
        await db.updateDocument(documentId, {
          status: 'OCR',
          currentStage: `Optical Character Recognition (${ocrPages.length} scanned pages)`,
          progress: 50,
          message: `Applying OCR fallback to ${ocrPages.length} scanned or low-density pages...`,
          processedPages: totalPages,
          totalPages,
        });
      }

      await db.updateDocument(documentId, {
        status: 'CLEANING',
        currentStage: 'Text normalization & artifact removal',
        progress: 60,
        message: 'Removing repeated headers/footers while preserving formulas and definitions...',
        processedPages: totalPages,
        totalPages,
      });

      const cleanedPages = extractedPages.map((page) => {
        const cleaned = textCleaner.cleanPageText(page.rawText, page.pageNumber);
        const headings = structureDetector.extractPageHeadings(cleaned);
        return {
          pageNumber: page.pageNumber,
          cleanedText: cleaned,
          extractionMethod: page.extractionMethod,
          headings,
        };
      });

      await db.updateDocument(documentId, {
        status: 'CHUNKING',
        currentStage: 'Structure-aware semantic chunking',
        progress: 72,
        message: 'Dividing content into semantic chunks (500-800 tokens) with 15% overlap...',
      });

      const rawChunks = chunker.chunkPages(
        doc.id,
        doc.userId,
        doc.notebookId,
        doc.originalFileName,
        cleanedPages
      );

      const validation = chunkValidator.validateChunks(rawChunks);
      const validChunks = validation.validChunks;

      if (validChunks.length === 0) {
        throw new Error(
          'Document processing yielded zero valid text chunks. The document may be empty or unreadable.'
        );
      }

      await db.updateDocument(documentId, {
        status: 'EMBEDDING',
        currentStage: `Generating vector embeddings (${validChunks.length} chunks)`,
        progress: 85,
        message: `Computing 128-dimensional dense semantic embeddings for ${validChunks.length} chunks...`,
        chunkCount: validChunks.length,
      });

      const chunkTexts = validChunks.map((c) => c.text);
      const vectors = await embeddingService.embedChunks(chunkTexts);

      const indexStart = Date.now();
      await db.updateDocument(documentId, {
        status: 'INDEXING',
        currentStage: 'PostgreSQL pgvector indexing',
        progress: 94,
        message: 'Storing chunks and embeddings atomically in PostgreSQL pgvector...',
      });

      // Atomic transactional save of chunks + 128-dim embeddings
      await vectorStore.upsertChunks(validChunks, vectors);
      const indexingDuration = Date.now() - indexStart;
      const totalDuration = Date.now() - startTime;

      const metrics: DocumentMetrics = {
        fileSize: doc.fileSize,
        pageCount: totalPages,
        extractionDurationMs: extractDuration,
        ocrPagesCount: ocrPages.length,
        extractedChars: totalExtractedChars,
        chunkCount: validChunks.length,
        skippedChunks: validation.skippedChunksCount,
        embeddingCount: vectors.length,
        indexingDurationMs: indexingDuration,
        totalDurationMs: totalDuration,
      };

      await db.updateDocument(documentId, {
        status: 'COMPLETED',
        currentStage: 'Document Ingestion Complete',
        progress: 100,
        message: `Successfully indexed ${validChunks.length} chunks across ${totalPages} pages into PostgreSQL pgvector.`,
        processedPages: totalPages,
        totalPages,
        chunkCount: validChunks.length,
        error: null,
        metrics,
      });

      await db.completeProcessingJob(claimedJob.id);

      console.log(
        `[Pipeline Complete] "${doc.originalFileName}" (${documentId}): ${totalPages} pages, ${validChunks.length} chunks, ${totalDuration}ms`
      );
      return { processed: true, status: 'COMPLETED' };
    } catch (err: any) {
      const errorMessage = err?.message || 'Unknown processing error occurred while extracting document.';
      console.error(`[Pipeline Failed] Document ${documentId}:`, err);

      await db.updateDocument(documentId, {
        status: 'FAILED',
        currentStage: 'Processing Failed',
        message: 'Ingestion pipeline encountered an error.',
        error: errorMessage,
      });

      await db.failProcessingJob(claimedJob.id, errorMessage);
      return { processed: false, status: 'FAILED' };
    }
  }
}

export const documentProcessor = new DocumentProcessor();
