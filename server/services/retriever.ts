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
      const doc = db.getDocument(options.documentId);
      if (
        !doc ||
        doc.status !== 'COMPLETED' ||
        doc.userId !== options.userId ||
        (options.notebookId && doc.notebookId !== options.notebookId)
      ) {
        effectiveDocumentId = undefined;
      }
    }

    // Query Embedding
    const queryVector = await embeddingService.embedQuery(query.trim());

    // Hybrid similarity search strictly scoped to user & notebook
    const results = vectorStore.similaritySearch(queryVector, {
      ...options,
      documentId: effectiveDocumentId,
      queryText: query.trim(),
    });

    return results;
  }
}

export const retriever = new Retriever();
