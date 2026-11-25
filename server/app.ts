import express from 'express';
import path from 'path';
import fs from 'fs';
import { documentsRouter } from './api/documentsRoutes';
import { chatRouter } from './api/chatRoutes';
import { summaryRouter } from './api/summaryRoutes';

export const app = express();

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AI Student Learning & Exam Assistant - RAG Pipeline',
    timestamp: new Date().toISOString(),
  });
});

// Primary API Routes
app.use('/api/documents', documentsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/summary', summaryRouter);

// Download project source code zip endpoint
app.get('/api/download-zip', (req, res) => {
  const zipPath = path.join(process.cwd(), 'public', 'study-ai-rag-project.zip');
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Project zip file not found' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="study-ai-rag-project.zip"');
  res.sendFile(zipPath);
});

// Fallback for unmatched /api/* routes - guarantees API requests never return HTML from Vite SPA
app.all('/api/*', (req, res) => {
  res.status(404).json({
    error: `API route ${req.method} ${req.path} not found`,
  });
});

// Global error handler for API requests - always respond with JSON
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('API Server error:', err);
  res.status(err.status || err.statusCode || 500).json({
    error: err.message || 'Internal server error processing document request',
  });
});

export default app;
