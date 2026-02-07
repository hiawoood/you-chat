import { useState, useEffect } from "react";
import { api } from "../lib/api";

interface SettingsProps {
  onBack: () => void;
}

export default function Settings({ onBack }: SettingsProps) {
  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<{
    hasCredentials: boolean;
    email?: string;
    name?: string;
    subscription?: string;
    hasFullCookies?: boolean;
  } | null>(null);

  // Cookie update form
  const [showUpdate, setShowUpdate] = useState(false);
  const [ds, setDs] = useState("");
  const [dsr, setDsr] = useState("");
  const [fullCookies, setFullCookies] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    loadCredentials();
  }, []);

  const loadCredentials = async () => {
    try {
      const data = await api.getCredentials();
      setCredentials(data);
    } catch (e) {
      console.error("Failed to load credentials:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!ds.trim() || !dsr.trim()) return;
    setSaving(true);
    setError("");

    // Build allCookies: merge DS/DSR into the full string if provided
    let allCookies = fullCookies.trim();
    if (allCookies) {
      if (!allCookies.includes("DS=")) allCookies = `DS=${ds.trim()}; ${allCookies}`;
      if (!allCookies.includes("DSR=")) allCookies = `DSR=${dsr.trim()}; ${allCookies}`;
    }

    try {
      const result = await api.saveCredentials(ds.trim(), dsr.trim(), allCookies || undefined);
      setCredentials({
        hasCredentials: true,
        email: result.email,
        name: result.name,
        subscription: result.subscription,
        hasFullCookies: !!allCookies,
      });
      setShowUpdate(false);
      setDs("");
      setDsr("");
      setFullCookies("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update cookies");
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setSaving(true);
    try {
      await api.deleteCredentials();
      setCredentials({ hasCredentials: false });
      setConfirmDisconnect(false);
    } catch (e) {
      console.error("Failed to disconnect:", e);
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    setShowUpdate(false);
    setDs("");
    setDsr("");
    setFullCookies("");
    setError("");
  };

  const CookieForm = ({ buttonLabel }: { buttonLabel: string }) => (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
          DS Cookie <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          value={ds}
          onChange={(e) => setDs(e.target.value)}
          placeholder="Paste DS cookie value (Application → Cookies → DS)"
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
          DSR Cookie <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          value={dsr}
          onChange={(e) => setDsr(e.target.value)}
          placeholder="Paste DSR cookie value (Application → Cookies → DSR)"
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
          Full Cookie Header <span className="text-gray-400 font-normal">(recommended)</span>
        </label>
        <textarea
          value={fullCookies}
          onChange={(e) => setFullCookies(e.target.value)}
          placeholder="Network tab → any you.com/api/ request → Cookie header value"
          rows={3}
          className="w-full px-3 py-2 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400 resize-none"
        />
        <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
          Enables You.com thread cleanup on delete. Copy from Network tab → any API request → Cookie header.
        </p>
      </div>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleUpdate}
          disabled={!ds.trim() || !dsr.trim() || saving}
          className="px-3 py-1.5 text-sm bg-gray-900 dark:bg-gray-600 text-white rounded-md hover:bg-gray-800 dark:hover:bg-gray-500 disabled:opacity-50"
        >
          {saving ? "Validating..." : buttonLabel}
        </button>
        <button
          onClick={resetForm}
          className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-[100dvh] bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="h-12 flex items-center px-4 border-b border-gray-200 dark:border-gray-800 gap-3 flex-shrink-0">
        <button
          onClick={onBack}
          className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md text-gray-600 dark:text-gray-300"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="font-semibold text-gray-900 dark:text-white">Settings</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-4 sm:p-6">
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">You.com Connection</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Manage your You.com account cookies for AI access.
            </p>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-gray-300 dark:border-gray-600 border-t-gray-900 dark:border-t-white" />
            </div>
          ) : credentials?.hasCredentials ? (
            <div className="space-y-4">
              {/* Connected account info */}
              <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800/50">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-2 h-2 bg-green-500 rounded-full" />
                  <span className="text-sm font-medium text-green-700 dark:text-green-400">Connected</span>
                </div>
                {credentials.name && (
                  <p className="text-sm text-gray-900 dark:text-white">{credentials.name}</p>
                )}
                {credentials.email && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">{credentials.email}</p>
                )}
                {credentials.subscription && (
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    Plan: {credentials.subscription}
                  </p>
                )}
              </div>

              {/* Warning if full cookies missing */}
              {!credentials.hasFullCookies && (
                <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">⚠️ Full cookies not set</p>
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    Thread cleanup on delete won't work. Click "Update Cookies" and include the full Cookie header from the Network tab.
                  </p>
                </div>
              )}

              {/* Update cookies form */}
              {showUpdate ? (
                <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-3">Update Cookies</h3>
                  <CookieForm buttonLabel="Update" />
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowUpdate(true)}
                    className="px-3 py-1.5 text-sm bg-gray-900 dark:bg-gray-700 text-white rounded-md hover:bg-gray-800 dark:hover:bg-gray-600"
                  >
                    Update Cookies
                  </button>
                  {confirmDisconnect ? (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleDisconnect}
                        disabled={saving}
                        className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                      >
                        Confirm Disconnect
                      </button>
                      <button
                        onClick={() => setConfirmDisconnect(false)}
                        className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDisconnect(true)}
                      className="px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <p className="mb-2">No You.com account connected.</p>
              <p className="text-sm mb-4">You need to connect your account to use the chat.</p>
              {showUpdate ? (
                <div className="mt-4 p-4 border border-gray-200 dark:border-gray-700 rounded-lg text-left">
                  <CookieForm buttonLabel="Connect" />
                </div>
              ) : (
                <button
                  onClick={() => setShowUpdate(true)}
                  className="px-4 py-2 text-sm bg-gray-900 dark:bg-gray-700 text-white rounded-md hover:bg-gray-800 dark:hover:bg-gray-600"
                >
                  Connect Account
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
