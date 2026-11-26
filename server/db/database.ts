import { PoolClient } from 'pg';
import {
  ChatMessageRecord,
  ChatSummaryRecord,
  DocumentChunk,
  DocumentMetrics,
  DocumentRecord,
  DocumentStatus,
  DocumentSummaryRecord,
  ExamResultRecord,
  NotebookRecord,
  ProcessingJobRecord,
  RecentActivityRecord,
  UserProfileRecord,
} from './models';
import { formatVectorLiteral, pgQuery, withTransaction } from './supabaseClient';

export function isValidEntityId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== 'undefined' &&
    trimmed !== 'null' &&
    trimmed !== 'NaN' &&
    !trimmed.startsWith('undefined_')
  );
}

function mapDocumentRow(row: any): DocumentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    notebookId: row.notebook_id,
    originalFileName: row.original_file_name,
    storageFileName: row.storage_file_name,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size || 0),
    fileHash: row.file_hash || undefined,
    uploadDate: row.upload_date ? new Date(row.upload_date).toISOString() : new Date().toISOString(),
    status: row.status as DocumentStatus,
    currentStage: row.current_stage,
    progress: Number(row.progress || 0),
    message: row.message || '',
    processedPages: Number(row.processed_pages || 0),
    totalPages: Number(row.total_pages || 1),
    chunkCount: Number(row.chunk_count || 0),
    error: row.error || null,
    metrics: (row.metrics as DocumentMetrics | null) || undefined,
  };
}

function mapChunkRow(row: any): DocumentChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    userId: row.user_id,
    notebookId: row.notebook_id,
    chunkIndex: Number(row.chunk_index || 0),
    pageStart: Number(row.page_start || 1),
    pageEnd: Number(row.page_end || 1),
    section: row.section || '',
    heading: row.heading || '',
    text: row.text,
    tokenEstimate: Number(row.token_estimate || 0),
    extractionMethod: row.extraction_method === 'ocr' ? 'ocr' : 'text',
    sourceDocName: row.source_doc_name,
  };
}

function mapJobRow(row: any): ProcessingJobRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    userId: row.user_id,
    notebookId: row.notebook_id,
    status: row.status,
    provider: row.provider,
    qstashMessageId: row.qstash_message_id || null,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 3),
    lastError: row.last_error || null,
    lockedAt: row.locked_at ? new Date(row.locked_at).toISOString() : null,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}

class PostgresDatabase {
  // ============================================================
  // USERS
  // ============================================================
  async getUserProfile(userId: string): Promise<UserProfileRecord | null> {
    if (!isValidEntityId(userId)) return null;
    const res = await pgQuery(
      `SELECT id, email, name, avatar, degree, semester, university, created_at, updated_at
       FROM public.users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      avatar: r.avatar || 'ST',
      degree: r.degree,
      semester: r.semester,
      university: r.university,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async updateUserProfile(
    userId: string,
    updates: Partial<Pick<UserProfileRecord, 'name' | 'degree' | 'semester' | 'university' | 'avatar'>>
  ): Promise<UserProfileRecord | null> {
    if (!isValidEntityId(userId)) return null;
    const res = await pgQuery(
      `UPDATE public.users
       SET
         name = COALESCE($2, name),
         degree = COALESCE($3, degree),
         semester = COALESCE($4, semester),
         university = COALESCE($5, university),
         avatar = COALESCE($6, avatar),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, avatar, degree, semester, university, created_at, updated_at`,
      [
        userId,
        updates.name?.trim() || null,
        updates.degree?.trim() || null,
        updates.semester?.trim() || null,
        updates.university?.trim() || null,
        updates.avatar?.trim() || null,
      ]
    );
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      avatar: r.avatar || 'ST',
      degree: r.degree,
      semester: r.semester,
      university: r.university,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // ============================================================
  // NOTEBOOKS
  // ============================================================
  async getNotebooks(userId: string): Promise<Array<NotebookRecord & { documents: DocumentRecord[]; documentsCount: number }>> {
    if (!isValidEntityId(userId)) return [];
    const nbRes = await pgQuery(
      `SELECT id, user_id, title, code, description, icon_name, accent_color, progress, last_studied, created_at, updated_at
       FROM public.notebooks
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    const docsRes = await pgQuery(
      `SELECT * FROM public.documents
       WHERE user_id = $1
       ORDER BY upload_date DESC`,
      [userId]
    );

    const docsByNotebook = new Map<string, DocumentRecord[]>();
    for (const row of docsRes.rows) {
      const mapped = mapDocumentRow(row);
      const list = docsByNotebook.get(mapped.notebookId) || [];
      list.push(mapped);
      docsByNotebook.set(mapped.notebookId, list);
    }

    return nbRes.rows.map((row) => {
      const docs = docsByNotebook.get(row.id) || [];
      return {
        id: row.id,
        userId: row.user_id,
        title: row.title,
        code: row.code || '',
        description: row.description || '',
        iconName: row.icon_name || 'BookOpen',
        accentColor: row.accent_color || '#2563EB',
        progress: Number(row.progress || 0),
        lastStudied: row.last_studied || 'Just now',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        documentsCount: docs.length,
        documents: docs,
      };
    });
  }

  async getNotebook(notebookId: string, userId: string): Promise<NotebookRecord | null> {
    if (!isValidEntityId(notebookId) || !isValidEntityId(userId)) return null;
    const res = await pgQuery(
      `SELECT id, user_id, title, code, description, icon_name, accent_color, progress, last_studied, created_at, updated_at
       FROM public.notebooks
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [notebookId, userId]
    );
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      title: r.title,
      code: r.code || '',
      description: r.description || '',
      iconName: r.icon_name || 'BookOpen',
      accentColor: r.accent_color || '#2563EB',
      progress: Number(r.progress || 0),
      lastStudied: r.last_studied || 'Just now',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async createNotebook(
    userId: string,
    input: { id?: string; title: string; code?: string; description?: string; iconName?: string; accentColor?: string }
  ): Promise<NotebookRecord> {
    if (!isValidEntityId(userId)) {
      throw new Error('Valid authenticated userId is required.');
    }
    const id = input.id && isValidEntityId(input.id) ? input.id.trim() : `nb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const title = (input.title || '').trim();
    if (!title) {
      throw new Error('Notebook title is required.');
    }

    const res = await pgQuery(
      `INSERT INTO public.notebooks (id, user_id, title, code, description, icon_name, accent_color, progress, last_studied)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'Just now')
       RETURNING id, user_id, title, code, description, icon_name, accent_color, progress, last_studied, created_at, updated_at`,
      [
        id,
        userId,
        title,
        (input.code || '').trim(),
        (input.description || 'Custom study notebook for course preparation.').trim(),
        input.iconName || 'BookOpen',
        input.accentColor || '#2563EB',
      ]
    );

    const r = res.rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      title: r.title,
      code: r.code || '',
      description: r.description || '',
      iconName: r.icon_name || 'BookOpen',
      accentColor: r.accent_color || '#2563EB',
      progress: Number(r.progress || 0),
      lastStudied: r.last_studied || 'Just now',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async deleteNotebook(notebookId: string, userId: string): Promise<{ deleted: boolean; storagePaths: string[]; title?: string }> {
    if (!isValidEntityId(notebookId) || !isValidEntityId(userId)) {
      return { deleted: false, storagePaths: [] };
    }

    return withTransaction(async (client: PoolClient) => {
      const nbRes = await client.query<{ id: string; title: string }>(
        `SELECT id, title FROM public.notebooks WHERE id = $1 AND user_id = $2`,
        [notebookId, userId]
      );
      if (!nbRes.rows[0]) {
        return { deleted: false, storagePaths: [] };
      }

      const docsRes = await client.query<{ storage_path: string }>(
        `SELECT storage_path FROM public.documents WHERE notebook_id = $1 AND user_id = $2`,
        [notebookId, userId]
      );
      const storagePaths = docsRes.rows.map((r) => r.storage_path).filter(Boolean);

      await client.query(`DELETE FROM public.notebooks WHERE id = $1 AND user_id = $2`, [notebookId, userId]);
      return { deleted: true, storagePaths, title: nbRes.rows[0].title };
    });
  }

  // ============================================================
  // DOCUMENTS & PROCESSING JOBS
  // ============================================================
  async findDuplicateDocument(userId: string, notebookId: string, fileHash: string): Promise<DocumentRecord | null> {
    if (!isValidEntityId(userId) || !isValidEntityId(notebookId) || !fileHash) return null;
    const res = await pgQuery(
      `SELECT * FROM public.documents
       WHERE user_id = $1 AND notebook_id = $2 AND file_hash = $3
       LIMIT 1`,
      [userId, notebookId, fileHash]
    );
    return res.rows[0] ? mapDocumentRow(res.rows[0]) : null;
  }

  async createDocumentWithJob(
    doc: DocumentRecord,
    job: Pick<ProcessingJobRecord, 'id' | 'provider' | 'qstashMessageId'>
  ): Promise<{ document: DocumentRecord; job: ProcessingJobRecord }> {
    if (!isValidEntityId(doc.id) || !isValidEntityId(doc.userId) || !isValidEntityId(doc.notebookId)) {
      throw new Error('Cannot create document without valid IDs.');
    }

    return withTransaction(async (client: PoolClient) => {
      // Verify notebook belongs to user
      const nbCheck = await client.query(
        `SELECT id FROM public.notebooks WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [doc.notebookId, doc.userId]
      );
      if (!nbCheck.rows[0]) {
        throw new Error('Selected notebook was not found for your account.');
      }

      const docRes = await client.query(
        `INSERT INTO public.documents (
           id, user_id, notebook_id, original_file_name, storage_file_name, storage_path,
           mime_type, file_size, file_hash, upload_date, status, current_stage, progress,
           message, processed_pages, total_pages, chunk_count, error, metrics
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19::jsonb
         )
         RETURNING *`,
        [
          doc.id.trim(),
          doc.userId.trim(),
          doc.notebookId.trim(),
          doc.originalFileName,
          doc.storageFileName,
          doc.storagePath,
          doc.mimeType || 'application/pdf',
          doc.fileSize || 0,
          doc.fileHash || null,
          doc.uploadDate || new Date().toISOString(),
          doc.status || 'UPLOADED',
          doc.currentStage || 'Document uploaded and queued',
          doc.progress ?? 20,
          doc.message || 'Queued for background processing',
          doc.processedPages ?? 0,
          doc.totalPages ?? 1,
          doc.chunkCount ?? 0,
          doc.error || null,
          doc.metrics ? JSON.stringify(doc.metrics) : null,
        ]
      );

      const jobRes = await client.query(
        `INSERT INTO public.processing_jobs (
           id, document_id, user_id, notebook_id, status, provider, qstash_message_id, attempts, max_attempts
         ) VALUES ($1, $2, $3, $4, 'QUEUED', $5, $6, 0, 3)
         RETURNING *`,
        [job.id, doc.id.trim(), doc.userId.trim(), doc.notebookId.trim(), job.provider, job.qstashMessageId || null]
      );

      return {
        document: mapDocumentRow(docRes.rows[0]),
        job: mapJobRow(jobRes.rows[0]),
      };
    });
  }

  async getDocument(id: string, userId?: string): Promise<DocumentRecord | undefined> {
    if (!isValidEntityId(id)) return undefined;
    const res = userId
      ? await pgQuery(`SELECT * FROM public.documents WHERE id = $1 AND user_id = $2 LIMIT 1`, [id, userId])
      : await pgQuery(`SELECT * FROM public.documents WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] ? mapDocumentRow(res.rows[0]) : undefined;
  }

  async getAllDocuments(userId: string, notebookId?: string): Promise<DocumentRecord[]> {
    if (!isValidEntityId(userId)) return [];
    const res = notebookId
      ? await pgQuery(
          `SELECT * FROM public.documents WHERE user_id = $1 AND notebook_id = $2 ORDER BY upload_date DESC`,
          [userId, notebookId]
        )
      : await pgQuery(
          `SELECT * FROM public.documents WHERE user_id = $1 ORDER BY upload_date DESC`,
          [userId]
        );
    return res.rows.map(mapDocumentRow);
  }

  async updateDocument(id: string, updates: Partial<DocumentRecord>): Promise<DocumentRecord | undefined> {
    if (!isValidEntityId(id)) return undefined;
    const res = await pgQuery(
      `UPDATE public.documents
       SET
         status = COALESCE($2, status),
         current_stage = COALESCE($3, current_stage),
         progress = COALESCE($4, progress),
         message = COALESCE($5, message),
         processed_pages = COALESCE($6, processed_pages),
         total_pages = COALESCE($7, total_pages),
         chunk_count = COALESCE($8, chunk_count),
         error = CASE WHEN $9::boolean THEN $10 ELSE error END,
         metrics = COALESCE($11::jsonb, metrics),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        updates.status ?? null,
        updates.currentStage ?? null,
        updates.progress !== undefined ? updates.progress : null,
        updates.message ?? null,
        updates.processedPages !== undefined ? updates.processedPages : null,
        updates.totalPages !== undefined ? updates.totalPages : null,
        updates.chunkCount !== undefined ? updates.chunkCount : null,
        updates.error !== undefined,
        updates.error ?? null,
        updates.metrics ? JSON.stringify(updates.metrics) : null,
      ]
    );
    return res.rows[0] ? mapDocumentRow(res.rows[0]) : undefined;
  }

  async deleteDocument(id: string, userId: string): Promise<{ deleted: boolean; storagePath?: string; fileName?: string }> {
    if (!isValidEntityId(id) || !isValidEntityId(userId)) return { deleted: false };
    const res = await pgQuery<{ storage_path: string; original_file_name: string }>(
      `DELETE FROM public.documents
       WHERE id = $1 AND user_id = $2
       RETURNING storage_path, original_file_name`,
      [id, userId]
    );
    if (!res.rows[0]) return { deleted: false };
    return {
      deleted: true,
      storagePath: res.rows[0].storage_path,
      fileName: res.rows[0].original_file_name,
    };
  }

  // ============================================================
  // PROCESSING JOBS
  // ============================================================
  async claimProcessingJob(documentId: string): Promise<ProcessingJobRecord | null> {
    if (!isValidEntityId(documentId)) return null;
    const res = await pgQuery(
      `UPDATE public.processing_jobs
       SET
         status = 'RUNNING',
         attempts = attempts + 1,
         locked_at = NOW(),
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
       WHERE id = (
         SELECT id FROM public.processing_jobs
         WHERE document_id = $1 AND status IN ('QUEUED', 'FAILED')
         ORDER BY created_at DESC
         LIMIT 1
       )
       RETURNING *`,
      [documentId]
    );
    return res.rows[0] ? mapJobRow(res.rows[0]) : null;
  }

  async createOrResetRetryJob(
    doc: DocumentRecord,
    provider: 'qstash' | 'inline' | 'local'
  ): Promise<ProcessingJobRecord> {
    return withTransaction(async (client: PoolClient) => {
      const active = await client.query(
        `SELECT * FROM public.processing_jobs
         WHERE document_id = $1 AND status IN ('QUEUED', 'RUNNING')
         LIMIT 1`,
        [doc.id]
      );
      if (active.rows[0]) {
        return mapJobRow(active.rows[0]);
      }

      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const res = await client.query(
        `INSERT INTO public.processing_jobs (
           id, document_id, user_id, notebook_id, status, provider, attempts, max_attempts
         ) VALUES ($1, $2, $3, $4, 'QUEUED', $5, 0, 3)
         RETURNING *`,
        [jobId, doc.id, doc.userId, doc.notebookId, provider]
      );

      await client.query(
        `UPDATE public.documents
         SET status = 'UPLOADED',
             current_stage = 'Queued for retry',
             progress = 20,
             message = 'Document re-queued for background processing...',
             error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [doc.id]
      );

      return mapJobRow(res.rows[0]);
    });
  }

  async updateJobProviderRef(jobId: string, provider: 'qstash' | 'inline' | 'local', qstashMessageId?: string): Promise<void> {
    await pgQuery(
      `UPDATE public.processing_jobs
       SET provider = $2, qstash_message_id = COALESCE($3, qstash_message_id), updated_at = NOW()
       WHERE id = $1`,
      [jobId, provider, qstashMessageId || null]
    );
  }

  async completeProcessingJob(jobId: string): Promise<void> {
    await pgQuery(
      `UPDATE public.processing_jobs
       SET status = 'COMPLETED', completed_at = NOW(), last_error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [jobId]
    );
  }

  async failProcessingJob(jobId: string, errorMessage: string): Promise<void> {
    await pgQuery(
      `UPDATE public.processing_jobs
       SET status = 'FAILED', last_error = $2, updated_at = NOW()
       WHERE id = $1`,
      [jobId, errorMessage.slice(0, 1000)]
    );
  }

  async getLatestProcessingJob(documentId: string, userId: string): Promise<ProcessingJobRecord | null> {
    if (!isValidEntityId(documentId) || !isValidEntityId(userId)) return null;
    const res = await pgQuery(
      `SELECT * FROM public.processing_jobs
       WHERE document_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [documentId, userId]
    );
    return res.rows[0] ? mapJobRow(res.rows[0]) : null;
  }

  // ============================================================
  // CHUNKS & VECTOR EMBEDDINGS (TRANSACTIONAL)
  // ============================================================
  async saveDocumentChunksAndVectors(
    documentId: string,
    userId: string,
    notebookId: string,
    chunks: DocumentChunk[],
    vectors: number[][]
  ): Promise<void> {
    if (!isValidEntityId(documentId) || !isValidEntityId(userId) || !isValidEntityId(notebookId)) {
      throw new Error('Valid documentId, userId, and notebookId are required to store chunks.');
    }
    if (chunks.length !== vectors.length) {
      throw new Error('Chunk count and embedding vector count mismatch.');
    }

    await withTransaction(async (client: PoolClient) => {
      // Remove existing chunks/vectors for idempotency on retry
      await client.query(`DELETE FROM public.vector_embeddings WHERE document_id = $1`, [documentId]);
      await client.query(`DELETE FROM public.document_chunks WHERE document_id = $1`, [documentId]);

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const vecLiteral = formatVectorLiteral(vectors[i]);

        await client.query(
          `INSERT INTO public.document_chunks (
             id, document_id, user_id, notebook_id, chunk_index,
             page_start, page_end, section, heading, text,
             token_estimate, extraction_method, source_doc_name
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            c.id,
            documentId,
            userId,
            notebookId,
            c.chunkIndex,
            c.pageStart,
            c.pageEnd,
            c.section || '',
            c.heading || '',
            c.text,
            c.tokenEstimate,
            c.extractionMethod === 'ocr' ? 'ocr' : 'text',
            c.sourceDocName,
          ]
        );

        await client.query(
          `INSERT INTO public.vector_embeddings (
             chunk_id, document_id, user_id, notebook_id, embedding
           ) VALUES ($1, $2, $3, $4, $5::vector)`,
          [c.id, documentId, userId, notebookId, vecLiteral]
        );
      }
    });
  }

  async getDocumentChunks(documentId: string, userId?: string): Promise<DocumentChunk[]> {
    if (!isValidEntityId(documentId)) return [];
    const res = userId
      ? await pgQuery(
          `SELECT * FROM public.document_chunks WHERE document_id = $1 AND user_id = $2 ORDER BY chunk_index ASC`,
          [documentId, userId]
        )
      : await pgQuery(
          `SELECT * FROM public.document_chunks WHERE document_id = $1 ORDER BY chunk_index ASC`,
          [documentId]
        );
    return res.rows.map(mapChunkRow);
  }

  async deleteVectorsByDocumentId(documentId: string, userId?: string): Promise<number> {
    if (!isValidEntityId(documentId)) return 0;
    const res = userId
      ? await pgQuery(`DELETE FROM public.vector_embeddings WHERE document_id = $1 AND user_id = $2`, [
          documentId,
          userId,
        ])
      : await pgQuery(`DELETE FROM public.vector_embeddings WHERE document_id = $1`, [documentId]);
    return res.rowCount || 0;
  }

  async getVectorCountForUser(userId: string): Promise<number> {
    if (!isValidEntityId(userId)) return 0;
    const res = await pgQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.vector_embeddings WHERE user_id = $1`,
      [userId]
    );
    return Number(res.rows[0]?.count || 0);
  }

  // ============================================================
  // CHAT MESSAGES
  // ============================================================
  async getChatMessages(notebookId: string, userId: string): Promise<ChatMessageRecord[]> {
    if (!isValidEntityId(notebookId) || !isValidEntityId(userId)) return [];
    const res = await pgQuery(
      `SELECT * FROM public.chat_messages
       WHERE notebook_id = $1 AND user_id = $2
       ORDER BY created_at ASC`,
      [notebookId, userId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      notebookId: r.notebook_id,
      sender: r.sender,
      text: r.text,
      timestamp: r.timestamp_label,
      sourceReferences: r.source_references || [],
      isGrounded: Boolean(r.is_grounded),
      retrievalScore: Number(r.retrieval_score || 0),
      insufficientInfo: Boolean(r.insufficient_info),
    }));
  }

  async saveChatMessage(msg: ChatMessageRecord): Promise<ChatMessageRecord> {
    if (!isValidEntityId(msg.id) || !isValidEntityId(msg.userId) || !isValidEntityId(msg.notebookId)) {
      throw new Error('Valid chat message ID, userId, and notebookId are required.');
    }
    const res = await pgQuery(
      `INSERT INTO public.chat_messages (
         id, user_id, notebook_id, sender, text, timestamp_label,
         source_references, is_grounded, retrieval_score, insufficient_info
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         text = EXCLUDED.text,
         source_references = EXCLUDED.source_references,
         is_grounded = EXCLUDED.is_grounded,
         retrieval_score = EXCLUDED.retrieval_score,
         insufficient_info = EXCLUDED.insufficient_info
       RETURNING *`,
      [
        msg.id,
        msg.userId,
        msg.notebookId,
        msg.sender,
        msg.text,
        msg.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        JSON.stringify(msg.sourceReferences || []),
        Boolean(msg.isGrounded),
        msg.retrievalScore || 0,
        Boolean(msg.insufficientInfo),
      ]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      notebookId: r.notebook_id,
      sender: r.sender,
      text: r.text,
      timestamp: r.timestamp_label,
      sourceReferences: r.source_references || [],
      isGrounded: Boolean(r.is_grounded),
      retrievalScore: Number(r.retrieval_score || 0),
      insufficientInfo: Boolean(r.insufficient_info),
    };
  }

  async clearChatMessages(notebookId: string, userId: string): Promise<void> {
    if (!isValidEntityId(notebookId) || !isValidEntityId(userId)) return;
    await pgQuery(`DELETE FROM public.chat_messages WHERE notebook_id = $1 AND user_id = $2`, [
      notebookId,
      userId,
    ]);
  }

  // ============================================================
  // SUMMARIES
  // ============================================================
  async saveDocumentSummary(summary: DocumentSummaryRecord): Promise<DocumentSummaryRecord> {
    const docId = summary.documentId;
    if (!isValidEntityId(docId) || !isValidEntityId(summary.notebookId) || !isValidEntityId(summary.userId)) {
      throw new Error('Valid documentId, notebookId, and userId are required.');
    }

    const res = await pgQuery(
      `INSERT INTO public.document_summaries (
         document_id, user_id, notebook_id, original_file_name, summary,
         page_count, file_size, source_chunk_count, generated_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (document_id) DO UPDATE SET
         summary = EXCLUDED.summary,
         page_count = EXCLUDED.page_count,
         file_size = EXCLUDED.file_size,
         source_chunk_count = EXCLUDED.source_chunk_count,
         generated_at = EXCLUDED.generated_at,
         updated_at = NOW()
       RETURNING *`,
      [
        docId,
        summary.userId,
        summary.notebookId,
        summary.originalFileName,
        summary.summary,
        summary.pageCount || 1,
        summary.fileSize || null,
        summary.sourceChunkCount || 0,
        summary.generatedAt,
      ]
    );
    const r = res.rows[0];
    return {
      documentId: r.document_id,
      userId: r.user_id,
      notebookId: r.notebook_id,
      originalFileName: r.original_file_name,
      summary: r.summary,
      pageCount: Number(r.page_count || 1),
      fileSize: r.file_size || undefined,
      generatedAt: r.generated_at,
      sourceChunkCount: Number(r.source_chunk_count || 0),
    };
  }

  async getDocumentSummary(documentId: string, userId?: string): Promise<DocumentSummaryRecord | undefined> {
    if (!isValidEntityId(documentId)) return undefined;
    const res = userId
      ? await pgQuery(`SELECT * FROM public.document_summaries WHERE document_id = $1 AND user_id = $2 LIMIT 1`, [
          documentId,
          userId,
        ])
      : await pgQuery(`SELECT * FROM public.document_summaries WHERE document_id = $1 LIMIT 1`, [documentId]);
    if (!res.rows[0]) return undefined;
    const r = res.rows[0];
    return {
      documentId: r.document_id,
      userId: r.user_id,
      notebookId: r.notebook_id,
      originalFileName: r.original_file_name,
      summary: r.summary,
      pageCount: Number(r.page_count || 1),
      fileSize: r.file_size || undefined,
      generatedAt: r.generated_at,
      sourceChunkCount: Number(r.source_chunk_count || 0),
    };
  }

  async getAllDocumentSummaries(notebookId: string, userId: string): Promise<DocumentSummaryRecord[]> {
    if (!isValidEntityId(notebookId) || !isValidEntityId(userId)) return [];
    const res = await pgQuery(
      `SELECT * FROM public.document_summaries WHERE notebook_id = $1 AND user_id = $2`,
      [notebookId, userId]
    );
    return res.rows.map((r) => ({
      documentId: r.document_id,
      userId: r.user_id,
      notebookId: r.notebook_id,
      originalFileName: r.original_file_name,
      summary: r.summary,
      pageCount: Number(r.page_count || 1),
      fileSize: r.file_size || undefined,
      generatedAt: r.generated_at,
      sourceChunkCount: Number(r.source_chunk_count || 0),
    }));
  }

  async saveChatSummary(summary: ChatSummaryRecord): Promise<ChatSummaryRecord> {
    if (!isValidEntityId(summary.notebookId) || !isValidEntityId(summary.userId)) {
      throw new Error('Valid notebookId and userId are required.');
    }

    const res = await pgQuery(
      `INSERT INTO public.chat_summaries (
         notebook_id, user_id, summary, generated_at, message_count, last_message_id, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (notebook_id) DO UPDATE SET
         summary = EXCLUDED.summary,
         generated_at = EXCLUDED.generated_at,
         message_count = EXCLUDED.message_count,
         last_message_id = EXCLUDED.last_message_id,
         updated_at = NOW()
       RETURNING *`,
      [
        summary.notebookId,
        summary.userId,
        summary.summary,
        summary.generatedAt,
        summary.messageCount || 0,
        summary.lastMessageId || null,
      ]
    );
    const r = res.rows[0];
    return {
      notebookId: r.notebook_id,
      userId: r.user_id,
      summary: r.summary,
      generatedAt: r.generated_at,
      messageCount: Number(r.message_count || 0),
      lastMessageId: r.last_message_id || undefined,
    };
  }

  async getChatSummary(notebookId: string, userId: string): Promise<ChatSummaryRecord | undefined> {
    if (!isValidEntityId(notebookId) || !isValidEntityId(userId)) return undefined;
    const res = await pgQuery(
      `SELECT * FROM public.chat_summaries WHERE notebook_id = $1 AND user_id = $2 LIMIT 1`,
      [notebookId, userId]
    );
    if (!res.rows[0]) return undefined;
    const r = res.rows[0];
    return {
      notebookId: r.notebook_id,
      userId: r.user_id,
      summary: r.summary,
      generatedAt: r.generated_at,
      messageCount: Number(r.message_count || 0),
      lastMessageId: r.last_message_id || undefined,
    };
  }

  async clearChatSummary(notebookId: string, userId: string): Promise<boolean> {
    if (!isValidEntityId(notebookId) || !isValidEntityId(userId)) return false;
    const res = await pgQuery(`DELETE FROM public.chat_summaries WHERE notebook_id = $1 AND user_id = $2`, [
      notebookId,
      userId,
    ]);
    return (res.rowCount || 0) > 0;
  }

  // ============================================================
  // EXAM RESULTS & RECENT ACTIVITY
  // ============================================================
  async saveExamResult(exam: ExamResultRecord): Promise<ExamResultRecord> {
    return withTransaction(async (client: PoolClient) => {
      await client.query(
        `INSERT INTO public.exam_results (
           id, user_id, notebook_id, notebook_title,
           total_questions, correct_count, incorrect_count, skipped_count,
           percentage, time_taken_seconds, topic_performance, strong_topics,
           weak_topics, recommendation, review_questions
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::jsonb)`,
        [
          exam.examId,
          exam.userId,
          exam.notebookId,
          exam.notebookTitle,
          exam.totalQuestions,
          exam.correctCount,
          exam.incorrectCount,
          exam.skippedCount,
          exam.percentage,
          exam.timeTakenSeconds,
          JSON.stringify(exam.topicPerformance || []),
          JSON.stringify(exam.strongTopics || []),
          JSON.stringify(exam.weakTopics || []),
          exam.recommendation || '',
          JSON.stringify(exam.reviewQuestions || []),
        ]
      );

      await client.query(
        `UPDATE public.notebooks
         SET progress = LEAST(100, GREATEST(progress, $3)),
             last_studied = 'Just now',
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [exam.notebookId, exam.userId, exam.percentage]
      );

      return exam;
    });
  }

  async getExamResults(userId: string): Promise<ExamResultRecord[]> {
    if (!isValidEntityId(userId)) return [];
    const res = await pgQuery(
      `SELECT * FROM public.exam_results WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return res.rows.map((r) => ({
      examId: r.id,
      userId: r.user_id,
      notebookId: r.notebook_id,
      notebookTitle: r.notebook_title,
      totalQuestions: Number(r.total_questions),
      correctCount: Number(r.correct_count),
      incorrectCount: Number(r.incorrect_count),
      skippedCount: Number(r.skipped_count),
      percentage: Number(r.percentage),
      timeTakenSeconds: Number(r.time_taken_seconds),
      topicPerformance: r.topic_performance || [],
      strongTopics: r.strong_topics || [],
      weakTopics: r.weak_topics || [],
      recommendation: r.recommendation || '',
      reviewQuestions: r.review_questions || [],
      createdAt: r.created_at,
    }));
  }

  async addActivity(item: RecentActivityRecord): Promise<RecentActivityRecord> {
    const id = item.id || `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const res = await pgQuery(
      `INSERT INTO public.recent_activity (id, user_id, type, title, subtitle, timestamp_label, score, notebook_title)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        item.userId,
        item.type,
        item.title,
        item.subtitle,
        item.timestamp || 'Just now',
        item.score || null,
        item.notebookTitle || 'Workspace',
      ]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      type: r.type,
      title: r.title,
      subtitle: r.subtitle,
      timestamp: r.timestamp_label,
      score: r.score || undefined,
      notebookTitle: r.notebook_title,
      createdAt: r.created_at,
    };
  }

  async getRecentActivity(userId: string, limit: number = 25): Promise<RecentActivityRecord[]> {
    if (!isValidEntityId(userId)) return [];
    const res = await pgQuery(
      `SELECT * FROM public.recent_activity WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, Math.max(1, Math.min(limit, 100))]
    );
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      type: r.type,
      title: r.title,
      subtitle: r.subtitle,
      timestamp: r.timestamp_label,
      score: r.score || undefined,
      notebookTitle: r.notebook_title,
      createdAt: r.created_at,
    }));
  }

  async clearRecentActivity(userId: string): Promise<void> {
    if (!isValidEntityId(userId)) return;
    await pgQuery(`DELETE FROM public.recent_activity WHERE user_id = $1`, [userId]);
  }

  async clearAllUserData(userId: string): Promise<string[]> {
    if (!isValidEntityId(userId)) return [];
    return withTransaction(async (client: PoolClient) => {
      const docsRes = await client.query<{ storage_path: string }>(
        `SELECT storage_path FROM public.documents WHERE user_id = $1`,
        [userId]
      );
      const storagePaths = docsRes.rows.map((r) => r.storage_path).filter(Boolean);

      await client.query(`DELETE FROM public.recent_activity WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM public.exam_results WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM public.notebooks WHERE user_id = $1`, [userId]);

      return storagePaths;
    });
  }
}

export const db = new PostgresDatabase();
