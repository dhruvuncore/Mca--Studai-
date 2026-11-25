import { config } from '../config';
import { CleanedPage, DocumentChunk } from '../db/models';
import { structureDetector } from './structureDetector';

interface PageSegment {
  text: string;
  pageNumber: number;
  method: 'text' | 'ocr';
  section: string;
  heading: string;
}

export class Chunker {
  /**
   * Structure-aware semantic chunking with exact page boundary tracking.
   * Preserves ~650 tokens chunk size and ~120 tokens overlap while guaranteeing
   * accurate pageStart and pageEnd across page transitions.
   */
  chunkPages(
    documentId: string,
    userId: string,
    notebookId: string,
    sourceDocName: string,
    pages: CleanedPage[]
  ): DocumentChunk[] {
    if (!documentId || documentId === 'undefined' || !userId || !notebookId) {
      throw new Error('Invalid documentId, userId, or notebookId provided to Chunker.');
    }

    const chunks: DocumentChunk[] = [];
    const maxChars = config.CHUNK_SIZE_TOKENS * 4; // ~2600 chars (~650 tokens)
    const overlapChars = config.CHUNK_OVERLAP_TOKENS * 4; // ~480 chars (~120 tokens)

    let currentSection = 'Introduction / Overview';
    let currentHeading = '';
    let bufferSegments: PageSegment[] = [];
    let bufferCharLength = 0;
    let chunkIndex = 1;

    const buildOverlapSegments = (segments: PageSegment[]): { overlapSegments: PageSegment[]; overlapLength: number } => {
      if (overlapChars <= 0 || segments.length === 0) {
        return { overlapSegments: [], overlapLength: 0 };
      }

      const collected: PageSegment[] = [];
      let remaining = overlapChars;

      for (let i = segments.length - 1; i >= 0 && remaining > 0; i--) {
        const seg = segments[i];
        if (seg.text.length <= remaining) {
          collected.unshift({ ...seg });
          remaining -= seg.text.length + 2; // account for '\n\n' joiner
        } else {
          let tail = seg.text.slice(-remaining);
          // Snap forward to a word boundary if slicing mid-word so overlap text stays clean
          const firstSpace = tail.search(/\s+/);
          if (firstSpace > 0 && firstSpace < tail.length - 20) {
            tail = tail.slice(firstSpace).trimStart();
          }
          if (tail.length > 0) {
            collected.unshift({
              ...seg,
              text: tail,
            });
          }
          remaining = 0;
        }
      }

      const overlapLength = collected.reduce(
        (sum, seg, idx) => sum + seg.text.length + (idx > 0 ? 2 : 0),
        0
      );
      return { overlapSegments: collected, overlapLength };
    };

    const flushBuffer = (createOverlap: boolean) => {
      if (bufferSegments.length === 0) return;

      const joinedText = bufferSegments.map((s) => s.text).join('\n\n').trim();
      if (!joinedText) {
        bufferSegments = [];
        bufferCharLength = 0;
        return;
      }

      const pageStart = bufferSegments[0].pageNumber;
      const pageEnd = bufferSegments[bufferSegments.length - 1].pageNumber;
      const chunkSection = bufferSegments[bufferSegments.length - 1].section || currentSection;
      const chunkHeading = bufferSegments[bufferSegments.length - 1].heading || chunkSection;
      const extractionMethod: 'text' | 'ocr' = bufferSegments.some((s) => s.method === 'ocr') ? 'ocr' : 'text';
      const chunkId = `${documentId}_chk_${chunkIndex.toString().padStart(4, '0')}`;

      chunks.push({
        id: chunkId,
        documentId,
        userId,
        notebookId,
        chunkIndex,
        pageStart,
        pageEnd: Math.max(pageStart, pageEnd),
        section: chunkSection,
        heading: chunkHeading,
        text: joinedText,
        tokenEstimate: Math.ceil(joinedText.length / 4),
        extractionMethod,
        sourceDocName,
      });

      chunkIndex++;

      if (createOverlap) {
        const { overlapSegments, overlapLength } = buildOverlapSegments(bufferSegments);
        bufferSegments = overlapSegments;
        bufferCharLength = overlapLength;
      } else {
        bufferSegments = [];
        bufferCharLength = 0;
      }
    };

    for (const page of pages) {
      const pageText = page.cleanedText;
      if (!pageText || !pageText.trim()) continue;

      const paragraphs = pageText.split(/\n{2,}/);

      for (const para of paragraphs) {
        const trimmedPara = para.trim();
        if (!trimmedPara) continue;

        // Flush previous chunk BEFORE applying new paragraph's section/heading metadata
        if (
          bufferSegments.length > 0 &&
          bufferCharLength + 2 + trimmedPara.length > maxChars &&
          bufferCharLength >= config.MIN_CHUNK_CHAR_LENGTH * 3
        ) {
          flushBuffer(true);
        }

        // Update section / heading from the new paragraph
        const firstLine = trimmedPara.split('\n')[0];
        const struct = structureDetector.detectLineStructure(firstLine);

        if (struct.type === 'section') {
          currentSection = struct.title;
          currentHeading = struct.title;
        } else if (struct.type === 'heading' || struct.type === 'definition') {
          currentHeading = struct.title;
        }

        // If a single paragraph is vastly larger than maxChars, split on sentence/line boundaries
        // while preserving the exact pageNumber on each split piece
        if (trimmedPara.length > maxChars) {
          const pieces = trimmedPara.match(new RegExp(`[\\s\\S]{1,${maxChars}}(?=\\s|$)|[\\s\\S]{1,${maxChars}}`, 'g')) || [
            trimmedPara,
          ];
          for (const piece of pieces) {
            const cleanPiece = piece.trim();
            if (!cleanPiece) continue;
            if (
              bufferSegments.length > 0 &&
              bufferCharLength + 2 + cleanPiece.length > maxChars &&
              bufferCharLength >= config.MIN_CHUNK_CHAR_LENGTH * 3
            ) {
              flushBuffer(true);
            }
            bufferSegments.push({
              text: cleanPiece,
              pageNumber: page.pageNumber,
              method: page.extractionMethod,
              section: currentSection,
              heading: currentHeading || currentSection,
            });
            bufferCharLength += (bufferSegments.length > 1 ? 2 : 0) + cleanPiece.length;
          }
        } else {
          bufferSegments.push({
            text: trimmedPara,
            pageNumber: page.pageNumber,
            method: page.extractionMethod,
            section: currentSection,
            heading: currentHeading || currentSection,
          });
          bufferCharLength += (bufferSegments.length > 1 ? 2 : 0) + trimmedPara.length;
        }
      }
    }

    // Flush remaining buffer
    const remainingText = bufferSegments.map((s) => s.text).join('\n\n').trim();
    if (remainingText.length >= config.MIN_CHUNK_CHAR_LENGTH) {
      flushBuffer(false);
    }

    return chunks;
  }
}

export const chunker = new Chunker();
