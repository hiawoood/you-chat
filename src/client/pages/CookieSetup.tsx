import { useState } from "react";
import { api } from "../lib/api";

interface CookieSetupProps {
  onComplete: () => void;
}

export default function CookieSetup({ onComplete }: CookieSetupProps) {
  const [cookieString, setCookieString] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{ email: string; name: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = cookieString.trim();
    if (!raw) return;

    // Parse DS and DSR from the full cookie string
    const parseCookie = (name: string): string => {
      const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
      return match?.[1]?.trim() ?? "";
    };

    const ds = parseCookie("DS");
    const dsr = parseCookie("DSR");

    if (!ds || !dsr) {
      setError("Could not find DS and DSR cookies in the pasted string. Make sure you copied the full cookie header.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const result = await api.saveCredentials(ds, dsr, raw);
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
            Paste your You.com cookies to connect your account.
          </p>

          {/* Instructions */}
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-3">How to get your cookies:</h3>
            <ol className="text-sm text-gray-600 dark:text-gray-400 space-y-2 list-decimal list-inside">
              <li>Go to <span className="font-mono text-gray-900 dark:text-gray-200">you.com</span> and sign in</li>
              <li>Open Developer Tools (<span className="font-mono text-xs bg-gray-200 dark:bg-gray-700 px-1 rounded">F12</span>)</li>
              <li>Go to the <strong>Network</strong> tab</li>
              <li>Reload the page, click any request to <span className="font-mono text-xs">you.com</span></li>
              <li>In the <strong>Headers</strong> tab, find the <span className="font-mono text-xs bg-gray-200 dark:bg-gray-700 px-1 rounded">Cookie</span> request header</li>
              <li>Copy the <strong>entire value</strong> and paste it below</li>
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
                  Cookie Header Value
                </label>
                <textarea
                  value={cookieString}
                  onChange={(e) => setCookieString(e.target.value)}
                  placeholder="Paste the full Cookie header value here (contains DS=...; DSR=...; and other cookies)"
                  rows={4}
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 resize-none"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Should start with something like <span className="font-mono">_gcl_au=...</span> or <span className="font-mono">DS=eyJ...</span>
                </p>
              </div>

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={!cookieString.trim() || loading}
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
