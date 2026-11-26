import { db } from '../db/database';
import { RetrievalResult } from '../db/models';
import { embeddingService } from './embeddingService';
import { vectorStore, SearchOptions } from './vectorStore';

export class Retriever {
  async retrieveRelevantChunks(query: string, options: SearchOptions): Promise<RetrievalResult[]> {
    if (!query || !query.trim()) {
      return [];
    }

    let effectiveDocumentId = options.documentId;
    if (options.documentId) {
      const doc = await db.getDocument(options.documentId, options.userId);
      if (
        !doc ||
        doc.status !== 'COMPLETED' ||
        doc.userId !== options.userId ||
        (options.notebookId && doc.notebookId !== options.notebookId)
      ) {
        effectiveDocumentId = undefined;
      }
    }

    const queryVector = await embeddingService.embedQuery(query.trim());

    const results = await vectorStore.similaritySearch(queryVector, {
      ...options,
      documentId: effectiveDocumentId,
      queryText: query.trim(),
    });

    return results;
  }
}

export const retriever = new Retriever();
