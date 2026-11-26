import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { documentsRouter } from './api/documentsRoutes';
import { chatRouter } from './api/chatRoutes';
import { summaryRouter } from './api/summaryRoutes';
import { workspaceRouter } from './api/workspaceRoutes';
import { jobsRouter } from './api/jobsRoutes';
import { getMissingServerEnvVars, isSupabaseBackendConfigured, testDatabaseConnection } from './db/supabaseClient';

export const app = express();

// Middleware (preserve rawBody for Upstash QStash webhook signature verification)
app.use(
  express.json({
    limit: '50mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString('utf-8');
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health Check (never exposes secrets)
app.get('/api/health', async (_req, res) => {
  const missingServerConfig = getMissingServerEnvVars();
  const configured = isSupabaseBackendConfigured();
  const dbCheck = configured ? await testDatabaseConnection() : { ok: false, pgvectorEnabled: false };

  res.json({
    status: 'ok',
    service: 'StudyAI - Persistent PostgreSQL, Storage & RAG Backend',
    supabaseConfigured: configured,
    missingServerConfig,
    databaseConnected: dbCheck.ok,
    pgvectorEnabled: dbCheck.pgvectorEnabled,
    timestamp: new Date().toISOString(),
  });
});

// Background Processing Queue Webhooks
app.use('/api/jobs', jobsRouter);

// Authenticated Workspace, RAG, Documents & Summary Routes
app.use('/api', workspaceRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/summary', summaryRouter);

// Download project source code zip endpoint
app.get('/api/download-zip', (_req, res) => {
  const zipPath = path.join(process.cwd(), 'public', 'study-ai-rag-project.zip');
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Project zip file not found' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="study-ai-rag-project.zip"');
  res.sendFile(zipPath);
});

// Fallback for unmatched /api/* routes
app.all('/api/*', (req, res) => {
  res.status(404).json({
    error: `API route ${req.method} ${req.path} not found`,
  });
});

// Global JSON error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('API Server error:', err);
  res.status(err.status || err.statusCode || 500).json({
    error: err.message || 'Internal server error processing request',
  });
});

export default app;
