import path from 'path';
import { config } from '../config';
import { getSupabaseAdmin } from '../db/supabaseClient';

export interface StoredFileResult {
  storagePath: string;
  storageFileName: string;
}

export class StorageService {
  private readonly bucket = config.SUPABASE_STORAGE_BUCKET || 'studyai-documents';

  sanitizeFileName(originalFileName: string): string {
    const ext = path.extname(originalFileName).toLowerCase() || '.pdf';
    const base = path.basename(originalFileName, ext).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
    return `${base || 'document'}${ext}`;
  }

  validateFileMeta(fileName: string, mimeType: string, sizeBytes: number): void {
    const ext = path.extname(fileName).toLowerCase();
    const isExtensionValid = config.ALLOWED_EXTENSIONS.includes(ext);
    const isMimeValid =
      !mimeType ||
      mimeType === 'application/octet-stream' ||
      config.ALLOWED_MIME_TYPES.includes(mimeType) ||
      mimeType === 'application/pdf' ||
      mimeType.startsWith('text/') ||
      mimeType.startsWith('image/') ||
      mimeType === 'application/msword' ||
      mimeType.includes('wordprocessingml');

    if (!isExtensionValid || !isMimeValid) {
      throw new Error(
        `Unsupported document type. Supported formats: ${config.ALLOWED_EXTENSIONS.join(', ')}.`
      );
    }

    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error('Uploaded file is empty.');
    }

    if (sizeBytes > config.MAX_FILE_SIZE_BYTES) {
      throw new Error('File size exceeds the 25 MB limit.');
    }
  }

  async uploadBuffer(params: {
    userId: string;
    notebookId: string;
    documentId: string;
    originalFileName: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<StoredFileResult> {
    const { userId, notebookId, documentId, originalFileName, mimeType, buffer } = params;
    this.validateFileMeta(originalFileName, mimeType, buffer.length);

    const safeFileName = `${documentId}_${this.sanitizeFileName(originalFileName)}`;
    const storagePath = `${userId}/${notebookId}/${documentId}/${safeFileName}`;

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.from(this.bucket).upload(storagePath, buffer, {
      contentType: mimeType || 'application/octet-stream',
      upsert: false,
    });

    if (error) {
      throw new Error(`Failed to store document in private storage: ${error.message}`);
    }

    return {
      storagePath,
      storageFileName: safeFileName,
    };
  }

  async downloadBuffer(storagePath: string): Promise<Buffer> {
    if (!storagePath || storagePath.startsWith('legacy/')) {
      throw new Error('Original source binary is not stored in Supabase Storage for this migrated record.');
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(this.bucket).download(storagePath);

    if (error || !data) {
      throw new Error(`Failed to download document from private storage: ${error?.message || 'File not found'}`);
    }

    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async createSignedDownloadUrl(storagePath: string, expiresInSeconds: number = 60): Promise<string> {
    if (!storagePath || storagePath.startsWith('legacy/')) {
      throw new Error('No downloadable file exists in cloud storage for this legacy metadata record.');
    }

    const ttl = Math.max(15, Math.min(expiresInSeconds, 300));
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage
      .from(this.bucket)
      .createSignedUrl(storagePath, ttl, { download: true });

    if (error || !data?.signedUrl) {
      throw new Error(`Unable to generate secure download link: ${error?.message || 'Unknown error'}`);
    }

    return data.signedUrl;
  }

  async deleteObject(storagePath: string): Promise<void> {
    if (!storagePath || storagePath.startsWith('legacy/')) return;
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.from(this.bucket).remove([storagePath]);
    if (error) {
      console.warn(`[StorageService] Failed removing storage object ${storagePath}:`, error.message);
    }
  }
}

export const storageService = new StorageService();
