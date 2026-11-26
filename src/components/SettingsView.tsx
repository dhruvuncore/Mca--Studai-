import React, { useState } from 'react';
import {
  User,
  Mail,
  GraduationCap,
  Moon,
  Sun,
  LogOut,
  Cpu,
  Database,
  Layers,
  Sparkles,
  Save,
  CheckCircle2,
  Trash2,
  AlertTriangle,
  Download,
  FolderArchive,
} from 'lucide-react';
import { StudentProfile } from '../types';

interface SettingsViewProps {
  profile: StudentProfile;
  onUpdateProfile: (updated: Partial<StudentProfile>) => Promise<void> | void;
  onLogout: () => void;
  theme?: 'light' | 'dark';
  onSetTheme?: (theme: 'light' | 'dark') => void;
  onClearAllData?: () => Promise<void> | void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  profile,
  onUpdateProfile,
  onLogout,
  theme = 'light',
  onSetTheme,
  onClearAllData,
}) => {
  const [name, setName] = useState(profile.name);
  const [email] = useState(profile.email);
  const [degree, setDegree] = useState(profile.degree || 'Master of Computer Applications (MCA)');
  const [semester, setSemester] = useState(profile.semester || 'Semester II');
  const [isSaved, setIsSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [isWiping, setIsWiping] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onUpdateProfile({
        name,
        degree,
        semester,
      });
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2500);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-6 font-sans">
      {/* Header */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/90 shadow-xs">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight mb-1">
          Settings & Student Profile
        </h1>
        <p className="text-xs sm:text-sm text-slate-500">
          Manage your student credentials, preferences, and project specifications.
        </p>
      </div>

      {/* Profile Form Card */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/90 shadow-xs">
        <h2 className="text-base font-bold text-slate-900 mb-4 flex items-center gap-2">
          <User className="w-4 h-4 text-blue-600" />
          <span>Profile Information</span>
        </h2>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Full Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3.5 py-2 text-xs sm:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                College / University Email <span className="text-slate-400 font-normal">(Supabase Auth)</span>
              </label>
              <input
                type="email"
                value={email}
                readOnly
                className="w-full px-3.5 py-2 text-xs sm:text-sm border border-slate-200 bg-slate-50 rounded-lg text-slate-500 cursor-not-allowed"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Degree Program</label>
              <input
                type="text"
                value={degree}
                onChange={(e) => setDegree(e.target.value)}
                className="w-full px-3.5 py-2 text-xs sm:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Current Semester</label>
              <input
                type="text"
                value={semester}
                onChange={(e) => setSemester(e.target.value)}
                className="w-full px-3.5 py-2 text-xs sm:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-900"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
            {isSaved ? (
              <span className="text-xs font-semibold text-emerald-600 flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" />
                <span>Profile updated successfully!</span>
              </span>
            ) : (
              <span className="text-xs text-slate-400">Synced with Supabase PostgreSQL</span>
            )}

            <button
              type="submit"
              disabled={isSaving}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold text-xs sm:text-sm rounded-lg shadow-sm transition-all flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              <span>{isSaving ? 'Saving...' : 'Save Changes'}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Appearance Card */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/90 shadow-xs">
        <h2 className="text-base font-bold text-slate-900 mb-1 flex items-center gap-2">
          <Sun className="w-4 h-4 text-amber-500" />
          <span>Appearance</span>
        </h2>
        <p className="text-xs text-slate-500 mb-4">
          Default theme optimized for high-contrast academic study sessions.
        </p>

        <div className="grid grid-cols-2 gap-3 max-w-sm">
          <button
            type="button"
            onClick={() => onSetTheme?.('light')}
            className={`p-3.5 rounded-xl border text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer ${
              theme === 'light'
                ? 'border-2 border-blue-600 bg-blue-50/70 text-blue-900 shadow-xs'
                : 'border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Sun className="w-4 h-4 text-amber-500" />
            <span>Light Mode (Academic)</span>
          </button>

          <button
            type="button"
            onClick={() => onSetTheme?.('dark')}
            className={`p-3.5 rounded-xl border text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer ${
              theme === 'dark'
                ? 'border-2 border-blue-600 bg-blue-50/70 text-blue-900 shadow-xs'
                : 'border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Moon className="w-4 h-4 text-blue-400" />
            <span>Dark Mode</span>
          </button>
        </div>
      </div>

      {/* Project Source Code Export & Download (ZIP) */}
      <div className="bg-white p-6 rounded-2xl border border-blue-200/90 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <FolderArchive className="w-4 h-4 text-blue-600" />
            <h4 className="text-sm font-bold text-slate-900">Project Source Code & Offline Package (ZIP)</h4>
          </div>
          <p className="text-xs text-slate-500 max-w-lg">
            Download the complete source code archive of this application including the full-stack server, RAG ingestion pipeline, vector store, React 19 UI, and setup instructions.
          </p>
        </div>
        <a
          href="/api/download-zip"
          download="study-ai-rag-project.zip"
          className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold transition-all flex items-center justify-center gap-2 shadow-xs shrink-0 cursor-pointer active:scale-98"
        >
          <Download className="w-4 h-4" />
          <span>Download Project ZIP</span>
        </a>
      </div>

      {/* Database & Data Clean Card */}
      <div className="bg-white p-6 rounded-2xl border border-rose-200/90 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Database className="w-4 h-4 text-rose-600" />
            <h4 className="text-sm font-bold text-slate-900">Database & Storage Management</h4>
          </div>
          <p className="text-xs text-slate-500 max-w-lg">
            Permanently wipe all indexed documents, vector embeddings, exam records, and student notebooks. Cleans the database with zero leftover data.
          </p>
        </div>
        {onClearAllData && !confirmingWipe && (
          <button
            type="button"
            onClick={() => setConfirmingWipe(true)}
            className="px-4 py-2 bg-rose-50 border border-rose-300 text-rose-700 hover:bg-rose-100 rounded-xl text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            <span>Clean Database & Remove All Data</span>
          </button>
        )}
        {onClearAllData && confirmingWipe && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={isWiping}
              onClick={() => setConfirmingWipe(false)}
              className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isWiping}
              onClick={async () => {
                setIsWiping(true);
                try {
                  await onClearAllData();
                } finally {
                  setIsWiping(false);
                  setConfirmingWipe(false);
                }
              }}
              className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-semibold transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{isWiping ? 'Wiping...' : 'Confirm Permanent Wipe'}</span>
            </button>
          </div>
        )}
      </div>

      {/* Account / Logout Card */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/90 shadow-xs flex items-center justify-between">
        <div>
          <h4 className="text-sm font-bold text-slate-900">Student Session</h4>
          <p className="text-xs text-slate-500">Sign out of StudyAI on this browser session.</p>
        </div>
        <button
          onClick={onLogout}
          className="px-4 py-2 border border-rose-300 text-rose-700 hover:bg-rose-50 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5"
        >
          <LogOut className="w-4 h-4" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );
};
