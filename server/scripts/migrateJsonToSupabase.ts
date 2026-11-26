import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Pool } from 'pg';

interface LegacyDocumentRecord {
  id: string;
  userId: string;
  notebookId: string;
  originalFileName: string;
  storageFileName?: string;
  storagePath: string;
  mimeType?: string;
  fileSize?: number;
  uploadDate?: string;
  status?: string;
  currentStage?: string;
  progress?: number;
  message?: string;
  processedPages?: number;
  totalPages?: number;
  chunkCount?: number;
  error?: string | null;
  metrics?: Record<string, any>;
}

interface LegacyChunk {
  id: string;
  documentId: string;
  userId: string;
  notebookId: string;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  section?: string;
  heading?: string;
  text: string;
  tokenEstimate?: number;
  extractionMethod?: string;
  sourceDocName: string;
}

interface LegacyVectorEntry {
  id: string;
  documentId: string;
  userId: string;
  notebookId: string;
  vector: number[];
}

interface LegacySummariesFile {
  docSummaries?: Record<
    string,
    {
      documentId: string;
      notebookId: string;
      userId?: string;
      originalFileName: string;
      summary: string;
      pageCount?: number;
      fileSize?: string;
      generatedAt: string;
      sourceChunkCount?: number;
    }
  >;
  chatSummaries?: Record<
    string,
    {
      notebookId: string;
      userId?: string;
      summary: string;
      generatedAt: string;
      messageCount?: number;
      lastMessageId?: string;
    }
  >;
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value !== 'undefined' &&
    value !== 'null' &&
    !value.startsWith('undefined_')
  );
}

function formatVectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || vector.length !== 128) {
    throw new Error(`Expected 128-dim vector, received length ${vector?.length}`);
  }
  return `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}

export async function runMigration() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const targetUserId = process.env.MIGRATION_TARGET_USER_ID?.trim();
  const targetUserEmail = process.env.MIGRATION_TARGET_EMAIL?.trim().toLowerCase();

  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required to run migration.');
  }

  const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });

  const dataDir = path.resolve(process.cwd(), 'data');
  const docsFile = path.join(dataDir, 'db', 'documents.json');
  const chunksFile = path.join(dataDir, 'db', 'chunks.json');
  const summariesFile = path.join(dataDir, 'db', 'summaries.json');
  const vectorsFile = path.join(dataDir, 'vectordb', 'vectors.json');

  try {
    const client = await pool.connect();
    try {
      // Resolve target Supabase Auth user UUID
      let resolvedUserId = targetUserId || '';
      if (!resolvedUserId && targetUserEmail) {
        const uRes = await client.query<{ id: string }>(
          'SELECT id FROM public.users WHERE LOWER(email) = $1 LIMIT 1',
          [targetUserEmail]
        );
        if (uRes.rows[0]) {
          resolvedUserId = uRes.rows[0].id;
        }
      }

      if (!resolvedUserId) {
        const firstUserRes = await client.query<{ id: string }>(
          'SELECT id FROM public.users ORDER BY created_at ASC LIMIT 1'
        );
        if (firstUserRes.rows[0]) {
          resolvedUserId = firstUserRes.rows[0].id;
        }
      }

      if (!resolvedUserId) {
        throw new Error(
          'No target user found in public.users. Register a user in Supabase Auth first, or pass MIGRATION_TARGET_USER_ID=<uuid> / MIGRATION_TARGET_EMAIL=<email>.'
        );
      }

      console.log(`[Migration] Migrating valid legacy JSON data to Supabase user UUID: ${resolvedUserId}`);

      const rawDocs: LegacyDocumentRecord[] = fs.existsSync(docsFile)
        ? JSON.parse(fs.readFileSync(docsFile, 'utf-8'))
        : [];
      const rawChunksMap: Record<string, LegacyChunk[]> = fs.existsSync(chunksFile)
        ? JSON.parse(fs.readFileSync(chunksFile, 'utf-8'))
        : {};
      const rawSummaries: LegacySummariesFile = fs.existsSync(summariesFile)
        ? JSON.parse(fs.readFileSync(summariesFile, 'utf-8'))
        : {};
      const rawVectors: LegacyVectorEntry[] = fs.existsSync(vectorsFile)
        ? JSON.parse(fs.readFileSync(vectorsFile, 'utf-8'))
        : [];

      const validDocs = rawDocs.filter((d) => d && isValidId(d.id) && isValidId(d.notebookId));

      // Collect all notebook IDs referenced across docs, chunks, and summaries
      const notebookIds = new Set<string>();
      validDocs.forEach((d) => notebookIds.add(d.notebookId));
      Object.values(rawSummaries.docSummaries || {}).forEach((ds) => {
        if (isValidId(ds.notebookId)) notebookIds.add(ds.notebookId);
      });
      Object.values(rawSummaries.chatSummaries || {}).forEach((cs) => {
        if (isValidId(cs.notebookId)) notebookIds.add(cs.notebookId);
      });

      const notebookTitles: Record<string, { title: string; code: string; desc: string }> = {
        nb_pdf_test: {
          title: 'DBMS Course Materials (Migrated)',
          code: 'MCA-201',
          desc: 'Migrated DBMS relational model, transactions, and B+ tree indexing documents.',
        },
        nb_test_multi_chat: {
          title: 'DBMS & Advanced Architecture (Migrated)',
          code: 'MCA-202',
          desc: 'Migrated study conversation on Normalization & MVCC.',
        },
        nb_dbms: {
          title: 'Database Management Systems (Migrated)',
          code: 'MCA-201',
          desc: 'Migrated DBMS Architecture chat summary.',
        },
      };

      await client.query('BEGIN');

      // 1. Insert Notebooks
      let migratedNotebooks = 0;
      for (const nbId of notebookIds) {
        const meta = notebookTitles[nbId] || {
          title: `Migrated Notebook (${nbId})`,
          code: 'MIGRATED',
          desc: 'Migrated from StudyAI Phase 1 JSON store.',
        };
        const res = await client.query(
          `INSERT INTO public.notebooks (id, user_id, title, code, description, last_studied)
           VALUES ($1, $2, $3, $4, $5, 'Migrated')
           ON CONFLICT (id) DO NOTHING`,
          [nbId, resolvedUserId, meta.title, meta.code, meta.desc]
        );
        migratedNotebooks += res.rowCount || 0;
      }

      // 2. Insert Documents
      let migratedDocs = 0;
      for (const doc of validDocs) {
        const legacyHash = crypto
          .createHash('sha256')
          .update(`legacy:${doc.id}:${doc.originalFileName}`)
          .digest('hex');

        const res = await client.query(
          `INSERT INTO public.documents (
             id, user_id, notebook_id, original_file_name, storage_file_name, storage_path,
             mime_type, file_size, file_hash, upload_date, status, current_stage, progress,
             message, processed_pages, total_pages, chunk_count, error, metrics
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19::jsonb
           )
           ON CONFLICT (id) DO NOTHING`,
          [
            doc.id,
            resolvedUserId,
            doc.notebookId,
            doc.originalFileName,
            doc.storageFileName || path.basename(doc.storagePath || doc.originalFileName),
            doc.storagePath || `legacy/${resolvedUserId}/${doc.notebookId}/${doc.originalFileName}`,
            doc.mimeType || 'application/pdf',
            doc.fileSize || 0,
            legacyHash,
            doc.uploadDate || new Date().toISOString(),
            doc.status || 'COMPLETED',
            doc.currentStage || 'Document Ingestion Complete',
            doc.progress ?? 100,
            doc.message || 'Migrated from Phase 1 JSON store',
            doc.processedPages ?? 1,
            doc.totalPages ?? 1,
            doc.chunkCount ?? 1,
            doc.error ?? null,
            doc.metrics ? JSON.stringify(doc.metrics) : null,
          ]
        );
        migratedDocs += res.rowCount || 0;
      }

      // 3. Insert Document Chunks
      let migratedChunks = 0;
      for (const [docId, chunkList] of Object.entries(rawChunksMap)) {
        if (!isValidId(docId) || !Array.isArray(chunkList)) continue;
        for (const chunk of chunkList) {
          if (!isValidId(chunk.id) || !isValidId(chunk.notebookId)) continue;
          const res = await client.query(
            `INSERT INTO public.document_chunks (
               id, document_id, user_id, notebook_id, chunk_index,
               page_start, page_end, section, heading, text,
               token_estimate, extraction_method, source_doc_name
             ) VALUES (
               $1, $2, $3, $4, $5,
               $6, $7, $8, $9, $10,
               $11, $12, $13
             )
             ON CONFLICT (id) DO NOTHING`,
            [
              chunk.id,
              chunk.documentId,
              resolvedUserId,
              chunk.notebookId,
              chunk.chunkIndex || 0,
              chunk.pageStart || 1,
              chunk.pageEnd || chunk.pageStart || 1,
              chunk.section || '',
              chunk.heading || '',
              chunk.text,
              chunk.tokenEstimate || Math.ceil((chunk.text || '').length / 4),
              chunk.extractionMethod === 'ocr' ? 'ocr' : 'text',
              chunk.sourceDocName,
            ]
          );
          migratedChunks += res.rowCount || 0;
        }
      }

      // 4. Insert Vector Embeddings
      let migratedVectors = 0;
      for (const vec of rawVectors) {
        if (!isValidId(vec.id) || !isValidId(vec.documentId) || !isValidId(vec.notebookId)) continue;
        const literal = formatVectorLiteral(vec.vector);
        const res = await client.query(
          `INSERT INTO public.vector_embeddings (chunk_id, document_id, user_id, notebook_id, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)
           ON CONFLICT (chunk_id) DO NOTHING`,
          [vec.id, vec.documentId, resolvedUserId, vec.notebookId, literal]
        );
        migratedVectors += res.rowCount || 0;
      }

      // 5. Insert Document Summaries
      let migratedDocSummaries = 0;
      for (const [docId, ds] of Object.entries(rawSummaries.docSummaries || {})) {
        if (!isValidId(docId) || !isValidId(ds.notebookId)) continue;
        const res = await client.query(
          `INSERT INTO public.document_summaries (
             document_id, user_id, notebook_id, original_file_name,
             summary, page_count, file_size, source_chunk_count, generated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (document_id) DO NOTHING`,
          [
            ds.documentId || docId,
            resolvedUserId,
            ds.notebookId,
            ds.originalFileName,
            ds.summary,
            ds.pageCount || 1,
            ds.fileSize || null,
            ds.sourceChunkCount || 0,
            ds.generatedAt,
          ]
        );
        migratedDocSummaries += res.rowCount || 0;
      }

      // 6. Insert Chat Summaries
      let migratedChatSummaries = 0;
      for (const [nbId, cs] of Object.entries(rawSummaries.chatSummaries || {})) {
        if (!isValidId(nbId)) continue;
        const res = await client.query(
          `INSERT INTO public.chat_summaries (
             notebook_id, user_id, summary, generated_at, message_count, last_message_id
           ) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (notebook_id) DO NOTHING`,
          [
            cs.notebookId || nbId,
            resolvedUserId,
            cs.summary,
            cs.generatedAt,
            cs.messageCount || 0,
            cs.lastMessageId || null,
          ]
        );
        migratedChatSummaries += res.rowCount || 0;
      }

      await client.query('COMMIT');

      // 7. Verification Queries
      const verify = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM public.notebooks WHERE user_id = $1) AS notebooks_count,
           (SELECT COUNT(*) FROM public.documents WHERE user_id = $1) AS documents_count,
           (SELECT COUNT(*) FROM public.document_chunks WHERE user_id = $1) AS chunks_count,
           (SELECT COUNT(*) FROM public.vector_embeddings WHERE user_id = $1) AS vectors_count,
           (SELECT COUNT(*) FROM public.document_summaries WHERE user_id = $1) AS doc_summaries_count,
           (SELECT COUNT(*) FROM public.chat_summaries WHERE user_id = $1) AS chat_summaries_count`,
        [resolvedUserId]
      );

      console.log('[Migration] Transaction committed. Newly inserted counts:', {
        migratedNotebooks,
        migratedDocs,
        migratedChunks,
        migratedVectors,
        migratedDocSummaries,
        migratedChatSummaries,
      });
      console.log('[Migration] Verified totals in PostgreSQL for user:', verify.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration()
    .then(() => {
      console.log('[Migration] Completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration] Failed:', err);
      process.exit(1);
    });
}
