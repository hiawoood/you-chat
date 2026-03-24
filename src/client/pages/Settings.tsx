import { useState, useEffect } from "react";
import { api, type TtsVoiceReference, type TtsVoiceListResponse } from "../lib/api";
import { getNativeTtsPlugin, isNativeTtsAvailable } from "../lib/native-tts";

interface SettingsProps {
  onBack: () => void;
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Settings({ onBack }: SettingsProps) {
  const nativeTtsAvailable = isNativeTtsAvailable();
  const nativeTtsPlugin = nativeTtsAvailable ? getNativeTtsPlugin() : null;
  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<{
    hasCredentials: boolean;
    email?: string;
    name?: string;
    subscription?: string;
    hasFullCookies?: boolean;
  } | null>(null);

  const [showUpdate, setShowUpdate] = useState(false);
  const [ds, setDs] = useState("");
  const [dsr, setDsr] = useState("");
  const [uuidGuest, setUuidGuest] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [ttsVoices, setTtsVoices] = useState<TtsVoiceReference[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [voiceLabel, setVoiceLabel] = useState("");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [voiceActionId, setVoiceActionId] = useState<string | null>(null);
  const [editingVoiceId, setEditingVoiceId] = useState<string | null>(null);
  const [editingVoiceLabel, setEditingVoiceLabel] = useState("");
  const [motionAutoStopLoading, setMotionAutoStopLoading] = useState(false);
  const [motionAutoStopEnabled, setMotionAutoStopEnabled] = useState(false);
  const [motionAutoStopError, setMotionAutoStopError] = useState("");

  useEffect(() => {
    loadCredentials();
    loadTtsVoices();
    if (nativeTtsAvailable) {
      void loadMotionAutoStopConfig();
    }
  }, []);

  const applyVoiceResponse = (response: TtsVoiceListResponse) => {
    setTtsVoices(response.voices || []);
    setSelectedVoiceId(response.selectedVoiceId ?? null);
  };

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

  const loadTtsVoices = async () => {
    setVoicesLoading(true);
    try {
      const response = await api.getTtsVoices();
      applyVoiceResponse(response);
    } catch (e) {
      console.error("Failed to load TTS voices:", e);
      setVoiceError(e instanceof Error ? e.message : "Failed to load TTS voices");
    } finally {
      setVoicesLoading(false);
    }
  };

  const loadMotionAutoStopConfig = async () => {
    if (!nativeTtsPlugin) return;

    setMotionAutoStopLoading(true);
    setMotionAutoStopError("");

    try {
      const response = await nativeTtsPlugin.getMotionAutoStopConfig();
      setMotionAutoStopEnabled(Boolean(response.enabled));
    } catch (e) {
      setMotionAutoStopError(e instanceof Error ? e.message : "Failed to load motion auto-stop");
    } finally {
      setMotionAutoStopLoading(false);
    }
  };

  const handleToggleMotionAutoStop = async () => {
    if (!nativeTtsPlugin) return;

    const nextEnabled = !motionAutoStopEnabled;
    setMotionAutoStopLoading(true);
    setMotionAutoStopError("");

    try {
      const response = await nativeTtsPlugin.setMotionAutoStopConfig({ enabled: nextEnabled });
      setMotionAutoStopEnabled(Boolean(response.enabled));
    } catch (e) {
      setMotionAutoStopError(e instanceof Error ? e.message : "Failed to update motion auto-stop");
    } finally {
      setMotionAutoStopLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!ds.trim() || !dsr.trim()) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.saveCredentials(ds.trim(), dsr.trim(), uuidGuest.trim() || undefined);
      setCredentials({
        hasCredentials: true,
        email: result.email,
        name: result.name,
        subscription: result.subscription,
        hasFullCookies: !!uuidGuest.trim(),
      });
      resetForm();
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
    setUuidGuest("");
    setError("");
  };

  const resetVoiceForm = () => {
    setVoiceLabel("");
    setVoiceFile(null);
  };

  const handleUploadVoice = async () => {
    if (!voiceLabel.trim() || !voiceFile) return;

    setVoiceSaving(true);
    setVoiceError("");
    try {
      const response = await api.uploadTtsVoice(voiceLabel.trim(), voiceFile);
      applyVoiceResponse(response);
      resetVoiceForm();
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : "Failed to upload voice");
    } finally {
      setVoiceSaving(false);
    }
  };

  const handleSelectVoice = async (voiceId: string | null) => {
    setVoiceActionId(voiceId || "none");
    setVoiceError("");
    try {
      const response = voiceId ? await api.selectTtsVoice(voiceId) : await api.clearSelectedTtsVoice();
      applyVoiceResponse(response);
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : "Failed to update active voice");
    } finally {
      setVoiceActionId(null);
    }
  };

  const handleDeleteVoice = async (voice: TtsVoiceReference) => {
    if (!window.confirm(`Delete the voice reference "${voice.label}"?`)) return;

    setVoiceActionId(voice.id);
    setVoiceError("");
    try {
      const response = await api.deleteTtsVoice(voice.id);
      applyVoiceResponse(response);
      if (editingVoiceId === voice.id) {
        setEditingVoiceId(null);
        setEditingVoiceLabel("");
      }
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : "Failed to delete voice");
    } finally {
      setVoiceActionId(null);
    }
  };

  const handleSaveVoiceLabel = async (voiceId: string) => {
    if (!editingVoiceLabel.trim()) return;

    setVoiceActionId(voiceId);
    setVoiceError("");
    try {
      const response = await api.updateTtsVoice(voiceId, editingVoiceLabel.trim());
      applyVoiceResponse(response);
      setEditingVoiceId(null);
      setEditingVoiceLabel("");
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : "Failed to rename voice");
    } finally {
      setVoiceActionId(null);
    }
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
          placeholder="Application → Cookies → DS (starts with eyJ...)"
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
          placeholder="Application → Cookies → DSR (starts with eyJ...)"
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
          uuid_guest Cookie <span className="text-gray-400 font-normal">(recommended)</span>
        </label>
        <input
          type="text"
          value={uuidGuest}
          onChange={(e) => setUuidGuest(e.target.value)}
          placeholder="Application → Cookies → uuid_guest (UUID format)"
          className="w-full px-3 py-2 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
          Enables You.com thread cleanup on chat delete.
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
    <div className="native-app-safe-top flex flex-col h-[100dvh] bg-white dark:bg-gray-900">
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

              {/* Warning if uuid_guest missing */}
              {!credentials.hasFullCookies && (
                <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">⚠️ uuid_guest not set</p>
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    Thread cleanup on delete won't work. Update cookies and include uuid_guest from Application → Cookies.
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

          <div className="mt-10 mb-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">TTS Voices</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Upload reusable voice reference clips for Chatterbox playback and choose which one should be active by default.
            </p>
          </div>

          {nativeTtsAvailable && (
            <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold text-gray-900 dark:text-white">Android Motion Auto-Stop</h2>
                    <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                      Android
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    When the phone stays still for 10:00, playback fades out over 0:30 and then stops. Any significant movement resets the timer.
                  </p>
                </div>

                <button
                  onClick={() => void handleToggleMotionAutoStop()}
                  disabled={motionAutoStopLoading}
                  className={`inline-flex min-w-[6.5rem] items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${motionAutoStopEnabled ? "bg-emerald-600 text-white hover:bg-emerald-500" : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"}`}
                >
                  {motionAutoStopLoading ? "Saving..." : motionAutoStopEnabled ? "Enabled" : "Disabled"}
                </button>
              </div>

              <div className="mt-4 grid gap-2 text-xs text-gray-500 dark:text-gray-400 sm:grid-cols-3">
                <div className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
                  Trigger after 10:00 stillness
                </div>
                <div className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
                  Fade over 0:30
                </div>
                <div className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
                  Countdown shown in playback bar
                </div>
              </div>

              {motionAutoStopError && (
                <p className="mt-3 text-sm text-red-600 dark:text-red-400">{motionAutoStopError}</p>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800/50 space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Voice Label
                </label>
                <input
                  type="text"
                  value={voiceLabel}
                  onChange={(e) => setVoiceLabel(e.target.value)}
                  placeholder="Warm narrator"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Reference Audio
                </label>
                <input
                  type="file"
                  accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.webm"
                  onChange={(e) => setVoiceFile(e.target.files?.[0] || null)}
                  className="block w-full text-sm text-gray-600 dark:text-gray-300 file:mr-3 file:px-3 file:py-1.5 file:border-0 file:rounded-md file:bg-gray-900 file:text-white dark:file:bg-gray-700"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Upload a short clean sample in a common audio format. Max 15 MB.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleUploadVoice}
                  disabled={!voiceLabel.trim() || !voiceFile || voiceSaving}
                  className="px-3 py-1.5 text-sm bg-gray-900 dark:bg-gray-700 text-white rounded-md hover:bg-gray-800 dark:hover:bg-gray-600 disabled:opacity-50"
                >
                  {voiceSaving ? "Uploading..." : "Add Voice"}
                </button>
                {(voiceLabel || voiceFile) && (
                  <button
                    onClick={resetVoiceForm}
                    className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                  >
                    Clear
                  </button>
                )}
              </div>

              {voiceError && (
                <p className="text-sm text-red-600 dark:text-red-400">{voiceError}</p>
              )}
            </div>

            <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium text-gray-900 dark:text-white">Saved Voices</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    The playback overlay lets you switch between these at any time.
                  </p>
                </div>
                <button
                  onClick={() => void handleSelectVoice(null)}
                  disabled={voiceActionId === "none"}
                  className={`px-3 py-1.5 text-xs rounded-md border ${selectedVoiceId === null ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"}`}
                >
                  {voiceActionId === "none" ? "Updating..." : "Use No Reference"}
                </button>
              </div>

              {voicesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-5 w-5 border-2 border-gray-300 dark:border-gray-600 border-t-gray-900 dark:border-t-white" />
                </div>
              ) : ttsVoices.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  No custom voice references yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {ttsVoices.map((voice) => {
                    const isEditing = editingVoiceId === voice.id;
                    const isSelected = selectedVoiceId === voice.id;
                    const isBusy = voiceActionId === voice.id;

                    return (
                      <div
                        key={voice.id}
                        className={`rounded-lg border px-3 py-3 ${isSelected ? "border-emerald-300 bg-emerald-50/70 dark:border-emerald-700 dark:bg-emerald-900/20" : "border-gray-200 dark:border-gray-700"}`}
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex-1 min-w-0">
                            {isEditing ? (
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                <input
                                  type="text"
                                  value={editingVoiceLabel}
                                  onChange={(e) => setEditingVoiceLabel(e.target.value)}
                                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
                                />
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => void handleSaveVoiceLabel(voice.id)}
                                    disabled={!editingVoiceLabel.trim() || isBusy}
                                    className="px-3 py-1.5 text-xs bg-gray-900 dark:bg-gray-700 text-white rounded-md disabled:opacity-50"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={() => {
                                      setEditingVoiceId(null);
                                      setEditingVoiceLabel("");
                                    }}
                                    className="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-medium text-gray-900 dark:text-white">{voice.label}</p>
                                {isSelected && (
                                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                                    Active
                                  </span>
                                )}
                              </div>
                            )}

                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                              <span>{voice.originalFilename}</span>
                              <span>{formatBytes(voice.sizeBytes)}</span>
                            </div>

                            <audio
                              controls
                              preload="none"
                              src={voice.previewUrl || api.getTtsVoicePreviewUrl(voice.id)}
                              className="mt-3 h-8 w-full max-w-sm"
                            />
                          </div>

                          {!isEditing && (
                            <div className="flex items-center gap-2 sm:justify-end">
                              <button
                                onClick={() => void handleSelectVoice(voice.id)}
                                disabled={isBusy}
                                className={`px-3 py-1.5 text-xs rounded-md ${isSelected ? "bg-emerald-600 text-white" : "bg-gray-900 text-white hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600"} disabled:opacity-50`}
                              >
                                {isBusy && isSelected ? "Updating..." : isSelected ? "Selected" : "Use Voice"}
                              </button>
                              <button
                                onClick={() => {
                                  setEditingVoiceId(voice.id);
                                  setEditingVoiceLabel(voice.label);
                                }}
                                className="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
                              >
                                Rename
                              </button>
                              <button
                                onClick={() => void handleDeleteVoice(voice)}
                                disabled={isBusy}
                                className="px-3 py-1.5 text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
