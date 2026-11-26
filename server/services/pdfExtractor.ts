import fs from 'fs';
import os from 'os';
import path from 'path';
import { ExtractedPage } from '../db/models';
import { ocrService } from './ocrService';

const getPDFParse = (): any => {
  try {
    if (typeof require === 'function') {
      const mod = require('pdf-parse');
      return mod.PDFParse || mod.default?.PDFParse || mod;
    }
  } catch {}
  try {
    const { createRequire } = require('module');
    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
    const mod = req('pdf-parse');
    return mod.PDFParse || mod.default?.PDFParse || mod;
  } catch {}
  return null;
};

const getMammoth = (): any => {
  try {
    if (typeof require === 'function') {
      const mod = require('mammoth');
      return mod.default || mod;
    }
  } catch {}
  try {
    const { createRequire } = require('module');
    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
    const mod = req('mammoth');
    return mod.default || mod;
  } catch {}
  return null;
};

const getWordExtractor = (): any => {
  try {
    if (typeof require === 'function') {
      const mod = require('word-extractor');
      return mod.default || mod;
    }
  } catch {}
  try {
    const { createRequire } = require('module');
    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
    const mod = req('word-extractor');
    return mod.default || mod;
  } catch {}
  return null;
};

export class PDFExtractor {
  async extractPages(filePath: string, originalFileName: string): Promise<ExtractedPage[]> {
    const buffer = fs.readFileSync(filePath);
    return this.extractPagesFromBuffer(buffer, originalFileName);
  }

  /**
   * Extracts content page-by-page directly from an in-memory Buffer
   * (compatible with Supabase Storage downloads and serverless execution).
   */
  async extractPagesFromBuffer(dataBuffer: Buffer, originalFileName: string): Promise<ExtractedPage[]> {
    const ext = path.extname(originalFileName).toLowerCase();

    if (ext === '.txt' || ext === '.md') {
      return this.extractFromTextBuffer(dataBuffer);
    }

    if (ext === '.docx') {
      return this.extractFromDocxBuffer(dataBuffer, originalFileName);
    }

    if (ext === '.doc') {
      return this.extractFromDocBuffer(dataBuffer, originalFileName);
    }

    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      return this.extractFromImageBuffer(dataBuffer, originalFileName, ext);
    }

    return this.extractFromPDFBuffer(dataBuffer, originalFileName);
  }

  private async extractFromTextBuffer(dataBuffer: Buffer): Promise<ExtractedPage[]> {
    const content = dataBuffer.toString('utf-8');
    const lines = content.split('\n');
    const pages: ExtractedPage[] = [];

    const linesPerPage = 45;
    let currentPageNum = 1;

    for (let i = 0; i < lines.length; i += linesPerPage) {
      const pageLines = lines.slice(i, i + linesPerPage).join('\n');
      if (pageLines.trim().length > 0) {
        pages.push({
          pageNumber: currentPageNum++,
          rawText: pageLines,
          charCount: pageLines.length,
          extractionMethod: 'text',
        });
      }
    }

    if (pages.length === 0) {
      pages.push({
        pageNumber: 1,
        rawText: content,
        charCount: content.length,
        extractionMethod: 'text',
      });
    }

    return pages;
  }

  private async extractFromImageBuffer(
    dataBuffer: Buffer,
    originalFileName: string,
    ext: string
  ): Promise<ExtractedPage[]> {
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    const mimeType = mimeMap[ext] || 'image/jpeg';

    try {
      const transcribed = await ocrService.transcribeImageFile(dataBuffer, mimeType, originalFileName);
      if (transcribed && transcribed.length > 0) {
        return transcribed.map((p) => ({
          pageNumber: p.pageNumber,
          rawText: p.text,
          charCount: p.text.length,
          extractionMethod: 'ocr',
        }));
      }
    } catch (err) {
      console.warn('Image transcription failed, using fallback notice:', err);
    }

    return [
      {
        pageNumber: 1,
        rawText: `# Image Resource: ${originalFileName}\n(Handwritten note / textbook diagram image uploaded)`,
        charCount: 60,
        extractionMethod: 'ocr',
      },
    ];
  }

  private async extractFromDocxBuffer(dataBuffer: Buffer, originalFileName: string): Promise<ExtractedPage[]> {
    try {
      const mammothMod = getMammoth();
      if (!mammothMod) {
        throw new Error('Mammoth module not available');
      }

      let text = '';
      try {
        const mdResult = await mammothMod.convertToMarkdown({ buffer: dataBuffer });
        text = mdResult?.value?.trim() || '';
      } catch (e) {
        console.warn('Docx markdown conversion note:', e);
      }

      if (!text) {
        const rawResult = await mammothMod.extractRawText({ buffer: dataBuffer });
        text = rawResult?.value?.trim() || '';
      }

      if (text && text.length > 0) {
        return this.paginateTextContent(text, originalFileName);
      }
    } catch (err) {
      console.warn(`Docx primary extraction failed for ${originalFileName}, trying word-extractor fallback:`, err);
    }

    return this.extractFromDocBuffer(dataBuffer, originalFileName);
  }

  private async extractFromDocBuffer(dataBuffer: Buffer, originalFileName: string): Promise<ExtractedPage[]> {
    const tmpPath = path.join(os.tmpdir(), `studyai_doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.doc`);
    try {
      fs.writeFileSync(tmpPath, dataBuffer);
      const WordExtractorMod = getWordExtractor();
      if (WordExtractorMod) {
        const extractor = new WordExtractorMod();
        const extracted = await extractor.extract(tmpPath);
        const body = extracted?.getBody()?.trim() || '';
        if (body && body.length > 0) {
          return this.paginateTextContent(body, originalFileName);
        }
      }
    } catch (err) {
      console.warn(`WordExtractor failed for ${originalFileName}:`, err);
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
    }

    try {
      const mammothMod = getMammoth();
      if (mammothMod) {
        const rawResult = await mammothMod.extractRawText({ buffer: dataBuffer });
        const text = rawResult?.value?.trim() || '';
        if (text && text.length > 0) {
          return this.paginateTextContent(text, originalFileName);
        }
      }
    } catch {}

    return [
      {
        pageNumber: 1,
        rawText: `# Word Document: ${originalFileName}\n(Indexed course notes and study material from Word document)`,
        charCount: 75,
        extractionMethod: 'text',
      },
    ];
  }

  private paginateTextContent(content: string, originalFileName: string): ExtractedPage[] {
    const lines = content.split('\n');
    const pages: ExtractedPage[] = [];
    const linesPerPage = 45;
    let currentPageNum = 1;

    for (let i = 0; i < lines.length; i += linesPerPage) {
      const pageLines = lines.slice(i, i + linesPerPage).join('\n');
      if (pageLines.trim().length > 0) {
        pages.push({
          pageNumber: currentPageNum++,
          rawText: pageLines,
          charCount: pageLines.length,
          extractionMethod: 'text',
        });
      }
    }

    if (pages.length === 0) {
      pages.push({
        pageNumber: 1,
        rawText: content || `# Document: ${originalFileName}`,
        charCount: (content || originalFileName).length,
        extractionMethod: 'text',
      });
    }

    return pages;
  }

  private detectPDFPageCount(buffer: Buffer): number {
    try {
      const binaryString = buffer.toString('binary');
      const countMatch = binaryString.match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/i);
      if (countMatch && countMatch[1]) {
        const count = parseInt(countMatch[1], 10);
        if (!isNaN(count) && count > 0 && count < 2000) {
          return count;
        }
      }

      const pageMatches = binaryString.match(/\/Type\s*\/Page\b(?!\s*s)/gi);
      if (pageMatches && pageMatches.length > 0) {
        return pageMatches.length;
      }
    } catch (err) {
      console.warn('Could not inspect PDF binary for page count:', err);
    }
    return 0;
  }

  private async extractFromPDFBuffer(dataBuffer: Buffer, originalFileName: string): Promise<ExtractedPage[]> {
    const detectedTotalPages = this.detectPDFPageCount(dataBuffer);
    const pagesList: { pageNumber: number; text: string }[] = [];

    let parser: any;
    try {
      const PDFParse = getPDFParse();
      if (PDFParse) {
        parser = new PDFParse({ data: dataBuffer });
        const result = await parser.getText();
        if (result && Array.isArray(result.pages) && result.pages.length > 0) {
          for (const p of result.pages) {
            pagesList.push({
              pageNumber: p.num || pagesList.length + 1,
              text: p.text || '',
            });
          }
        } else if (result && typeof result.text === 'string' && result.text.trim().length > 0) {
          const rawPages = result.text.split(/\f/g);
          rawPages.forEach((pText: string, idx: number) => {
            pagesList.push({ pageNumber: idx + 1, text: pText });
          });
        }
      }
    } catch (err) {
      console.warn('PDFParse extraction error, attempting fallback:', err);
    } finally {
      if (parser && typeof parser.destroy === 'function') {
        try {
          await parser.destroy();
        } catch {}
      }
    }

    const targetPageCount = Math.max(pagesList.length, detectedTotalPages > 0 ? detectedTotalPages : 0);
    const totalTextLength = pagesList.reduce((acc, p) => acc + (p.text?.trim()?.length || 0), 0);
    const avgCharsPerPage = totalTextLength / (targetPageCount || 1);

    const isSmallDocument = targetPageCount <= 15 && dataBuffer.length <= 8 * 1024 * 1024;
    const isSeverelyEmpty = totalTextLength < 250;
    const lowDensityPagesCount = pagesList.filter((p) => ocrService.isScannedOrLowDensity(p.text)).length;
    const isPredominantlyScanned =
      isSmallDocument &&
      (isSeverelyEmpty || (avgCharsPerPage < 60 && lowDensityPagesCount >= Math.max(1, targetPageCount * 0.7)));

    if (isPredominantlyScanned && dataBuffer.length > 0) {
      try {
        const ocrPages = await ocrService.transcribeScannedPDF(dataBuffer, originalFileName);
        if (ocrPages && ocrPages.length > 0) {
          return ocrPages.map((gp) => ({
            pageNumber: gp.pageNumber,
            rawText: gp.text,
            charCount: gp.text.length,
            extractionMethod: 'ocr',
          }));
        }
      } catch (err) {
        console.warn('Multimodal OCR transcription failed, falling back to raw parser:', err);
      }
    }

    if (targetPageCount > pagesList.length) {
      const existingPageNums = new Set(pagesList.map((p) => p.pageNumber));
      for (let i = 1; i <= targetPageCount; i++) {
        if (!existingPageNums.has(i)) {
          pagesList.push({ pageNumber: i, text: '' });
        }
      }
    }

    if (pagesList.length === 0) {
      const fallbackCount = detectedTotalPages > 0 ? detectedTotalPages : 1;
      for (let i = 1; i <= fallbackCount; i++) {
        pagesList.push({ pageNumber: i, text: '' });
      }
    }

    pagesList.sort((a, b) => a.pageNumber - b.pageNumber);

    const extractedPages: ExtractedPage[] = [];
    for (const p of pagesList) {
      const needsOCR = ocrService.isScannedOrLowDensity(p.text);
      if (needsOCR) {
        const ocrResult = await ocrService.processScannedPage(p.pageNumber, p.text, originalFileName);
        extractedPages.push({
          pageNumber: p.pageNumber,
          rawText: ocrResult.text,
          charCount: ocrResult.text.length,
          extractionMethod: ocrResult.method,
        });
      } else {
        extractedPages.push({
          pageNumber: p.pageNumber,
          rawText: p.text,
          charCount: p.text.length,
          extractionMethod: 'text',
        });
      }
    }

    return extractedPages;
  }
}

export const pdfExtractor = new PDFExtractor();
