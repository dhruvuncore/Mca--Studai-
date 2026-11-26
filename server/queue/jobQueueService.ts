import { Client, Receiver } from '@upstash/qstash';
import { config } from '../config';
import { db } from '../db/database';
import { DocumentRecord } from '../db/models';
import { documentProcessor } from './documentProcessor';

export interface QueueDispatchResult {
  provider: 'qstash' | 'inline' | 'local';
  completedSynchronously: boolean;
  qstashMessageId?: string;
}

export function isQStashDispatchEnabled(): boolean {
  const url = config.APP_URL;
  return Boolean(
    config.QSTASH_TOKEN &&
      url &&
      url.startsWith('https://') &&
      !url.includes('localhost') &&
      !url.includes('127.0.0.1')
  );
}

export function getQStashReceiver(): Receiver | null {
  if (!config.QSTASH_CURRENT_SIGNING_KEY) return null;
  return new Receiver({
    currentSigningKey: config.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: config.QSTASH_NEXT_SIGNING_KEY || config.QSTASH_CURRENT_SIGNING_KEY,
  });
}

export class JobQueueService {
  /**
   * Dispatches a document ingestion job reliably:
   * 1. On Vercel/Production with Upstash QStash configured -> publishes signed webhook job to QStash (3 retries).
   * 2. On Vercel without QStash -> processes synchronously inside the request so serverless termination never drops work.
   * 3. On persistent local Node server without QStash -> executes managed async job tracked in `processing_jobs`.
   */
  async dispatchDocumentJob(doc: DocumentRecord, jobId: string): Promise<QueueDispatchResult> {
    if (isQStashDispatchEnabled()) {
      const client = new Client({ token: config.QSTASH_TOKEN });
      const callbackUrl = `${config.APP_URL.replace(/\/$/, '')}/api/jobs/process-document`;

      const published = await client.publishJSON({
        url: callbackUrl,
        body: {
          documentId: doc.id,
          jobId,
          userId: doc.userId,
          notebookId: doc.notebookId,
        },
        retries: 3,
      });

      const msgId = (published as any)?.messageId;
      await db.updateJobProviderRef(jobId, 'qstash', msgId);
      return {
        provider: 'qstash',
        completedSynchronously: false,
        qstashMessageId: msgId,
      };
    }

    if (process.env.VERCEL) {
      await db.updateJobProviderRef(jobId, 'inline');
      await documentProcessor.processDocument(doc.id);
      return {
        provider: 'inline',
        completedSynchronously: true,
      };
    }

    // Local persistent Node process (non-serverless)
    await db.updateJobProviderRef(jobId, 'local');
    Promise.resolve().then(() =>
      documentProcessor.processDocument(doc.id).catch((err) => {
        console.error(`[JobQueueService] Local background job failed for ${doc.id}:`, err);
      })
    );

    return {
      provider: 'local',
      completedSynchronously: false,
    };
  }
}

export const jobQueueService = new JobQueueService();
