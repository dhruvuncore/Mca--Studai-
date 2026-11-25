import React, { useState, useEffect } from 'react';
import {
  X,
  Sparkles,
  FileText,
  Copy,
  Check,
  RefreshCw,
  Download,
  UploadCloud,
  MessageSquare,
  FileSpreadsheet,
  AlertCircle,
  Calendar,
  Layers,
  CheckCircle2,
  BookOpen,
  ArrowRight,
  ExternalLink,
} from 'lucide-react';
import Markdown from 'react-markdown';
import { Notebook, DocumentItem, NotebookChatSummary, DocumentSummary, ChatMessage } from '../types';
import { apiService } from '../services/apiService';

interface SmartSummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  notebook: Notebook;
  onOpenUploadModal?: () => void;
  onShowToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export const SmartSummaryModal: React.FC<SmartSummaryModalProps> = ({
  isOpen,
  onClose,
  notebook,
  onOpenUploadModal,
  onShowToast,
}) => {
  // Navigation tabs: 'all' (both sections), 'chat' (Chat Summary), 'pdfs' (PDF Summaries)
  const [activeTab, setActiveTab] = useState<'all' | 'chat' | 'pdfs'>('all');

  // Chat summary state
  const [chatSummary, setChatSummary] = useState<NotebookChatSummary | null>(null);
  const [isGeneratingChat, setIsGeneratingChat] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  // Per-document summaries state
  const [docSummaries, setDocSummaries] = useState<Record<string, DocumentSummary>>({});
  const [generatingDocIds, setGeneratingDocIds] = useState<Record<string, boolean>>({});

  // Copy indicator state
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Load chat and summaries when modal opens or notebook changes
  useEffect(() => {
    if (!isOpen || !notebook) return;

    setChatError(null);

    // Load chat messages for the current notebook
    const messages = apiService.getChatMessages(notebook.id);
    setChatMessages(messages);

    // 1. Load Chat Summary
    const cachedChat = apiService.getNotebookChatSummary(notebook.id);
    if (cachedChat) {
      setChatSummary(cachedChat);
    } else if (messages.length > 0) {
      // Auto-generate if conversations exist and no summary has been created yet
      handleGenerateChatSummary(false, messages);
    } else {
      setChatSummary({
        notebookId: notebook.id,
        notebookTitle: notebook.title,
        summary: `> **No Chat History Available**\n\nYou haven't started a conversation in **${notebook.title}** yet. Ask questions in the AI Tutor chat workspace to build your study dialogue, and generate a comprehensive conversation summary anytime!`,
        generatedAt: new Date().toLocaleString(),
        messageCount: 0,
        hasChat: false,
      });
    }

    // 2. Load Document Summaries from localStorage
    const cachedDocs = apiService.getAllDocumentSummaries(notebook.id);
    setDocSummaries(cachedDocs);

    // 3. Sync from backend summaries API for fresh data
    const uid = apiService.getActiveUserId();
    const userQuery = uid && uid !== 'guest' ? `?userId=${encodeURIComponent(uid)}` : '';
    fetch(`/api/summary/notebook/${encodeURIComponent(notebook.id)}${userQuery}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        if (data.chatSummary && (!cachedChat || new Date(data.chatSummary.generatedAt) > new Date(cachedChat.generatedAt))) {
          const syncedChat: NotebookChatSummary = {
            notebookId: notebook.id,
            notebookTitle: notebook.title,
            summary: data.chatSummary.summary,
            generatedAt: data.chatSummary.generatedAt,
            messageCount: data.chatSummary.messageCount || messages.length,
            hasChat: true,
          };
          setChatSummary(syncedChat);
          apiService.saveNotebookChatSummary(syncedChat);
        }
        if (Array.isArray(data.documentSummaries) && data.documentSummaries.length > 0) {
          setDocSummaries((prev) => {
            const updated = { ...prev };
            data.documentSummaries.forEach((d: any) => {
              updated[d.documentId] = {
                documentId: d.documentId,
                notebookId: d.notebookId,
                fileName: d.originalFileName,
                summary: d.summary,
                generatedAt: d.generatedAt,
                pageCount: d.pageCount,
                fileSize: d.fileSize,
                status: 'completed',
              };
              apiService.saveDocumentSummary(updated[d.documentId]);
            });
            return updated;
          });
        }
      })
      .catch((err) => {
        console.warn('Syncing summaries from backend notice:', err);
      });
  }, [isOpen, notebook.id]);

  if (!isOpen) return null;

  // ----------------------------------------------------
  // SECTION A: CHAT SUMMARY HANDLERS
  // ----------------------------------------------------

  const handleGenerateChatSummary = async (force: boolean = false, customMessages?: ChatMessage[]) => {
    if (isGeneratingChat) return;
    const messagesToUse = customMessages || chatMessages;
    setIsGeneratingChat(true);
    setChatError(null);

    try {
      const result = await apiService.fetchOrGenerateChatSummary(
        notebook.id,
        messagesToUse,
        notebook.title,
        force
      );
      setChatSummary(result);
      if (onShowToast) {
        onShowToast(force ? 'Chat summary regenerated' : 'Chat summary generated', 'success');
      }
    } catch (err: any) {
      const msg = err?.message || 'Unable to generate chat summary.';
      setChatError(msg);
      if (onShowToast) {
        onShowToast('Could not generate chat summary: ' + msg, 'error');
      }
    } finally {
      setIsGeneratingChat(false);
    }
  };

  // ----------------------------------------------------
  // SECTION B: PER-PDF DOCUMENT SUMMARY HANDLERS
  // ----------------------------------------------------

  const handleGenerateDocumentSummary = async (doc: DocumentItem, force: boolean = false) => {
    if (generatingDocIds[doc.id]) return;
    setGeneratingDocIds((prev) => ({ ...prev, [doc.id]: true }));

    try {
      const result = await apiService.fetchOrGenerateDocumentSummary(doc.id, notebook.id, force);
      setDocSummaries((prev) => ({
        ...prev,
        [doc.id]: result,
      }));
      if (result.status === 'error') {
        if (onShowToast) {
          onShowToast(`Error summarizing ${doc.name}: ${result.error || 'Failed'}`, 'error');
        }
      } else if (onShowToast) {
        onShowToast(`Summary for "${doc.name}" generated successfully`, 'success');
      }
    } catch (err: any) {
      const msg = err?.message || 'Failed to generate document summary.';
      setDocSummaries((prev) => ({
        ...prev,
        [doc.id]: {
          documentId: doc.id,
          notebookId: notebook.id,
          fileName: doc.name,
          summary: '',
          generatedAt: new Date().toLocaleString(),
          pageCount: doc.pages,
          fileSize: doc.size,
          status: 'error',
          error: msg,
        },
      }));
      if (onShowToast) {
        onShowToast(`Error summarizing ${doc.name}: ${msg}`, 'error');
      }
    } finally {
      setGeneratingDocIds((prev) => ({ ...prev, [doc.id]: false }));
    }
  };

  // ----------------------------------------------------
  // UTILITIES: COPY & DOWNLOAD
  // ----------------------------------------------------

  const handleCopy = (key: string, content: string, label: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(content).catch(() => {});
      }
    } catch {
      // fallback
    }
    setCopiedKey(key);
    if (onShowToast) {
      onShowToast(`${label} copied to clipboard`, 'info');
    }
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 2000);
  };

  const handleDownload = (filename: string, content: string) => {
    try {
      const safeName = filename.replace(/[^a-zA-Z0-9_\-.]/g, '_');
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safeName.endsWith('.md') ? safeName : `${safeName}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (onShowToast) {
        onShowToast(`Downloaded ${a.download}`, 'success');
      }
    } catch {
      if (onShowToast) {
        onShowToast('Download failed', 'error');
      }
    }
  };

  const uploadedPdfs = notebook.documents || [];
  const validChatMessagesCount = chatMessages.filter((m) => m && m.text && m.text.trim().length > 0).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      {/* Main Dialog Modal */}
      <div className="relative bg-white dark:bg-[#0F172A] rounded-2xl max-w-5xl w-full max-h-[92vh] flex flex-col shadow-2xl border border-slate-200 dark:border-slate-800 z-10 animate-in fade-in zoom-in-95 duration-150 my-auto text-[#0F172A] dark:text-slate-100 overflow-hidden">
        {/* Top Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 shrink-0">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-[#2563EB] text-white flex items-center justify-center shrink-0 shadow-xs">
                <Sparkles className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white truncate">
                    Smart Summary Intelligence
                  </h3>
                  <span className="hidden sm:inline-flex text-[10px] font-semibold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 px-2 py-0.5 rounded-full border border-blue-200 dark:border-blue-800">
                    {notebook.code || 'MCA Unit'}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  Notebook: <span className="font-semibold text-slate-800 dark:text-slate-200">{notebook.title}</span> • {uploadedPdfs.length} course PDF{uploadedPdfs.length === 1 ? '' : 's'} • {validChatMessagesCount} chat messages
                </p>
              </div>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
              title="Close Smart Summary"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Navigation Section Pills */}
          <div className="mt-4 flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
            <button
              type="button"
              onClick={() => setActiveTab('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 shrink-0 ${
                activeTab === 'all'
                  ? 'bg-[#2563EB] text-white shadow-xs'
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>All Summaries</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('chat')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 shrink-0 ${
                activeTab === 'chat'
                  ? 'bg-[#2563EB] text-white shadow-xs'
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5 text-blue-500" />
              <span>Section A: Notebook Chat Summary</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                activeTab === 'chat' ? 'bg-white/20 text-white' : 'bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300'
              }`}>
                {validChatMessagesCount} turns
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('pdfs')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 shrink-0 ${
                activeTab === 'pdfs'
                  ? 'bg-[#2563EB] text-white shadow-xs'
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'
              }`}
            >
              <FileText className="w-3.5 h-3.5 text-emerald-500" />
              <span>Section B: Uploaded PDF Summaries</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                activeTab === 'pdfs' ? 'bg-white/20 text-white' : 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300'
              }`}>
                {uploadedPdfs.length} PDFs
              </span>
            </button>
          </div>
        </div>

        {/* Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-8 bg-[#F8FAFC] dark:bg-[#090D16]">
          {/* ============================================================
              SECTION A: NOTEBOOK CHAT SUMMARY
          ============================================================ */}
          {(activeTab === 'all' || activeTab === 'chat') && (
            <section id="section-chat-summary" className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-blue-100 dark:bg-blue-950/80 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                    <MessageSquare className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                      Section A: Notebook Chat Summary
                    </h4>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      One unified, intelligent synthesis of all questions and AI tutor answers in {notebook.title}
                    </p>
                  </div>
                </div>

                {validChatMessagesCount > 0 && (
                  <span className="hidden sm:inline-flex text-[11px] font-medium text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 px-2.5 py-0.5 rounded-full border border-blue-200 dark:border-blue-800">
                    {validChatMessagesCount} conversation turns analyzed
                  </span>
                )}
              </div>

              {/* Chat Summary Card */}
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-blue-200/80 dark:border-blue-900/60 shadow-xs overflow-hidden transition-all">
                {/* Card Header Bar */}
                <div className="p-4 sm:px-5 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-r from-blue-50/60 via-white to-indigo-50/40 dark:from-blue-950/30 dark:via-slate-900 dark:to-indigo-950/20 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-[#1E3A8A] dark:text-blue-400">
                        {notebook.title}
                      </span>
                      <span className="text-[10px] font-medium text-slate-400">•</span>
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        <span>{chatSummary?.generatedAt || 'Pending generation'}</span>
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
                      Full dialogue synthesis preserving key definitions, formulas, and relational walkthroughs.
                    </p>
                  </div>

                  {/* Actions: Regenerate, Copy, Download */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={isGeneratingChat || validChatMessagesCount === 0}
                      onClick={() => handleGenerateChatSummary(true)}
                      className="px-3 py-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/80 disabled:opacity-50 border border-blue-200 dark:border-blue-800 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer shadow-2xs"
                      title="Regenerate chat summary from full conversation history"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isGeneratingChat ? 'animate-spin' : ''}`} />
                      <span>{isGeneratingChat ? 'Generating...' : 'Regenerate Summary'}</span>
                    </button>

                    <button
                      type="button"
                      disabled={!chatSummary || !chatSummary.hasChat}
                      onClick={() => handleCopy('chat_summary', chatSummary?.summary || '', 'Chat summary')}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                      title="Copy full chat summary to clipboard"
                    >
                      {copiedKey === 'chat_summary' ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                          <span className="text-emerald-700 dark:text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-slate-500" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      disabled={!chatSummary || !chatSummary.hasChat}
                      onClick={() =>
                        handleDownload(
                          `${notebook.title.replace(/\s+/g, '_')}_Chat_Summary`,
                          chatSummary?.summary || ''
                        )
                      }
                      className="px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                      title="Download chat summary as Markdown (.md)"
                    >
                      <Download className="w-3.5 h-3.5 text-slate-500" />
                      <span>Download</span>
                    </button>
                  </div>
                </div>

                {/* Card Content */}
                <div className="p-5 sm:p-6">
                  {isGeneratingChat ? (
                    <div className="py-12 flex flex-col items-center justify-center text-center">
                      <div className="relative w-12 h-12 mb-3">
                        <div className="w-12 h-12 rounded-full border-3 border-blue-100 dark:border-blue-900 border-t-[#2563EB] animate-spin" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Sparkles className="w-5 h-5 text-[#2563EB]" />
                        </div>
                      </div>
                      <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                        Analyzing Full Chat Conversation...
                      </h4>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm">
                        Synthesizing questions, combining repeated topics, and extracting technical formulas across all conversation turns.
                      </p>
                    </div>
                  ) : chatError ? (
                    <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300 flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2.5">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                        <div>
                          <p className="font-semibold">Chat Summary Generation Error</p>
                          <p className="mt-0.5 text-[11px]">{chatError}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleGenerateChatSummary(true)}
                        className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold shrink-0 flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Retry</span>
                      </button>
                    </div>
                  ) : validChatMessagesCount === 0 ? (
                    /* Clean Empty State */
                    <div className="py-10 px-4 text-center max-w-md mx-auto">
                      <div className="w-12 h-12 mx-auto rounded-2xl bg-blue-50 dark:bg-blue-950/60 text-[#2563EB] flex items-center justify-center mb-3 border border-blue-200 dark:border-blue-800">
                        <MessageSquare className="w-6 h-6" />
                      </div>
                      <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                        No Chat History in this Notebook
                      </h4>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                        You have not asked any questions in <strong>{notebook.title}</strong> yet. Head over to the AI Study Tutor chat workspace, ask your first question, and your conversation summary will appear here!
                      </p>
                    </div>
                  ) : chatSummary?.summary ? (
                    /* Rich Markdown Body */
                    <div className="space-y-4 text-xs sm:text-sm text-slate-800 dark:text-slate-200 leading-relaxed [&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-[#1E3A8A] dark:[&_h1]:text-blue-400 [&_h1]:mb-3 [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-slate-900 dark:[&_h2]:text-white [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:pb-1.5 [&_h2]:border-b [&_h2]:border-slate-100 dark:[&_h2]:border-slate-800 [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-slate-800 dark:[&_h3]:text-slate-200 [&_h3]:mt-3 [&_h3]:mb-1 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-1.5 [&_strong]:font-semibold [&_strong]:text-slate-900 dark:[&_strong]:text-white [&_code]:bg-slate-100 dark:[&_code]:bg-slate-800 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:font-mono [&_code]:text-[11px] [&_blockquote]:border-l-3 [&_blockquote]:border-blue-500 [&_blockquote]:pl-3.5 [&_blockquote]:italic [&_blockquote]:text-slate-600 dark:[&_blockquote]:text-slate-400 [&_blockquote]:my-3">
                      <Markdown>{chatSummary.summary}</Markdown>
                    </div>
                  ) : (
                    <div className="py-8 text-center max-w-md mx-auto">
                      <p className="text-xs text-slate-600 dark:text-slate-400 mb-3">
                        Click below to generate a comprehensive summary of your conversation history in <strong>{notebook.title}</strong>.
                      </p>
                      <button
                        type="button"
                        onClick={() => handleGenerateChatSummary(false)}
                        className="px-4 py-2 text-xs font-bold text-white bg-[#2563EB] hover:bg-[#1E3A8A] rounded-xl shadow-xs transition-colors inline-flex items-center gap-2 cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Generate Chat Summary</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* ============================================================
              SECTION B: UPLOADED PDF SUMMARIES (PER PDF)
          ============================================================ */}
          {(activeTab === 'all' || activeTab === 'pdfs') && (
            <section id="section-pdf-summaries" className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-emerald-100 dark:bg-emerald-950/80 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                    <FileText className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                      Section B: Uploaded PDF Summaries
                    </h4>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Independent comprehensive summaries for each course document, synthesized page-by-page
                    </p>
                  </div>
                </div>

                {onOpenUploadModal && (
                  <button
                    type="button"
                    onClick={onOpenUploadModal}
                    className="px-2.5 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/80 border border-blue-200 dark:border-blue-800 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <UploadCloud className="w-3.5 h-3.5" />
                    <span>Upload New PDF</span>
                  </button>
                )}
              </div>

              {/* Zero Uploaded PDFs State */}
              {uploadedPdfs.length === 0 ? (
                <div className="bg-white dark:bg-slate-900 rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 p-8 text-center max-w-md mx-auto">
                  <div className="w-12 h-12 mx-auto rounded-2xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-3 border border-emerald-200 dark:border-emerald-800">
                    <FileText className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                    No Course PDFs in this Notebook
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                    Upload your lecture notes, textbook chapters, or syllabus PDFs. Each document will receive an independent, structured Smart Summary with page references!
                  </p>
                  {onOpenUploadModal && (
                    <button
                      type="button"
                      onClick={onOpenUploadModal}
                      className="mt-4 px-4 py-2 text-xs font-bold text-white bg-[#2563EB] hover:bg-[#1E3A8A] rounded-xl shadow-xs transition-colors inline-flex items-center gap-2 cursor-pointer"
                    >
                      <UploadCloud className="w-4 h-4" />
                      <span>Upload Course PDF</span>
                    </button>
                  )}
                </div>
              ) : (
                /* Individual PDF Summary Cards List */
                <div className="space-y-6">
                  {uploadedPdfs.map((doc, docIdx) => {
                    const docSummary = docSummaries[doc.id];
                    const isGeneratingThisDoc = Boolean(generatingDocIds[doc.id]);
                    const hasSummary = Boolean(docSummary && docSummary.summary && docSummary.status === 'completed');

                    return (
                      <div
                        key={doc.id}
                        className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 hover:border-emerald-300 dark:hover:border-emerald-800 shadow-xs overflow-hidden transition-all"
                      >
                        {/* Individual PDF Card Header */}
                        <div className="p-4 sm:px-5 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-r from-emerald-50/50 via-white to-slate-50 dark:from-emerald-950/20 dark:via-slate-900 dark:to-slate-900/60 flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-9 h-9 rounded-xl bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0 shadow-2xs">
                              <FileText className="w-4 h-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <h5 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white truncate">
                                  {doc.name}
                                </h5>
                                <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
                                  Doc {docIdx + 1}
                                </span>
                              </div>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2">
                                <span>{doc.pages} pages</span>
                                <span>•</span>
                                <span>{doc.size}</span>
                                {docSummary?.generatedAt && (
                                  <>
                                    <span>•</span>
                                    <span className="flex items-center gap-1">
                                      <Calendar className="w-3 h-3 text-slate-400" />
                                      <span>{docSummary.generatedAt}</span>
                                    </span>
                                  </>
                                )}
                              </p>
                            </div>
                          </div>

                          {/* Individual PDF Actions: Generate/Regenerate, Copy, Download */}
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={isGeneratingThisDoc}
                              onClick={() => handleGenerateDocumentSummary(doc, hasSummary)}
                              className="px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/80 disabled:opacity-50 border border-emerald-200 dark:border-emerald-800 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer shadow-2xs"
                              title={hasSummary ? 'Regenerate summary for this PDF' : 'Generate summary for this PDF'}
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${isGeneratingThisDoc ? 'animate-spin' : ''}`} />
                              <span>{isGeneratingThisDoc ? 'Summarizing...' : hasSummary ? 'Regenerate Summary' : 'Generate Summary'}</span>
                            </button>

                            <button
                              type="button"
                              disabled={!hasSummary}
                              onClick={() => handleCopy(`doc_${doc.id}`, docSummary?.summary || '', `Summary for ${doc.name}`)}
                              className="px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                              title="Copy summary of this document"
                            >
                              {copiedKey === `doc_${doc.id}` ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                  <span className="text-emerald-700 dark:text-emerald-400">Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5 text-slate-500" />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              disabled={!hasSummary}
                              onClick={() =>
                                handleDownload(
                                  `${doc.name.replace(/\.[^/.]+$/, '')}_Smart_Summary`,
                                  docSummary?.summary || ''
                                )
                              }
                              className="px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                              title="Download document summary as Markdown (.md)"
                            >
                              <Download className="w-3.5 h-3.5 text-slate-500" />
                              <span>Download</span>
                            </button>
                          </div>
                        </div>

                        {/* Individual PDF Card Body */}
                        <div className="p-5 sm:p-6">
                          {isGeneratingThisDoc ? (
                            <div className="py-10 flex flex-col items-center justify-center text-center">
                              <div className="relative w-10 h-10 mb-3">
                                <div className="w-10 h-10 rounded-full border-3 border-emerald-100 dark:border-emerald-900 border-t-emerald-600 animate-spin" />
                                <div className="absolute inset-0 flex items-center justify-center">
                                  <FileText className="w-4 h-4 text-emerald-600" />
                                </div>
                              </div>
                              <h5 className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-200">
                                Processing All Pages of {doc.name}...
                              </h5>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 max-w-sm">
                                Reading chapters, mapping section headings, and preserving formulas with page citations across all {doc.pages} pages.
                              </p>
                            </div>
                          ) : docSummary?.status === 'error' ? (
                            <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300 flex items-start justify-between gap-3">
                              <div className="flex items-start gap-3 min-w-0">
                                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                                <div className="flex-1 min-w-0">
                                  <p className="font-semibold">Document Summary Error</p>
                                  <p className="mt-0.5 text-[11px]">{docSummary.error || 'Unable to generate summary from this document.'}</p>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleGenerateDocumentSummary(doc, true)}
                                className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold shrink-0 flex items-center gap-1.5 transition-colors cursor-pointer"
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                                <span>Retry</span>
                              </button>
                            </div>
                          ) : hasSummary ? (
                            <div className="space-y-4 text-xs sm:text-sm text-slate-800 dark:text-slate-200 leading-relaxed [&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-emerald-800 dark:[&_h1]:text-emerald-400 [&_h1]:mb-3 [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-slate-900 dark:[&_h2]:text-white [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:pb-1.5 [&_h2]:border-b [&_h2]:border-slate-100 dark:[&_h2]:border-slate-800 [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-slate-800 dark:[&_h3]:text-slate-200 [&_h3]:mt-3 [&_h3]:mb-1 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-1.5 [&_strong]:font-semibold [&_strong]:text-slate-900 dark:[&_strong]:text-white [&_code]:bg-slate-100 dark:[&_code]:bg-slate-800 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:font-mono [&_code]:text-[11px] [&_blockquote]:border-l-3 [&_blockquote]:border-emerald-500 [&_blockquote]:pl-3.5 [&_blockquote]:italic [&_blockquote]:text-slate-600 dark:[&_blockquote]:text-slate-400 [&_blockquote]:my-3">
                              <Markdown>{docSummary.summary}</Markdown>
                            </div>
                          ) : (
                            /* Prompt to Generate */
                            <div className="py-8 text-center max-w-md mx-auto">
                              <p className="text-xs text-slate-600 dark:text-slate-400 mb-3">
                                No summary generated yet for <strong>{doc.name}</strong>. Click below to generate a structured synthesis covering all chapters and page references.
                              </p>
                              <button
                                type="button"
                                onClick={() => handleGenerateDocumentSummary(doc, false)}
                                className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition-colors inline-flex items-center gap-2 cursor-pointer"
                              >
                                <Sparkles className="w-3.5 h-3.5" />
                                <span>Generate Summary for this PDF</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 shrink-0">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>Smart Summaries grounded in course materials & conversation history</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
