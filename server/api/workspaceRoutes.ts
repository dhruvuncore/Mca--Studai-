import express, { Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../middleware/authMiddleware';
import { db, isValidEntityId } from '../db/database';
import { getSupabaseAdmin } from '../db/supabaseClient';
import { storageService } from '../services/storageService';

export const workspaceRouter = express.Router();
workspaceRouter.use(requireAuth);

// ============================================================================
// AUTH PROFILE ROUTES (/api/auth/me)
// ============================================================================

workspaceRouter.get('/auth/me', async (req: AuthenticatedRequest, res: Response) => {
  return res.json({ profile: req.user });
});

workspaceRouter.put('/auth/me', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, degree, semester, university, avatar } = req.body || {};

    const cleanName = typeof name === 'string' && name.trim() ? name.trim() : undefined;
    const computedAvatar =
      typeof avatar === 'string' && avatar.trim()
        ? avatar.trim().slice(0, 2).toUpperCase()
        : cleanName
        ? cleanName
            .split(' ')
            .filter(Boolean)
            .map((p: string) => p[0])
            .join('')
            .slice(0, 2)
            .toUpperCase()
        : undefined;

    const updated = await db.updateUserProfile(userId, {
      name: cleanName,
      degree: typeof degree === 'string' ? degree.trim() : undefined,
      semester: typeof semester === 'string' ? semester.trim() : undefined,
      university: typeof university === 'string' ? university.trim() : undefined,
      avatar: computedAvatar,
    });

    if (!updated) {
      return res.status(404).json({ error: 'Student profile not found.' });
    }

    // Best-effort sync to Supabase Auth user_metadata
    try {
      const supabaseAdmin = getSupabaseAdmin();
      await supabaseAdmin.auth.admin.updateUserById(userId, {
        user_metadata: {
          name: updated.name,
          degree: updated.degree,
          semester: updated.semester,
          university: updated.university,
          avatar: updated.avatar,
        },
      });
    } catch (syncErr) {
      console.warn('[Workspace] Non-fatal Auth metadata sync warning:', syncErr);
    }

    return res.json({ profile: updated });
  } catch (err: any) {
    console.error('Update profile error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to update profile.' });
  }
});

// ============================================================================
// NOTEBOOKS ROUTES (/api/notebooks)
// ============================================================================

workspaceRouter.get('/notebooks', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const notebooks = await db.getNotebooks(userId);
    return res.json({ notebooks });
  } catch (err: any) {
    console.error('List notebooks error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to load notebooks.' });
  }
});

workspaceRouter.post('/notebooks', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { title, code, description, iconName, accentColor } = req.body || {};

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Notebook title is required.' });
    }

    const existing = await db.getNotebooks(userId);
    const defaultCode = `MCA-${200 + existing.length + 1}`;

    const created = await db.createNotebook(userId, {
      title: title.trim(),
      code: typeof code === 'string' && code.trim() ? code.trim() : defaultCode,
      description:
        typeof description === 'string' && description.trim()
          ? description.trim()
          : 'Custom study notebook for course preparation.',
      iconName: typeof iconName === 'string' ? iconName : 'BookOpen',
      accentColor: typeof accentColor === 'string' ? accentColor : '#2563EB',
    });

    await db.addActivity({
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId,
      type: 'document',
      title: `Created notebook: ${created.title}`,
      subtitle: 'Ready for PDF source upload and AI indexing',
      timestamp: 'Just now',
      notebookTitle: created.title,
    });

    return res.status(201).json({
      notebook: {
        ...created,
        documentsCount: 0,
        documents: [],
      },
    });
  } catch (err: any) {
    console.error('Create notebook error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to create notebook.' });
  }
});

workspaceRouter.delete('/notebooks/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    if (!isValidEntityId(id)) {
      return res.status(400).json({ error: 'Valid notebook ID is required.' });
    }

    const result = await db.deleteNotebook(id, userId);
    if (!result.deleted) {
      return res.status(404).json({ error: 'Notebook not found.' });
    }

    for (const storagePath of result.storagePaths) {
      await storageService.deleteObject(storagePath);
    }

    await db.addActivity({
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId,
      type: 'document',
      title: `Deleted notebook "${result.title || 'Course'}"`,
      subtitle: 'All documents and study data cleared',
      timestamp: 'Just now',
      notebookTitle: result.title || 'Course',
    });

    return res.json({ success: true });
  } catch (err: any) {
    console.error('Delete notebook error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to delete notebook.' });
  }
});

// ============================================================================
// CHAT MESSAGES PERSISTENCE (/api/notebooks/:id/messages)
// ============================================================================

workspaceRouter.get('/notebooks/:id/messages', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const nb = await db.getNotebook(id, userId);
    if (!nb) {
      return res.status(404).json({ error: 'Notebook not found.' });
    }
    const messages = await db.getChatMessages(id, userId);
    return res.json({ messages });
  } catch (err: any) {
    console.error('Get chat messages error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to fetch chat history.' });
  }
});

workspaceRouter.post('/notebooks/:id/messages', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const nb = await db.getNotebook(id, userId);
    if (!nb) {
      return res.status(404).json({ error: 'Notebook not found.' });
    }

    const { message } = req.body || {};
    if (!message || typeof message.text !== 'string' || !message.text.trim()) {
      return res.status(400).json({ error: 'Message text is required.' });
    }

    const sender = message.sender === 'ai' ? 'ai' : 'user';
    const msgId = isValidEntityId(message.id)
      ? message.id
      : `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const saved = await db.saveChatMessage({
      id: msgId,
      userId,
      notebookId: id,
      sender,
      text: message.text,
      timestamp:
        typeof message.timestamp === 'string' && message.timestamp.trim()
          ? message.timestamp
          : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      sourceReferences: Array.isArray(message.sourceReferences) ? message.sourceReferences : [],
      isGrounded: Boolean(message.isGrounded),
      retrievalScore: Number(message.retrievalScore || 0),
      insufficientInfo: Boolean(message.insufficientInfo),
    });

    return res.status(201).json({ message: saved });
  } catch (err: any) {
    console.error('Save chat message error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to save chat message.' });
  }
});

workspaceRouter.delete('/notebooks/:id/messages', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const nb = await db.getNotebook(id, userId);
    if (!nb) {
      return res.status(404).json({ error: 'Notebook not found.' });
    }
    await db.clearChatMessages(id, userId);
    await db.clearChatSummary(id, userId);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('Clear chat messages error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to clear chat history.' });
  }
});

// ============================================================================
// EXAM RESULTS (/api/exams)
// ============================================================================

workspaceRouter.get('/exams', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const exams = await db.getExamResults(userId);
    return res.json({ exams });
  } catch (err: any) {
    console.error('List exams error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to fetch exam results.' });
  }
});

workspaceRouter.post('/exams', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = req.body || {};
    if (!isValidEntityId(body.notebookId)) {
      return res.status(400).json({ error: 'Valid notebookId is required.' });
    }

    const nb = await db.getNotebook(body.notebookId, userId);
    if (!nb) {
      return res.status(404).json({ error: 'Notebook not found.' });
    }

    const saved = await db.saveExamResult({
      examId: isValidEntityId(body.examId) ? body.examId : `exam_${Date.now()}`,
      userId,
      notebookId: nb.id,
      notebookTitle: body.notebookTitle || nb.title,
      totalQuestions: Number(body.totalQuestions || 0),
      correctCount: Number(body.correctCount || 0),
      incorrectCount: Number(body.incorrectCount || 0),
      skippedCount: Number(body.skippedCount || 0),
      percentage: Math.max(0, Math.min(100, Number(body.percentage || 0))),
      timeTakenSeconds: Number(body.timeTakenSeconds || 0),
      topicPerformance: Array.isArray(body.topicPerformance) ? body.topicPerformance : [],
      strongTopics: Array.isArray(body.strongTopics) ? body.strongTopics : [],
      weakTopics: Array.isArray(body.weakTopics) ? body.weakTopics : [],
      recommendation: typeof body.recommendation === 'string' ? body.recommendation : '',
      reviewQuestions: Array.isArray(body.reviewQuestions) ? body.reviewQuestions : [],
    });

    await db.addActivity({
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId,
      type: 'exam',
      title: `Completed ${nb.title} Practice Test`,
      subtitle: `Score: ${saved.correctCount} / ${saved.totalQuestions} (${saved.percentage}%) • Time: ${Math.floor(
        saved.timeTakenSeconds / 60
      )}m ${saved.timeTakenSeconds % 60}s`,
      timestamp: 'Just now',
      score: `${saved.percentage}%`,
      notebookTitle: nb.title,
    });

    return res.status(201).json({ exam: saved });
  } catch (err: any) {
    console.error('Save exam error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to save exam result.' });
  }
});

// ============================================================================
// RECENT ACTIVITY (/api/activity)
// ============================================================================

workspaceRouter.get('/activity', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const activity = await db.getRecentActivity(userId);
    return res.json({ activity });
  } catch (err: any) {
    console.error('Get activity error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to load recent activity.' });
  }
});

workspaceRouter.delete('/activity', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    await db.clearRecentActivity(userId);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('Clear activity error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to clear activity.' });
  }
});
