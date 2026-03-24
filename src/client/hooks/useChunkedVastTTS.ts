import { useState, useCallback, useRef, useEffect } from "react";
import { api } from "../lib/api";
import { getNativeTtsPlugin, isNativeTtsAvailable, type NativeTtsChunkDescriptor, type NativeTtsStatePayload } from "../lib/native-tts";
import { buildSpeakerChunkPlans, normalizeSpeakerKey, type SpeakerVoiceMapping, type TtsChunkPlan, type TtsChunkPartPlan } from "../lib/tts-speakers";

export interface TTSChunk {
  id: number;
  text: string;
  displayText: string;
  parts: Array<TtsChunkPartPlan & { hash: string; audio: string | null }>;
  startWord: number;
  endWord: number;
  status: "pending" | "generating" | "ready" | "error" | "playing";
}

export interface SpeakerPlaybackContext {
  defaultVoiceReferenceId: string | null;
  speakerMappings: SpeakerVoiceMapping[];
}

export interface TTSState {
  isLoading: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  currentChunkIndex: number;
  loadingChunkIndex: number | null;
  totalChunks: number;
  error: string | null;
  activeMessageId: string | null;
  chunks: TTSChunk[];
  motionAutoStopEnabled: boolean;
  motionIdleRemainingMs: number | null;
  motionFadeActive: boolean;
}

interface StartPlaybackOptions {
  streaming?: boolean;
}

const MAX_PREFETCH_AHEAD = 2;
const PLAYBACK_START_DELAY_SECONDS = 0.05;
const DEFAULT_PLAYBACK_SPEED = 1;
const MIN_PLAYBACK_SPEED = 0.5;
const MAX_PLAYBACK_SPEED = 3;
const PLAYBACK_SPEED_STORAGE_KEY = "tts-playback-speed";

// ---- Browser audio cache (IndexedDB, keyed by chunk hash) ----
const CACHE_DB_NAME = "tts-audio-cache";
const CACHE_DB_VERSION = 2;
const CACHE_STORE_NAME = "clips";
const TTS_AUDIO_FORMAT = "mp3";
const TTS_AUDIO_MIME_TYPE = "audio/mpeg";
let cacheDbPromise: Promise<IDBDatabase> | null = null;

interface CachedAudioRecord {
  hash: string;
  audio: string;
  audioFormat: typeof TTS_AUDIO_FORMAT;
  updatedAt: number;
  size: number;
}

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return "h" + (h >>> 0).toString(36);
}

function buildChunkPartHash(
  messageId: string,
  chunkIndex: number,
  partIndex: number,
  text: string,
  speakerKey: string,
  voiceReferenceId: string | null,
  contextSignature: string,
): string {
  return hashText(`${TTS_AUDIO_FORMAT}::${contextSignature}::${messageId}::${chunkIndex}::${partIndex}::${speakerKey}::${voiceReferenceId || "builtin"}::${text}`);
}

function buildSpeakerContextSignature(context: SpeakerPlaybackContext): string {
  const normalizedMappings = [...context.speakerMappings]
    .map((mapping) => `${normalizeSpeakerKey(mapping.speakerKey)}:${mapping.voiceReferenceId || "default"}`)
    .sort();

  return hashText(`${context.defaultVoiceReferenceId || "builtin"}::${normalizedMappings.join("|")}`);
}


function openCacheDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }

  if (!cacheDbPromise) {
    cacheDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          db.deleteObjectStore(CACHE_STORE_NAME);
        }

        const store = db.createObjectStore(CACHE_STORE_NAME, { keyPath: "hash" });

        if (!store.indexNames.contains("updatedAt")) {
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB cache"));
    });
  }

  return cacheDbPromise;
}

function runIdbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

async function withCacheStore<T>(mode: IDBTransactionMode, handler: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openCacheDb();
  const transaction = db.transaction(CACHE_STORE_NAME, mode);
  const store = transaction.objectStore(CACHE_STORE_NAME);
  const result = await handler(store);

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
  });

  return result;
}

async function deleteCachedAudio(hash: string): Promise<void> {
  await withCacheStore("readwrite", async (store) => {
    await runIdbRequest(store.delete(hash));
  });
}

async function deleteOldestCachedAudio(excludeHash?: string): Promise<boolean> {
  return withCacheStore("readwrite", async (store) => {
    const index = store.index("updatedAt");
    const records = await runIdbRequest(index.getAll()) as CachedAudioRecord[];

    for (const record of records) {
      if (record.hash === excludeHash) continue;
      await runIdbRequest(store.delete(record.hash));
      return true;
    }

    return false;
  });
}

async function getCachedAudio(hash: string): Promise<string | null> {
  try {
    const record = await withCacheStore("readwrite", async (store) => {
      const existing = await runIdbRequest(store.get(hash)) as CachedAudioRecord | undefined;
      if (!existing) {
        return null;
      }

      const updatedRecord: CachedAudioRecord = {
        ...existing,
        audioFormat: existing.audioFormat || TTS_AUDIO_FORMAT,
        updatedAt: Date.now(),
      };
      await runIdbRequest(store.put(updatedRecord));
      return updatedRecord;
    });

    return record?.audio || null;
  } catch {
    return null;
  }
}

async function setCachedAudio(hash: string, audio: string): Promise<void> {
  const record: CachedAudioRecord = {
    hash,
    audio,
    audioFormat: TTS_AUDIO_FORMAT,
    updatedAt: Date.now(),
    size: audio.length,
  };

  for (;;) {
    try {
      await withCacheStore("readwrite", async (store) => {
        await runIdbRequest(store.put(record));
      });
      return;
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : "";
      if (errorName !== "QuotaExceededError") {
        return;
      }

      const deleted = await deleteOldestCachedAudio(hash).catch(() => false);
      if (!deleted) {
        await deleteCachedAudio(hash).catch(() => {});
        return;
      }
    }
  }
}

// ---- Chunking ----
function buildChunkPlans(text: string, context: SpeakerPlaybackContext, options: { completeSentencesOnly?: boolean } = {}) {
  return buildSpeakerChunkPlans(text, context.speakerMappings, context.defaultVoiceReferenceId, {
    targetWordsPerChunk: 60,
    completeSentencesOnly: options.completeSentencesOnly,
  });
}

export function splitTextIntoTtsChunks(
  text: string,
  targetWordsPerChunk: number = 60,
  options: { completeSentencesOnly?: boolean } = {}
): string[] {
  return buildSpeakerChunkPlans(text, [], null, { targetWordsPerChunk, completeSentencesOnly: options.completeSentencesOnly }).map((chunk) => chunk.text);
}

export function splitTextIntoDisplayChunks(
  text: string,
  targetWordsPerChunk: number = 60,
  options: { completeSentencesOnly?: boolean } = {}
): string[] {
  return buildSpeakerChunkPlans(text, [], null, { targetWordsPerChunk, completeSentencesOnly: options.completeSentencesOnly }).map((chunk) => chunk.displayText);
}

export function splitStreamingTextIntoTtsChunks(text: string, targetWordsPerChunk: number = 60): string[] {
  return splitTextIntoTtsChunks(text, targetWordsPerChunk, { completeSentencesOnly: true });
}

export function splitStreamingTextIntoDisplayChunks(text: string, targetWordsPerChunk: number = 60): string[] {
  return splitTextIntoDisplayChunks(text, targetWordsPerChunk, { completeSentencesOnly: true });
}

function findChunkForWordIndex(chunks: string[], targetWordIndex: number): number {
  let wordCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i];
    if (!chunkText) continue;
    const chunkWordCount = chunkText.trim().split(/\s+/).length;
    if (wordCount + chunkWordCount > targetWordIndex) return i;
    wordCount += chunkWordCount;
  }
  return 0;
}

function chunkTextArraysMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function buildTtsChunks(
  messageId: string,
  chunkPlans: TtsChunkPlan[],
  contextSignature: string,
  previousChunks: TTSChunk[] = []
): TTSChunk[] {
  let wordOffset = 0;

  return chunkPlans.map((chunk, index) => {
    const words = chunk.text.split(/\s+/).filter(Boolean).length;
    const previousChunk = previousChunks[index];
    const nextParts = chunk.parts.map((part, partIndex) => {
      const hash = buildChunkPartHash(messageId, index, partIndex, part.text, part.speakerKey, part.voiceReferenceId, contextSignature);
      const previousPart = previousChunk?.parts[partIndex];
      const shouldReusePrevious = previousPart?.hash === hash;

      return {
        ...part,
        hash,
        audio: shouldReusePrevious ? previousPart.audio : null,
      };
    });

    const everyPartReady = nextParts.every((part) => part.audio);

    const nextChunk: TTSChunk = {
      id: index,
      text: chunk.text,
      displayText: chunk.displayText,
      parts: nextParts,
      startWord: wordOffset,
      endWord: wordOffset + words,
      status: everyPartReady
        ? "ready"
        : previousChunk?.status === "playing"
          ? "playing"
          : "pending",
    };

    wordOffset += words;
    return nextChunk;
  });
}

// ---- Hook ----
export function useChunkedVastTTS() {
  const nativeTtsEnabled = isNativeTtsAvailable();
  const nativeTtsPlugin = nativeTtsEnabled ? getNativeTtsPlugin() : null;
  const [playbackSpeed, setPlaybackSpeedState] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PLAYBACK_SPEED;
    const stored = Number(window.localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY) || DEFAULT_PLAYBACK_SPEED);
    if (Number.isFinite(stored)) {
      return Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, stored));
    }
    return DEFAULT_PLAYBACK_SPEED;
  });
  const [state, setState] = useState<TTSState>({
    isLoading: false,
    isPlaying: false,
    isPaused: false,
    currentChunkIndex: 0,
    loadingChunkIndex: null,
    totalChunks: 0,
    error: null,
    activeMessageId: null,
    chunks: [],
    motionAutoStopEnabled: false,
    motionIdleRemainingMs: null,
    motionFadeActive: false,
  });

  const audioContextRef = useRef<AudioContext | null>(null);
  const scheduledSourcesRef = useRef(new Map<number, AudioBufferSourceNode>());
  const scheduledChunkTimersRef = useRef(new Map<number, number>());
  const scheduledChunkWindowsRef = useRef(new Map<number, { startAt: number; endAt: number }>());
  const playbackCompletionTimerRef = useRef<number | null>(null);
  const playbackMonitorTimerRef = useRef<number | null>(null);
  const scheduledEndTimeRef = useRef(0);
  const decodedBufferCacheRef = useRef(new Map<string, AudioBuffer>());
  const lookaheadWaitersRef = useRef<Array<() => void>>([]);
  const chunksRef = useRef<TTSChunk[]>([]);
  const messageIdRef = useRef<string | null>(null);
  const playbackTokenRef = useRef(0);
  const currentChunkIndexRef = useRef(0);
  const playbackLookaheadBaseIndexRef = useRef(0);
  const speakerContextRef = useRef<SpeakerPlaybackContext>({ defaultVoiceReferenceId: null, speakerMappings: [] });
  const inflightAudioRef = useRef(new Map<string, Promise<string[]>>());
  const textRef = useRef<string>("");
  const textChunksRef = useRef<string[]>([]);
  const playbackSpeedRef = useRef(playbackSpeed);
  const pendingResumeChunkIndexRef = useRef<number | null>(null);
  const shouldAutoResumeOnVisibleRef = useRef(false);

  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PLAYBACK_SPEED_STORAGE_KEY, String(playbackSpeed));
    }
  }, [playbackSpeed]);

  const setSpeakerContext = useCallback((nextContext: SpeakerPlaybackContext) => {
    speakerContextRef.current = nextContext;
  }, []);

  const applyNativeState = useCallback((payload: NativeTtsStatePayload) => {
    const preparedChunkIndices = new Set(payload.preparedChunkIndices || []);

    currentChunkIndexRef.current = payload.currentChunkIndex;
    playbackLookaheadBaseIndexRef.current = payload.currentChunkIndex;
    messageIdRef.current = payload.activeMessageId;

    chunksRef.current = chunksRef.current.map((chunk, index) => {
      let status: TTSChunk["status"] = "pending";

      if (payload.error && index === payload.loadingChunkIndex) {
        status = "error";
      } else if (payload.isPlaying && index === payload.currentChunkIndex) {
        status = "playing";
      } else if (payload.loadingChunkIndex === index) {
        status = "generating";
      } else if (preparedChunkIndices.has(index)) {
        status = "ready";
      }

      return {
        ...chunk,
        status,
      };
    });

    setState((prev) => ({
      ...prev,
      isLoading: payload.isLoading,
      isPlaying: payload.isPlaying,
      isPaused: payload.isPaused,
      currentChunkIndex: payload.currentChunkIndex,
      loadingChunkIndex: payload.loadingChunkIndex,
      totalChunks: payload.totalChunks,
      error: payload.error,
      activeMessageId: payload.activeMessageId,
      chunks: [...chunksRef.current],
      motionAutoStopEnabled: payload.motionAutoStopEnabled,
      motionIdleRemainingMs: payload.motionIdleRemainingMs,
      motionFadeActive: payload.motionFadeActive,
    }));
  }, []);

  useEffect(() => {
    if (!nativeTtsEnabled || !nativeTtsPlugin) return;

    let removeListener: (() => Promise<void>) | null = null;

    void nativeTtsPlugin.getState().then(applyNativeState).catch(() => {});
    void nativeTtsPlugin.addListener("stateChange", applyNativeState).then((listener) => {
      removeListener = listener.remove;
    }).catch(() => {});

    return () => {
      if (removeListener) {
        void removeListener();
      }
    };
  }, [applyNativeState, nativeTtsEnabled, nativeTtsPlugin]);

  const clearPlaybackTimers = useCallback(() => {
    scheduledChunkTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    scheduledChunkTimersRef.current.clear();

    if (playbackCompletionTimerRef.current !== null) {
      window.clearTimeout(playbackCompletionTimerRef.current);
      playbackCompletionTimerRef.current = null;
    }

    if (playbackMonitorTimerRef.current !== null) {
      window.clearInterval(playbackMonitorTimerRef.current);
      playbackMonitorTimerRef.current = null;
    }

    scheduledChunkWindowsRef.current.clear();
  }, []);

  const releaseLookaheadWaiters = useCallback(() => {
    lookaheadWaitersRef.current.splice(0).forEach((resolve) => resolve());
  }, []);

  const stopAudio = useCallback(() => {
    clearPlaybackTimers();
    releaseLookaheadWaiters();
    scheduledSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Ignore already-stopped nodes.
      }
      source.disconnect();
    });
    scheduledSourcesRef.current.clear();
    scheduledEndTimeRef.current = 0;

    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  }, [clearPlaybackTimers, releaseLookaheadWaiters]);

  const saveProgress = useCallback(async (messageId: string, index: number) => {
    try {
      await api.patch(`/tts/progress/${messageId}`, { chunkIndex: index });
    } catch {
      // ignore
    }
  }, []);

  const fetchProgress = useCallback(async (messageId: string): Promise<number> => {
    try {
      const res = await api.get(`/tts/progress/${messageId}`);
      return res.chunkIndex || 0;
    } catch {
      return 0;
    }
  }, []);

  const reset = useCallback(() => {
    playbackTokenRef.current += 1;
    stopAudio();
    chunksRef.current = [];
    messageIdRef.current = null;
    currentChunkIndexRef.current = 0;
    playbackLookaheadBaseIndexRef.current = 0;
    textRef.current = "";
    textChunksRef.current = [];
    pendingResumeChunkIndexRef.current = null;
    shouldAutoResumeOnVisibleRef.current = false;
    setState({
      isLoading: false,
      isPlaying: false,
      isPaused: false,
      currentChunkIndex: 0,
      loadingChunkIndex: null,
      totalChunks: 0,
      error: null,
      activeMessageId: null,
      chunks: [],
      motionAutoStopEnabled: nativeTtsEnabled ? state.motionAutoStopEnabled : false,
      motionIdleRemainingMs: null,
      motionFadeActive: false,
    });
  }, [nativeTtsEnabled, state.motionAutoStopEnabled, stopAudio]);

  const generateChunkAudioParts = useCallback(async (chunk: TTSChunk): Promise<string[]> => {
    const requestKey = chunk.parts.map((part) => part.hash).join("::");
    const cachedAudios = await Promise.all(chunk.parts.map(async (part) => part.audio || await getCachedAudio(part.hash)));
    if (cachedAudios.every(Boolean)) {
      return cachedAudios as string[];
    }

    const inFlight = inflightAudioRef.current.get(requestKey);
    if (inFlight) return inFlight;

    const request = (async () => {
      const missingParts = chunk.parts.filter((_, index) => !cachedAudios[index]);
      const response = await api.post("/tts/speak", {
        parts: missingParts.map((part) => ({
          text: part.text,
          voiceReferenceId: part.voiceReferenceId,
        })),
      });

      const audioParts = response.audioParts as Array<{ audio?: string; audioFormat?: string; mimeType?: string }> | undefined;
      if (!response.success || !audioParts || audioParts.length !== missingParts.length) {
        throw new Error(response.error || "Failed to generate audio parts");
      }

      const nextAudios = [...cachedAudios];
      for (let index = 0; index < missingParts.length; index++) {
        const responsePart = audioParts[index];
        const targetPart = missingParts[index];
        if (!targetPart) {
          throw new Error("Missing chunk part metadata");
        }
        if (!responsePart?.audio) {
          throw new Error("Missing TTS audio part");
        }
        if (responsePart.audioFormat && responsePart.audioFormat !== TTS_AUDIO_FORMAT) {
          throw new Error(`Unexpected TTS audio format: ${responsePart.audioFormat}`);
        }
        if (responsePart.mimeType && responsePart.mimeType !== TTS_AUDIO_MIME_TYPE) {
          throw new Error(`Unexpected TTS MIME type: ${responsePart.mimeType}`);
        }

        await setCachedAudio(targetPart.hash, responsePart.audio);
        const targetIndex = chunk.parts.findIndex((part) => part.hash === targetPart.hash);
        if (targetIndex >= 0) {
          nextAudios[targetIndex] = responsePart.audio;
        }
      }

      if (!nextAudios.every(Boolean)) {
        throw new Error("TTS audio parts were incomplete");
      }

      return nextAudios as string[];
    })();

    inflightAudioRef.current.set(requestKey, request);

    try {
      return await request;
    } finally {
      inflightAudioRef.current.delete(requestKey);
    }
  }, []);

  const prefetchChunk = useCallback(async (index: number) => {
    const chunk = chunksRef.current[index];
    if (!chunk || chunk.parts.every((part) => part.audio) || chunk.status === "generating") return;

    chunksRef.current = chunksRef.current.map((c, i) =>
      i === index ? { ...c, status: "generating" } : c
    );
    setState((prev) => ({ ...prev, chunks: [...chunksRef.current] }));

    try {
      const audioParts = await generateChunkAudioParts(chunk);
      chunksRef.current = chunksRef.current.map((c, i) =>
        i === index ? {
          ...c,
          parts: c.parts.map((part, partIndex) => ({ ...part, audio: audioParts[partIndex] || null })),
          status: "ready",
        } : c
      );
      setState((prev) => ({ ...prev, chunks: [...chunksRef.current] }));
    } catch {
      chunksRef.current = chunksRef.current.map((c, i) =>
        i === index ? { ...c, status: "error" } : c
      );
      setState((prev) => ({ ...prev, chunks: [...chunksRef.current] }));
    }
  }, [generateChunkAudioParts]);

  const prefetchUpcomingChunks = useCallback(async (currentIndex: number) => {
    for (let step = 1; step <= MAX_PREFETCH_AHEAD; step++) {
      const nextIndex = currentIndex + step;
      if (nextIndex >= chunksRef.current.length) return;
      await prefetchChunk(nextIndex);
    }
  }, [prefetchChunk]);

  const chunkHasAudio = useCallback((chunk: TTSChunk) => chunk.parts.every((part) => Boolean(part.audio)), []);

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  const decodeAudioBuffer = useCallback(async (hash: string, audio: string) => {
    const cachedBuffer = decodedBufferCacheRef.current.get(hash);
    if (cachedBuffer) return cachedBuffer;

    const audioContext = getAudioContext();
    const byteCharacters = atob(audio);
    const byteNumbers = new Uint8Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }

    const arrayBuffer = byteNumbers.buffer.slice(0);
    const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
    decodedBufferCacheRef.current.set(hash, decodedBuffer);
    return decodedBuffer;
  }, [getAudioContext]);

  const syncChunkState = useCallback((chunkIndex: number) => {
    currentChunkIndexRef.current = chunkIndex;
    releaseLookaheadWaiters();
    chunksRef.current = chunksRef.current.map((chunk, idx) => ({
      ...chunk,
      status: idx === chunkIndex ? "playing" : chunk.status === "playing" ? "ready" : chunk.status,
    }));

    setState((prev) => ({
      ...prev,
      isLoading: false,
      isPlaying: true,
      isPaused: false,
      currentChunkIndex: chunkIndex,
      loadingChunkIndex: null,
      error: null,
      chunks: [...chunksRef.current],
    }));

    if (messageIdRef.current) {
      void saveProgress(messageIdRef.current, chunkIndex);
    }
  }, [releaseLookaheadWaiters, saveProgress]);

  const markChunkStarted = useCallback((chunkIndex: number) => {
    const existingTimer = scheduledChunkTimersRef.current.get(chunkIndex);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      scheduledChunkTimersRef.current.delete(chunkIndex);
    }

    if (chunkIndex < currentChunkIndexRef.current) {
      return;
    }

    playbackLookaheadBaseIndexRef.current = chunkIndex;
    void prefetchUpcomingChunks(chunkIndex);
    syncChunkState(chunkIndex);
  }, [prefetchUpcomingChunks, syncChunkState]);

  const scheduleChunkStart = useCallback((chunkIndex: number, startAt: number, token: number) => {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    const delayMs = Math.max(0, (startAt - audioContext.currentTime) * 1000);
    const timerId = window.setTimeout(() => {
      if (token !== playbackTokenRef.current) return;
      if (chunkIndex <= currentChunkIndexRef.current) {
        scheduledChunkTimersRef.current.delete(chunkIndex);
        return;
      }
      markChunkStarted(chunkIndex);
      scheduledChunkTimersRef.current.delete(chunkIndex);
    }, delayMs);

    scheduledChunkTimersRef.current.set(chunkIndex, timerId);
  }, [markChunkStarted]);

  const schedulePlaybackCompletion = useCallback((token: number) => {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    if (playbackCompletionTimerRef.current !== null) {
      window.clearTimeout(playbackCompletionTimerRef.current);
    }

    const remainingMs = Math.max(0, (scheduledEndTimeRef.current - audioContext.currentTime) * 1000);
    playbackCompletionTimerRef.current = window.setTimeout(() => {
      if (token !== playbackTokenRef.current) return;
      chunksRef.current = chunksRef.current.map((chunk) => ({
        ...chunk,
        status: chunk.status === "playing" ? "ready" : chunk.status,
      }));
      setState((prev) => ({
        ...prev,
        isLoading: false,
        isPlaying: false,
        isPaused: false,
        loadingChunkIndex: null,
        chunks: [...chunksRef.current],
      }));
    }, remainingMs);
  }, []);

  const startPlaybackMonitor = useCallback((token: number) => {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    if (playbackMonitorTimerRef.current !== null) {
      window.clearInterval(playbackMonitorTimerRef.current);
    }

    playbackMonitorTimerRef.current = window.setInterval(() => {
      if (token !== playbackTokenRef.current) return;
      const currentTime = audioContext.currentTime;

      let activeChunkIndex: number | null = null;
      for (const [chunkIndex, windowRange] of scheduledChunkWindowsRef.current.entries()) {
        if (currentTime >= windowRange.startAt && currentTime < windowRange.endAt) {
          if (activeChunkIndex === null || chunkIndex > activeChunkIndex) {
            activeChunkIndex = chunkIndex;
          }
        }
      }

      if (activeChunkIndex !== null && activeChunkIndex !== currentChunkIndexRef.current) {
        syncChunkState(activeChunkIndex);
      }
    }, 100);
  }, [syncChunkState]);

  const playFromChunk = useCallback(async (startIndex: number, token: number) => {
    stopAudio();
    const audioContext = getAudioContext();
    scheduledEndTimeRef.current = audioContext.currentTime;
    startPlaybackMonitor(token);

    for (let i = startIndex; i < chunksRef.current.length; i++) {
      if (token !== playbackTokenRef.current) return;

      while (i - playbackLookaheadBaseIndexRef.current > MAX_PREFETCH_AHEAD) {
        if (token !== playbackTokenRef.current) return;
        await new Promise<void>((resolve) => {
          lookaheadWaitersRef.current.push(resolve);
        });
      }

      let chunk = chunksRef.current[i];
      if (!chunk) return;

      if (!chunkHasAudio(chunk)) {
        chunksRef.current = chunksRef.current.map((c, idx) =>
          idx === i ? { ...c, status: "generating" } : c.status === "playing" ? { ...c, status: "ready" } : c
        );
        setState((prev) => ({
          ...prev,
          isLoading: true,
          isPlaying: true,
          isPaused: false,
          loadingChunkIndex: i,
          error: null,
          chunks: [...chunksRef.current],
        }));

        try {
          const audioParts = await generateChunkAudioParts(chunk);
          if (token !== playbackTokenRef.current) return;

          chunksRef.current = chunksRef.current.map((c, idx) =>
            idx === i ? {
              ...c,
              parts: c.parts.map((part, partIndex) => ({ ...part, audio: audioParts[partIndex] || null })),
              status: "ready",
            } : c
          );
          chunk = chunksRef.current[i];
          if (!chunk) return;
        } catch (err) {
          if (token !== playbackTokenRef.current) return;

          const isHiddenDocument = typeof document !== "undefined" && document.hidden;
          if (isHiddenDocument) {
            pendingResumeChunkIndexRef.current = i;
            shouldAutoResumeOnVisibleRef.current = true;
            chunksRef.current = chunksRef.current.map((c, idx) =>
              idx === i ? { ...c, status: "pending" } : c
            );
            setState((prev) => ({
              ...prev,
              isLoading: false,
              isPlaying: false,
              isPaused: true,
              loadingChunkIndex: null,
              error: null,
              chunks: [...chunksRef.current],
            }));
            return;
          }

          chunksRef.current = chunksRef.current.map((c, idx) =>
            idx === i ? { ...c, status: "error" } : c
          );
          setState((prev) => ({
            ...prev,
            isLoading: false,
            isPlaying: false,
            isPaused: false,
            loadingChunkIndex: null,
            error: err instanceof Error ? err.message : "TTS error",
            chunks: [...chunksRef.current],
          }));
          return;
        }
      }

      if (token !== playbackTokenRef.current || !chunkHasAudio(chunk)) return;

      const decodedParts = [] as AudioBuffer[];
      for (const part of chunk.parts) {
        if (!part.audio) return;
        const decodedBuffer = await decodeAudioBuffer(part.hash, part.audio);
        if (token !== playbackTokenRef.current) return;
        decodedParts.push(decodedBuffer);
      }

      const startAt = Math.max(audioContext.currentTime + PLAYBACK_START_DELAY_SECONDS, scheduledEndTimeRef.current);
      let nextPartStartAt = startAt;
      let lastSource: AudioBufferSourceNode | null = null;

      decodedParts.forEach((decodedBuffer, partIndex) => {
        const source = audioContext.createBufferSource();
        source.buffer = decodedBuffer;
        source.connect(audioContext.destination);
        source.playbackRate.value = playbackSpeedRef.current;

        if (partIndex === decodedParts.length - 1) {
          source.onended = () => {
            scheduledSourcesRef.current.delete(i);
            scheduledChunkWindowsRef.current.delete(i);
            source.disconnect();

            if (token !== playbackTokenRef.current) return;

            const nextIndex = i + 1;
            if (nextIndex < chunksRef.current.length) {
              chunksRef.current = chunksRef.current.map((chunk, idx) => ({
                ...chunk,
                status: idx === i && chunk.status === "playing" ? "ready" : chunk.status,
              }));

              if (scheduledSourcesRef.current.has(nextIndex) && currentChunkIndexRef.current < nextIndex) {
                markChunkStarted(nextIndex);
              } else {
                setState((prev) => ({
                  ...prev,
                  isLoading: true,
                  isPlaying: false,
                  isPaused: true,
                  currentChunkIndex: nextIndex,
                  loadingChunkIndex: nextIndex,
                  error: null,
                  chunks: [...chunksRef.current],
                }));
              }
              return;
            }

            chunksRef.current = chunksRef.current.map((chunk) => ({
              ...chunk,
              status: chunk.status === "playing" ? "ready" : chunk.status,
            }));
            setState((prev) => ({
              ...prev,
              isLoading: false,
              isPlaying: false,
              isPaused: false,
              loadingChunkIndex: null,
              chunks: [...chunksRef.current],
            }));
          };
        }

        source.start(nextPartStartAt);
        nextPartStartAt += decodedBuffer.duration / playbackSpeedRef.current;
        lastSource = source;
      });

      const endAt = nextPartStartAt;
      scheduledChunkWindowsRef.current.set(i, { startAt, endAt });

      if (lastSource) {
        scheduledSourcesRef.current.set(i, lastSource);
      }
      scheduledEndTimeRef.current = endAt;
      scheduleChunkStart(i, startAt, token);
      schedulePlaybackCompletion(token);

      const shouldSyncImmediately = startAt - audioContext.currentTime <= PLAYBACK_START_DELAY_SECONDS * 2;
      if (i === startIndex || (shouldSyncImmediately && currentChunkIndexRef.current !== i)) {
        markChunkStarted(i);
      }
    }
  }, [chunkHasAudio, decodeAudioBuffer, generateChunkAudioParts, getAudioContext, markChunkStarted, scheduleChunkStart, schedulePlaybackCompletion, startPlaybackMonitor, stopAudio]);

  const jumpToChunk = useCallback(async (index: number) => {
    if (nativeTtsEnabled && nativeTtsPlugin) {
      await nativeTtsPlugin.seekToChunk({ chunkIndex: index });
      return;
    }

    if (index < 0 || index >= chunksRef.current.length) return;

    const token = ++playbackTokenRef.current;
    currentChunkIndexRef.current = index;
    playbackLookaheadBaseIndexRef.current = index;
    chunksRef.current = chunksRef.current.map((c, idx) => ({
      ...c,
      status: idx === index
        ? (chunkHasAudio(c) ? "ready" : c.status)
        : c.status === "playing"
          ? "ready"
          : c.status,
    }));

    const targetChunk = chunksRef.current[index];
    if (!targetChunk) return;
    setState((prev) => ({
      ...prev,
      isLoading: !chunkHasAudio(targetChunk),
      isPlaying: true,
      isPaused: false,
      currentChunkIndex: index,
      loadingChunkIndex: chunkHasAudio(targetChunk) ? null : index,
      error: null,
      chunks: [...chunksRef.current],
    }));

    stopAudio();
    await playFromChunk(index, token);
  }, [chunkHasAudio, nativeTtsEnabled, nativeTtsPlugin, playFromChunk, stopAudio]);

  const startPlayback = useCallback(async (
    text: string,
    messageId: string,
    startChunkIndex: number = -1,
    voiceReferenceId: string | null = null,
    options: StartPlaybackOptions = {}
  ) => {
    const context = {
      ...speakerContextRef.current,
      defaultVoiceReferenceId: voiceReferenceId ?? speakerContextRef.current.defaultVoiceReferenceId,
    };
    const contextSignature = buildSpeakerContextSignature(context);
    const chunkPlans = buildChunkPlans(text, context, options.streaming ? { completeSentencesOnly: true } : {});
    const nativeChunkDescriptors = chunkPlans.map((chunk) => ({
      displayText: chunk.displayText,
      parts: chunk.parts.map((part) => ({
        text: part.text,
        speakerKey: part.speakerKey,
        speakerLabel: part.speakerLabel,
        voiceReferenceId: part.voiceReferenceId,
      })),
    }));

    if (nativeTtsEnabled && nativeTtsPlugin) {
      messageIdRef.current = messageId;
      textRef.current = text;

      if (startChunkIndex < 0) {
        startChunkIndex = options.streaming ? 0 : await fetchProgress(messageId);
      }

      const textChunks = chunkPlans.map((chunk) => chunk.text);
      textChunksRef.current = textChunks;

      if (textChunks.length === 0) {
        setState((prev) => ({
          ...prev,
          activeMessageId: messageId,
          totalChunks: 0,
          chunks: [],
          motionIdleRemainingMs: null,
          motionFadeActive: false,
        }));
        return;
      }

      startChunkIndex = Math.max(0, Math.min(startChunkIndex, textChunks.length - 1));
      chunksRef.current = buildTtsChunks(messageId, chunkPlans, contextSignature).map((chunk, index) => ({
        ...chunk,
        status: index === startChunkIndex ? "generating" : chunk.status,
      }));

      currentChunkIndexRef.current = startChunkIndex;
      playbackLookaheadBaseIndexRef.current = startChunkIndex;

      setState({
        isLoading: true,
        isPlaying: false,
        isPaused: false,
        currentChunkIndex: startChunkIndex,
        loadingChunkIndex: startChunkIndex,
        totalChunks: textChunks.length,
        error: null,
        activeMessageId: messageId,
        chunks: [...chunksRef.current],
        motionAutoStopEnabled: state.motionAutoStopEnabled,
        motionIdleRemainingMs: null,
        motionFadeActive: false,
      });

      await nativeTtsPlugin.startPlayback({
        messageId,
        chunks: nativeChunkDescriptors,
        speakerMappings: context.speakerMappings.map((mapping) => ({
          speakerKey: mapping.speakerKey,
          speakerLabel: mapping.speakerLabel,
          voiceReferenceId: mapping.voiceReferenceId,
        })),
        defaultVoiceReferenceId: context.defaultVoiceReferenceId,
        startChunkIndex,
        playbackSpeed: playbackSpeedRef.current,
        baseUrl: window.location.origin,
        streaming: Boolean(options.streaming),
      });
      return;
    }

    reset();
    const requestToken = playbackTokenRef.current;
    messageIdRef.current = messageId;
    textRef.current = text;

    if (startChunkIndex < 0) {
      startChunkIndex = options.streaming ? 0 : await fetchProgress(messageId);
      if (requestToken !== playbackTokenRef.current) return;
    }

    const textChunks = chunkPlans.map((chunk) => chunk.text);
    textChunksRef.current = textChunks;

    if (requestToken !== playbackTokenRef.current) return;

    if (textChunks.length === 0) {
      setState((prev) => ({
        ...prev,
        activeMessageId: messageId,
        motionIdleRemainingMs: null,
        motionFadeActive: false,
      }));
      return;
    }

    startChunkIndex = Math.max(0, Math.min(startChunkIndex, textChunks.length - 1));

    const builtChunks: TTSChunk[] = [];
    const initialChunks = buildTtsChunks(messageId, chunkPlans, contextSignature);
    for (const chunk of initialChunks) {
      const partsWithAudio = await Promise.all(chunk.parts.map(async (part) => ({
        ...part,
        audio: part.audio || await getCachedAudio(part.hash),
      })));
      builtChunks.push({
        ...chunk,
        parts: partsWithAudio,
        status: partsWithAudio.every((part) => part.audio) ? "ready" : chunk.status,
      });
    }

    chunksRef.current = builtChunks;

    if (requestToken !== playbackTokenRef.current) return;

    currentChunkIndexRef.current = startChunkIndex;
    playbackLookaheadBaseIndexRef.current = startChunkIndex;
    const startChunk = chunksRef.current[startChunkIndex];
    if (!startChunk) return;

    setState({
      isLoading: !chunkHasAudio(startChunk),
      isPlaying: false,
      isPaused: false,
      currentChunkIndex: startChunkIndex,
      loadingChunkIndex: chunkHasAudio(startChunk) ? null : startChunkIndex,
      totalChunks: textChunks.length,
      error: null,
      activeMessageId: messageId,
      chunks: [...chunksRef.current],
      motionAutoStopEnabled: state.motionAutoStopEnabled,
      motionIdleRemainingMs: null,
      motionFadeActive: false,
    });

    void prefetchUpcomingChunks(startChunkIndex);

    const token = ++playbackTokenRef.current;
    await playFromChunk(startChunkIndex, token);
  }, [chunkHasAudio, fetchProgress, nativeTtsEnabled, nativeTtsPlugin, playFromChunk, prefetchUpcomingChunks, reset, state.motionAutoStopEnabled]);

  const syncStreamingPlayback = useCallback(async (
    text: string,
    messageId: string,
    voiceReferenceId: string | null = null,
  ) => {
    if (messageIdRef.current !== messageId && state.activeMessageId !== messageId) {
      return;
    }

    const context = {
      ...speakerContextRef.current,
      defaultVoiceReferenceId: voiceReferenceId ?? speakerContextRef.current.defaultVoiceReferenceId,
    };
    const contextSignature = buildSpeakerContextSignature(context);
    const nextChunkPlans = buildChunkPlans(text, context, { completeSentencesOnly: true });
    const nextChunkTexts = nextChunkPlans.map((chunk) => chunk.text);
    const previousChunkTexts = textChunksRef.current;

    textRef.current = text;

    if (nextChunkTexts.length === 0) {
      return;
    }

    if (previousChunkTexts.length === 0 && state.activeMessageId === messageId && chunksRef.current.length === 0) {
      await startPlayback(text, messageId, 0, null, { streaming: true });
      return;
    }

    if (chunkTextArraysMatch(previousChunkTexts, nextChunkTexts)) {
      return;
    }

    textChunksRef.current = nextChunkTexts;
    const previousChunks = chunksRef.current;
    chunksRef.current = buildTtsChunks(messageId, nextChunkPlans, contextSignature, previousChunks).map((chunk, index) => {
      const previousChunk = previousChunks[index];
      if (!previousChunk) {
        return chunk;
      }

      return {
        ...chunk,
        parts: chunk.parts.map((part, partIndex) => {
          const previousPart = previousChunk.parts[partIndex];
          return previousPart && previousPart.hash === part.hash
            ? { ...part, audio: previousPart.audio }
            : part;
        }),
        status: index === currentChunkIndexRef.current && previousChunk.status === "playing"
          ? "playing"
          : previousChunk.status,
      };
    });

    setState((prev) => ({
      ...prev,
      totalChunks: nextChunkTexts.length,
      chunks: [...chunksRef.current],
    }));

    if (nativeTtsEnabled && nativeTtsPlugin) {
      await nativeTtsPlugin.updatePlaybackChunks({
        messageId,
        chunks: nextChunkPlans.map((chunk) => ({
          displayText: chunk.displayText,
          parts: chunk.parts.map((part) => ({
            text: part.text,
            speakerKey: part.speakerKey,
            speakerLabel: part.speakerLabel,
            voiceReferenceId: part.voiceReferenceId,
          })),
        })),
        speakerMappings: speakerContextRef.current.speakerMappings.map((mapping) => ({
          speakerKey: mapping.speakerKey,
          speakerLabel: mapping.speakerLabel,
          voiceReferenceId: mapping.voiceReferenceId,
        })),
        defaultVoiceReferenceId: speakerContextRef.current.defaultVoiceReferenceId,
      });
      return;
    }

    void prefetchUpcomingChunks(currentChunkIndexRef.current);

    if ((state.isPlaying || state.isLoading) && currentChunkIndexRef.current >= previousChunkTexts.length - 1) {
      const token = ++playbackTokenRef.current;
      await playFromChunk(currentChunkIndexRef.current, token);
    }
  }, [nativeTtsEnabled, nativeTtsPlugin, playFromChunk, prefetchUpcomingChunks, startPlayback, state.activeMessageId, state.isLoading, state.isPlaying]);

  const pause = useCallback(() => {
    if (nativeTtsEnabled && nativeTtsPlugin) {
      void nativeTtsPlugin.pause();
      return;
    }

    playbackTokenRef.current += 1;
    shouldAutoResumeOnVisibleRef.current = false;
    pendingResumeChunkIndexRef.current = null;
    stopAudio();
    chunksRef.current = chunksRef.current.map((chunk) => ({
      ...chunk,
      status: chunk.status === "playing" ? "ready" : chunk.status,
    }));
    setState((prev) => ({
      ...prev,
      isLoading: false,
      isPaused: true,
      isPlaying: false,
      loadingChunkIndex: null,
      chunks: [...chunksRef.current],
    }));
  }, [nativeTtsEnabled, nativeTtsPlugin, stopAudio]);

  const resume = useCallback(async () => {
    if (nativeTtsEnabled && nativeTtsPlugin) {
      await nativeTtsPlugin.resume();
      return;
    }

    if (chunksRef.current.length === 0) return;

    const resumeIdx = Math.max(0, Math.min(currentChunkIndexRef.current, chunksRef.current.length - 1));

    const token = ++playbackTokenRef.current;
    await playFromChunk(resumeIdx, token);
  }, [nativeTtsEnabled, nativeTtsPlugin, playFromChunk]);

  const toggle = useCallback(async (text: string, messageId: string, voiceReferenceId: string | null = null) => {
    if (state.activeMessageId === messageId) {
      if (state.isPlaying) {
        pause();
      } else if (state.isPaused) {
        await resume();
      } else {
        await startPlayback(text, messageId, -1, voiceReferenceId);
      }
    } else {
      await startPlayback(text, messageId, -1, voiceReferenceId);
    }
  }, [pause, resume, startPlayback, state.activeMessageId, state.isPaused, state.isPlaying]);

  const nextChunk = useCallback(async () => {
    if (nativeTtsEnabled && nativeTtsPlugin) {
      await nativeTtsPlugin.nextChunk();
      return;
    }
    await jumpToChunk(currentChunkIndexRef.current + 1);
  }, [jumpToChunk, nativeTtsEnabled, nativeTtsPlugin]);

  const prevChunk = useCallback(async () => {
    if (nativeTtsEnabled && nativeTtsPlugin) {
      await nativeTtsPlugin.prevChunk();
      return;
    }
    await jumpToChunk(currentChunkIndexRef.current - 1);
  }, [jumpToChunk, nativeTtsEnabled, nativeTtsPlugin]);

  const seekToChunk = useCallback(async (chunkIndex: number) => {
    await jumpToChunk(chunkIndex);
  }, [jumpToChunk]);

  const startFromWord = useCallback(async (
    text: string,
    messageId: string,
    wordIndex: number,
    voiceReferenceId: string | null = null
  ) => {
    const textChunks = buildChunkPlans(text, speakerContextRef.current).map((chunk) => chunk.text);
    const chunkIndex = findChunkForWordIndex(textChunks, wordIndex);
    await startPlayback(text, messageId, chunkIndex, voiceReferenceId);
  }, [startPlayback]);

  const setPlaybackSpeed = useCallback(async (nextSpeed: number) => {
    const clampedSpeed = Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, nextSpeed));
    playbackSpeedRef.current = clampedSpeed;
    setPlaybackSpeedState(clampedSpeed);

    if (nativeTtsEnabled && nativeTtsPlugin) {
      await nativeTtsPlugin.setPlaybackSpeed({ playbackSpeed: clampedSpeed });
      return;
    }

    if (state.isPlaying || state.isLoading) {
      const token = ++playbackTokenRef.current;
      await playFromChunk(currentChunkIndexRef.current, token);
    }
  }, [nativeTtsEnabled, nativeTtsPlugin, playFromChunk, state.isLoading, state.isPlaying]);

  useEffect(() => {
    if (nativeTtsEnabled) return;
    if (typeof document === "undefined") return;

    const handleVisibilityChange = () => {
      if (document.hidden) return;
      const resumeChunkIndex = pendingResumeChunkIndexRef.current;
      if (!shouldAutoResumeOnVisibleRef.current || resumeChunkIndex === null) return;

      shouldAutoResumeOnVisibleRef.current = false;
      pendingResumeChunkIndexRef.current = null;

      const token = ++playbackTokenRef.current;
      void playFromChunk(resumeChunkIndex, token);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [nativeTtsEnabled, playFromChunk]);

  return {
    ...state,
    playbackSpeed,
    setSpeakerContext,
    setPlaybackSpeed,
    startPlayback,
    syncStreamingPlayback,
    pause,
    resume,
    toggle,
    nextChunk,
    prevChunk,
    seekToChunk,
    startFromWord,
    stop: nativeTtsEnabled && nativeTtsPlugin
      ? async () => {
          await nativeTtsPlugin.stop();
          reset();
        }
      : reset,
  };
}

export default useChunkedVastTTS;
