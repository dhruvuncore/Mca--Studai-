# StudyAI — AI Student Learning & Exam Preparation Assistant (RAG Pipeline)

An intelligent full-stack Retrieval-Augmented Generation (RAG) platform tailored for students, MCA/B.Tech coursework, and academic exam preparation.

---

## 🌟 Key Features

1. **Multi-Format Document Ingestion & RAG Pipeline**:
   - Supports **PDF (.pdf)**, **Word Documents (.doc, .docx)**, **Handwritten Notes & Diagrams (PNG, JPG, WEBP)**, and **Text/Markdown (.txt, .md)**.
   - Page-by-page extraction, text cleaning, structural heading detection, and semantic chunking (500–800 tokens with 15% overlap).
   - High-precision OCR fallback powered by Gemini Vision for handwritten notebooks and scanned textbook diagrams.
   - Dense vector embeddings with hybrid search and dynamic thresholding.

2. **Interactive Study Notebooks**:
   - Organize materials by academic course modules (e.g., *MCA-201 DBMS*, *Operating Systems*, *Data Structures*).
   - Course cards with quick actions: "Let's Learn", practice tests, search filtering, and document counters.

3. **Grounded AI Academic Tutor**:
   - Multi-turn conversation strictly grounded in the student's uploaded notes, textbooks, and syllabus.
   - Precise academic citations: document name, page numbers, section headers, and confidence scores.

4. **Exam Generator & Testing Suite**:
   - Auto-generates MCQs, short answers, long-form theory questions, and viva voce flashcards directly from indexed notes.
   - Interactive timed exam mode with instant scoring, topic-by-topic diagnostic breakdown, and targeted revision recommendations.

5. **Smart Concept Summaries**:
   - High-yield chapter summaries, core architectural concepts, key bullet points, intuitive analogies, and critical exam topics.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS, Lucide Icons, Canvas Confetti, Recharts
- **Backend**: Node.js, Express, Multer
- **AI & RAG**: Google GenAI SDK (`@google/genai`, Gemini 3.8 Flash), Vector Store, Hybrid Retrieval
- **Document Parsers**: `mammoth` (DOCX), `word-extractor` (legacy DOC), `pdf-parse` (PDF)
- **Bundler & Tooling**: Vite 6, TSX, ESBuild

---

## 🚀 Quick Start Guide

### 1. Prerequisites
- Node.js (v18 or higher)
- npm or bun

### 2. Installation
```bash
# Clone or unzip the repository
cd study-ai-project

# Install all dependencies
npm install
```

### 3. Environment Setup
Copy the example environment file:
```bash
cp .env.example .env
```
Add your Gemini API Key to `.env`:
```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
PORT=3000
HOST=0.0.0.0
```

### 4. Running the Application
```bash
# Run development server (Frontend + Backend)
npm run dev
```
Open your browser at `http://localhost:3000`.

### 5. Production Build
```bash
# Build frontend and bundle server
npm run build

# Start production server
npm start
```

---

## 📂 Project Directory Structure

```
├── public/                 # Static assets & public downloads
├── server/
│   ├── api/
│   │   ├── chatRoutes.ts       # RAG chat & tutor endpoints
│   │   └── documentsRoutes.ts  # Document upload, status, metrics
│   ├── db/
│   │   ├── database.ts         # Persistent JSON document & chunk database
│   │   └── models.ts           # Schema models & TypeScript interfaces
│   ├── queue/
│   │   └── documentProcessor.ts# Background async ingestion pipeline
│   ├── services/
│   │   ├── chunker.ts          # Semantic chunking (500-800 tokens)
│   │   ├── chunkValidator.ts   # Boundary & token density validation
│   │   ├── embeddingService.ts # Vector embedding generation
│   │   ├── llmService.ts       # Gemini 3.8 Flash grounded prompt generation
│   │   ├── ocrService.ts       # Gemini Multimodal Vision for handwritten scans
│   │   ├── pdfExtractor.ts     # Multi-format parser (PDF, DOC, DOCX, Images)
│   │   ├── retriever.ts        # Hybrid retrieval (semantic vector + BM25 keyword)
│   │   ├── structureDetector.ts# Heading & section detection
│   │   ├── textCleaner.ts      # Header/footer artifact removal
│   │   └── vectorStore.ts      # Vector index & similarity search
│   └── config.ts               # Server & RAG configuration
├── src/
│   ├── components/             # React UI components (Dashboard, Workspace, Modals)
│   ├── services/
│   │   └── apiService.ts       # Client API and storage layer
│   ├── types.ts                # App TypeScript interfaces
│   ├── App.tsx                 # Main application controller & router
│   ├── main.tsx                # React entry point
│   └── index.css               # Tailwind CSS & theme tokens
├── package.json
├── server.ts                   # Express + Vite server entry
├── tsconfig.json
└── vite.config.ts
```

---

## 📜 License
MIT License. Created for student academic learning, research, and exam preparation.
