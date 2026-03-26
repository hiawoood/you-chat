// Use relative URL to work with both local and tunnel
const API_BASE = "/api";

async function fetchAPI(path: string, options: RequestInit = {}) {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = new Headers(options.headers || {});

  if (!isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }

  return res.json();
}

export interface ChatSession {
  id: string;
  user_id: string;
  title: string;
  agent: string;
  last_tts_message_id?: string | null;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
  status?: "complete" | "streaming";
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  type: "agent" | "model";
}

export interface TtsVoiceReference {
  id: string;
  label: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  selected: boolean;
  remoteVoiceId: string | null;
  remoteVoiceName: string | null;
  syncStatus: string;
  lastSyncedAt: number | null;
  syncError: string | null;
  previewUrl: string;
}

export interface SessionTtsSpeakerMapping {
  speakerKey: string;
  speakerLabel: string;
  voiceReferenceId: string | null;
  hidden: boolean;
}

export interface SessionTtsSpeakerResponse {
  speakers: SessionTtsSpeakerMapping[];
  defaultVoiceReferenceId: string | null;
}

export interface TtsVoiceListResponse {
  voices: TtsVoiceReference[];
  selectedVoiceId: string | null;
  warning?: string | null;
  applied?: boolean;
  requiresBuiltinReset?: boolean;
}

export interface TtsLifecycleState {
  phase: "idle" | "checking" | "searching" | "creating" | "polling" | "running" | "stopping" | "error";
  message: string;
  updatedAt: number;
  provisioning: boolean;
  instanceId: string | null;
  offerId: string | null;
  searchRound: number | null;
  pollAttempt: number | null;
  lastError: string | null;
  excludedMachineIds: string[];
}

export interface TtsStatusResponse {
  active: boolean;
  status: string;
  healthy: boolean;
  lifecycle: TtsLifecycleState;
  accountBalance: number | null;
  instance?: {
    id: string;
    ip: string | null;
    port: number;
    gpuName?: string;
    hourlyRate?: number;
    machineId?: string;
    createdAt: string;
    lastActivity: string;
  };
}

export interface TtsLogsResponse {
  success: boolean;
  instanceId: string;
  logs: string;
}

export const api = {
  getSessions: (): Promise<ChatSession[]> => fetchAPI("/sessions"),
  createSession: (data?: { title?: string; agent?: string }): Promise<ChatSession> =>
    fetchAPI("/sessions", { method: "POST", body: JSON.stringify(data || {}) }),
  getSession: (id: string): Promise<ChatSession> => fetchAPI(`/sessions/${id}`),
  updateSession: (id: string, data: { title?: string; agent?: string; lastTtsMessageId?: string | null }): Promise<ChatSession> =>
    fetchAPI(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteSession: (id: string): Promise<void> =>
    fetchAPI(`/sessions/${id}`, { method: "DELETE" }),
  getMessages: (sessionId: string): Promise<Message[]> =>
    fetchAPI(`/sessions/${sessionId}/messages`),
  getSessionTtsSpeakers: (sessionId: string): Promise<SessionTtsSpeakerResponse> =>
    fetchAPI(`/sessions/${sessionId}/tts-speakers`),
  updateSessionTtsSpeaker: (
    sessionId: string,
    speakerKey: string,
    data: { voiceReferenceId?: string | null; hidden?: boolean }
  ): Promise<{ success: boolean; speaker: SessionTtsSpeakerMapping }> =>
    fetchAPI(`/sessions/${sessionId}/tts-speakers/${encodeURIComponent(speakerKey)}`, { method: "PATCH", body: JSON.stringify(data) }),
  editMessage: (sessionId: string, messageId: string, content: string): Promise<Message> =>
    fetchAPI(`/sessions/${sessionId}/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ content }) }),
  getMessage: (sessionId: string, messageId: string): Promise<Message & { status?: string }> =>
    fetchAPI(`/sessions/${sessionId}/messages/${messageId}`),
  stopGeneration: (sessionId: string): Promise<{ stopped: boolean }> =>
    fetchAPI("/chat/stop", { method: "POST", body: JSON.stringify({ sessionId }) }),
  deleteMessage: (sessionId: string, messageId: string): Promise<void> =>
    fetchAPI(`/sessions/${sessionId}/messages/${messageId}`, { method: "DELETE" }),
  forkSession: (sessionId: string, messageId: string): Promise<ChatSession> =>
    fetchAPI(`/sessions/${sessionId}/fork`, { method: "POST", body: JSON.stringify({ messageId }) }),
  // Agents (live from You.com API)
  getAgents: (): Promise<Agent[]> => fetchAPI("/agents"),
  // Credentials
  getCredentials: (): Promise<{ hasCredentials: boolean; email?: string; name?: string; subscription?: string }> =>
    fetchAPI("/credentials"),
  saveCredentials: (ds: string, dsr: string, uuidGuest?: string): Promise<{ email: string; name: string; subscription?: string }> =>
    fetchAPI("/credentials", { method: "POST", body: JSON.stringify({ ds, dsr, uuidGuest }) }),
  deleteCredentials: (): Promise<void> =>
    fetchAPI("/credentials", { method: "DELETE" }),

  getTtsVoices: (): Promise<TtsVoiceListResponse> => fetchAPI("/tts/voices"),
  getTtsStatus: (): Promise<TtsStatusResponse> => fetchAPI("/tts/status"),
  getTtsLogs: (): Promise<TtsLogsResponse> => fetchAPI("/tts/logs"),
  streamTtsStatus: (onStatus: (status: TtsStatusResponse) => void, onError?: () => void) => {
    const eventSource = new EventSource(`${API_BASE}/tts/status/stream`, { withCredentials: true });
    eventSource.addEventListener("status", (event) => {
      try {
        onStatus(JSON.parse((event as MessageEvent).data));
      } catch {
        // Ignore malformed status payloads.
      }
    });
    eventSource.onerror = () => {
      onError?.();
    };
    return eventSource;
  },
  restartTtsInstance: (): Promise<{ success: boolean; message: string; instance?: TtsStatusResponse["instance"] }> =>
    fetchAPI("/tts/restart", { method: "POST" }),
  stopTtsInstance: (): Promise<{ success: boolean; message: string }> =>
    fetchAPI("/tts/stop", { method: "POST" }),
  uploadTtsVoice: (label: string, file: File): Promise<TtsVoiceListResponse & { voice: TtsVoiceReference }> => {
    const formData = new FormData();
    formData.append("label", label);
    formData.append("file", file);
    return fetchAPI("/tts/voices", { method: "POST", body: formData });
  },
  updateTtsVoice: (voiceId: string, label: string): Promise<TtsVoiceListResponse & { voice: TtsVoiceReference | null }> =>
    fetchAPI(`/tts/voices/${voiceId}`, { method: "PATCH", body: JSON.stringify({ label }) }),
  deleteTtsVoice: (voiceId: string): Promise<TtsVoiceListResponse> =>
    fetchAPI(`/tts/voices/${voiceId}`, { method: "DELETE" }),
  selectTtsVoice: (voiceId: string): Promise<TtsVoiceListResponse> =>
    fetchAPI(`/tts/voices/${voiceId}/select`, { method: "POST" }),
  clearSelectedTtsVoice: (): Promise<TtsVoiceListResponse> =>
    fetchAPI("/tts/voices/select-none", { method: "POST" }),
  getTtsVoicePreviewUrl: (voiceId: string): string => `${API_BASE}/tts/voices/${voiceId}/audio`,
  
  // Generic methods for TTS and other features
  get: (path: string): Promise<any> => fetchAPI(path),
  post: (path: string, body: any): Promise<any> => fetchAPI(path, { method: "POST", body: JSON.stringify(body) }),
  patch: (path: string, body: any): Promise<any> => fetchAPI(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: (path: string): Promise<any> => fetchAPI(path, { method: "DELETE" }),
};
