import { useState } from "react";
import { api } from "../lib/api";

interface CookieSetupProps {
  onComplete: () => void;
}

export default function CookieSetup({ onComplete }: CookieSetupProps) {
  const [ds, setDs] = useState("");
  const [dsr, setDsr] = useState("");
  const [fullCookies, setFullCookies] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{ email: string; name: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ds.trim() || !dsr.trim()) return;

    setLoading(true);
    setError("");

    // Build allCookies: merge DS/DSR into the full string if provided
    let allCookies = fullCookies.trim();
    if (allCookies) {
      // Ensure DS/DSR are in the full string
      if (!allCookies.includes("DS=")) allCookies = `DS=${ds.trim()}; ${allCookies}`;
      if (!allCookies.includes("DSR=")) allCookies = `DSR=${dsr.trim()}; ${allCookies}`;
    }

    try {
      const result = await api.saveCredentials(ds.trim(), dsr.trim(), allCookies || undefined);
      setSuccess(result);
      setTimeout(onComplete, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to validate cookies");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-950 p-4">
      <div className="w-full max-w-lg">
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 p-6 sm:p-8">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
            Connect Your You.com Account
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            To use this app, you need to provide your You.com session cookies.
          </p>

          {/* Instructions */}
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-3">How to get your cookies:</h3>
            <ol className="text-sm text-gray-600 dark:text-gray-400 space-y-2 list-decimal list-inside">
              <li>Go to <span className="font-mono text-gray-900 dark:text-gray-200">you.com</span> and sign in</li>
              <li>Open Developer Tools (<span className="font-mono text-xs bg-gray-200 dark:bg-gray-700 px-1 rounded">F12</span>)</li>
              <li><strong>DS &amp; DSR:</strong> Go to <strong>Application</strong> → <strong>Cookies</strong> → <strong>you.com</strong> → find and copy <span className="font-mono text-xs bg-gray-200 dark:bg-gray-700 px-1 rounded">DS</span> and <span className="font-mono text-xs bg-gray-200 dark:bg-gray-700 px-1 rounded">DSR</span></li>
              <li><strong>Full cookies (optional):</strong> Go to <strong>Network</strong> tab → click any <span className="font-mono text-xs">you.com/api/</span> request → copy the full <span className="font-mono text-xs bg-gray-200 dark:bg-gray-700 px-1 rounded">Cookie</span> header value</li>
            </ol>
          </div>

          {success ? (
            <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
              <p className="text-sm font-medium text-green-800 dark:text-green-200">Connected successfully!</p>
              <p className="text-sm text-green-600 dark:text-green-400 mt-1">
                {success.name} ({success.email})
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  DS Cookie <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={ds}
                  onChange={(e) => setDs(e.target.value)}
                  placeholder="Paste DS cookie value (starts with eyJ...)"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  DSR Cookie <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={dsr}
                  onChange={(e) => setDsr(e.target.value)}
                  placeholder="Paste DSR cookie value (starts with eyJ...)"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Full Cookie Header <span className="text-gray-400 font-normal">(recommended)</span>
                </label>
                <textarea
                  value={fullCookies}
                  onChange={(e) => setFullCookies(e.target.value)}
                  placeholder="Paste the full Cookie header from Network tab (enables thread cleanup)"
                  rows={3}
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 resize-none"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Needed for cleaning up You.com threads. Get it from Network tab → any API request → Cookie header.
                </p>
              </div>

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={!ds.trim() || !dsr.trim() || loading}
                className="w-full py-2.5 px-4 text-sm font-medium bg-gray-900 dark:bg-gray-700 text-white rounded-md hover:bg-gray-800 dark:hover:bg-gray-600 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Validating...
                  </>
                ) : (
                  "Connect"
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
