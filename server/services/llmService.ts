import { ConstructedContext } from './contextBuilder';
import {
  AIServiceError,
  GEMINI_TEXT_MODELS,
  classifyGeminiError,
  getGeminiClientOrThrow,
} from './aiClient';

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMGenerationOptions {
  query: string;
  context: ConstructedContext;
  docName?: string;
  history?: ChatHistoryMessage[];
}

export interface LLMResponse {
  answer: string;
  isGrounded: boolean;
  insufficientInfo: boolean;
}

export class LLMService {
  private modelCooldowns: Map<string, number> = new Map();

  isGreeting(query: string): boolean {
    const q = query.trim().toLowerCase().replace(/[!?,.]/g, '');
    const greetings = [
      'hi', 'hello', 'hey', 'hiya', 'howdy', 'greetings', 'good morning',
      'good afternoon', 'good evening', 'whatsup', "what's up", 'hola',
      'namaste', 'start', 'help', 'who are you', 'how are you', 'hey there'
    ];
    return greetings.includes(q) || /^(hi|hello|hey|greetings)\b/i.test(q);
  }

  generateGreetingResponse(docName?: string): LLMResponse {
    const subjectNote = docName ? ` for **${docName}**` : '';
    return {
      answer: `Hello! I'm your AI Academic Study Tutor${subjectNote}.\n\nI am here to help you study your uploaded course materials, answer questions, explain difficult concepts, and prepare for your exams.\n\nFeel free to ask a question about the documents uploaded to this notebook!`,
      isGrounded: false,
      insufficientInfo: false,
    };
  }

  async generateGroundedAnswer(options: LLMGenerationOptions): Promise<LLMResponse> {
    const { query, context, docName, history } = options;

    if (this.isGreeting(query)) {
      return this.generateGreetingResponse(docName);
    }

    const hasContext = !!(context.contextString && context.contextString.trim().length > 0);
    if (!hasContext) {
      return {
        answer:
          'The uploaded documents in this notebook do not contain enough relevant information to answer this question. Try rephrasing your question or uploading additional study material covering this topic.',
        isGrounded: false,
        insufficientInfo: true,
      };
    }

    const client = getGeminiClientOrThrow();

    const systemInstruction =
      `You are an expert, evidence-based AI Academic Study Tutor.\n\n` +
      `STRICT GROUNDING PRINCIPLES:\n` +
      `1. USE ONLY PROVIDED NOTEBOOK EXCERPTS:\n` +
      `   - Answer strictly based on the [SUPPORTING COURSE DOCUMENT EXCERPTS] provided in the prompt.\n` +
      `   - Cite supporting facts naturally using document names and page numbers from the excerpts, e.g. [DocumentName, Page X].\n` +
      `   - Do NOT invent facts, formulas, examples, or citations that are not present in the excerpts.\n\n` +
      `2. HONESTY ON INSUFFICIENT INFORMATION:\n` +
      `   - If the provided excerpts do NOT contain enough information to answer the student's question, state clearly and directly: "The uploaded documents in this notebook do not contain enough information to answer this question."\n` +
      `   - If only part of the question is covered, answer only the covered portion with citations and explicitly identify what is missing from the uploaded documents.\n\n` +
      `3. STRUCTURE & CLARITY:\n` +
      `   - Begin directly with the answer—avoid filler intros.\n` +
      `   - Use clean markdown formatting: bold key terms, clear subheadings, bullet points, code blocks, or math notation where supported by the source.\n` +
      `   - Never mention internal pipeline terms like "chunks", "embeddings", "vector databases", "RAG", "similarity scores", or "Top-K".`;

    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    if (history && history.length > 0) {
      const recentHistory = history.slice(-8);
      for (const item of recentHistory) {
        if (item.content && item.content.trim()) {
          contents.push({
            role: item.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: item.content }],
          });
        }
      }
    }

    const currentTurnPrompt =
      `[SUPPORTING COURSE DOCUMENT EXCERPTS]\n` +
      `${context.contextString}\n\n` +
      `[STUDENT QUESTION]\n` +
      `${query}\n\n` +
      `Answer the student's question strictly using the excerpts above. Cite document names and page numbers from the excerpts. If the excerpts do not contain enough information, state that clearly without inventing information.`;

    contents.push({
      role: 'user',
      parts: [{ text: currentTurnPrompt }],
    });

    const now = Date.now();
    let lastError: AIServiceError | null = null;
    let sawModelAttempt = false;

    for (const modelName of GEMINI_TEXT_MODELS) {
      const cooldownUntil = this.modelCooldowns.get(modelName) || 0;
      if (now < cooldownUntil) {
        continue;
      }
      sawModelAttempt = true;

      try {
        const config: Record<string, any> = {
          systemInstruction,
          abortSignal: AbortSignal.timeout(25000),
        };
        if (modelName !== 'gemini-4-hydrogen') {
          config.temperature = 0.2;
        }

        const response: any = await client.models.generateContent({
          model: modelName,
          contents,
          config,
        });

        const text = response?.text || '';
        if (text.trim()) {
          const trimmed = text.trim();
          const lower = trimmed.toLowerCase();
          const indicatesInsufficient =
            lower.includes('do not contain enough information') ||
            lower.includes('do not contain information') ||
            lower.includes('not mentioned in the provided');

          return {
            answer: trimmed,
            isGrounded: !indicatesInsufficient,
            insufficientInfo: indicatesInsufficient,
          };
        }
      } catch (modelErr: any) {
        const classified = classifyGeminiError(modelErr);
        lastError = classified;

        // Fail immediately on invalid API key (won't succeed on fallback models)
        if (classified.code === 'GEMINI_API_KEY_INVALID') {
          throw classified;
        }

        const cooldownDuration =
          classified.code === 'GEMINI_RATE_LIMIT'
            ? 45000
            : classified.code === 'GEMINI_UNAVAILABLE'
            ? 15000
            : 10000;
        this.modelCooldowns.set(modelName, Date.now() + cooldownDuration);
      }
    }

    if (lastError) {
      throw lastError;
    }

    if (!sawModelAttempt) {
      throw new AIServiceError(
        'Gemini AI models are temporarily cooling down after recent errors. Please retry in a few seconds.',
        503,
        'GEMINI_RATE_LIMIT',
        true
      );
    }

    throw new AIServiceError(
      'Gemini returned an empty response. Please retry your question.',
      502,
      'GEMINI_UNAVAILABLE',
      true
    );
  }
}

export const llmService = new LLMService();
