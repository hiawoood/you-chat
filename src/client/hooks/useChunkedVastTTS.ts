import { useState, useCallback, useRef } from "react";
import { api } from "../lib/api";

export interface TTSChunk {
  id: number;
  text: string;
  hash: string;
  startWord: number;
  endWord: number;
  audio: string | null;
  status: "pending" | "generating" | "ready" | "error" | "playing";
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
}

// ---- Browser audio cache (IndexedDB, keyed by chunk hash) ----
const CACHE_DB_NAME = "tts-audio-cache";
const CACHE_DB_VERSION = 1;
const CACHE_STORE_NAME = "clips";
let cacheDbPromise: Promise<IDBDatabase> | null = null;

interface CachedAudioRecord {
  hash: string;
  audio: string;
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

function buildChunkHash(
  messageId: string,
  chunkIndex: number,
  text: string,
  voiceReferenceId: string | null
): string {
  return hashText(`${messageId}::${chunkIndex}::${voiceReferenceId || "builtin"}::${text}`);
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
        const store = db.objectStoreNames.contains(CACHE_STORE_NAME)
          ? request.transaction?.objectStore(CACHE_STORE_NAME)
          : db.createObjectStore(CACHE_STORE_NAME, { keyPath: "hash" });

        if (store && !store.indexNames.contains("updatedAt")) {
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
export function splitTextIntoTtsChunks(text: string, targetWordsPerChunk: number = 60): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
  const chunks: string[] = [];
  let currentChunk = "";
  let currentWordCount = 0;

  for (const sentence of sentences) {
    const wordCount = sentence.trim().split(/\s+/).length;
    if (currentWordCount + wordCount > targetWordsPerChunk && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
      currentWordCount = wordCount;
    } else {
      currentChunk += " " + sentence;
      currentWordCount += wordCount;
    }
  }

  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks;
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

// ---- Hook ----
export function useChunkedVastTTS() {
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
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioWaitResolverRef = useRef<((options?: { preserveAudio?: boolean }) => void) | null>(null);
  const chunksRef = useRef<TTSChunk[]>([]);
  const messageIdRef = useRef<string | null>(null);
  const playbackTokenRef = useRef(0);
  const currentChunkIndexRef = useRef(0);
  const activeVoiceReferenceIdRef = useRef<string | null>(null);
  const inflightAudioRef = useRef(new Map<string, Promise<string>>());
  const textRef = useRef<string>("");
  const textChunksRef = useRef<string[]>([]);

  const stopAudio = useCallback((options?: { preserveAudio?: boolean }) => {
    const preserveAudio = options?.preserveAudio ?? false;

    if (audioRef.current) {
      audioRef.current.pause();
      if (!preserveAudio) {
        audioRef.current.currentTime = 0;
      }
    }

    if (audioWaitResolverRef.current) {
      const resolve = audioWaitResolverRef.current;
      audioWaitResolverRef.current = null;
      resolve({ preserveAudio });
      return;
    }

    if (!preserveAudio) {
      audioRef.current = null;
    }
  }, []);

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
    activeVoiceReferenceIdRef.current = null;
    textRef.current = "";
    textChunksRef.current = [];
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
    });
  }, [stopAudio]);

  const generateChunkAudio = useCallback(async (text: string, hash: string, voiceReferenceId: string | null): Promise<string> => {
    const cached = await getCachedAudio(hash);
    if (cached) return cached;

    const inFlight = inflightAudioRef.current.get(hash);
    if (inFlight) return inFlight;

    const request = (async () => {
      const response = await api.post("/tts/speak", { text, voiceReferenceId });
      if (!response.success || !response.audio) {
        throw new Error(response.error || "Failed to generate audio");
      }
      await setCachedAudio(hash, response.audio);
      return response.audio;
    })();

    inflightAudioRef.current.set(hash, request);

    try {
      return await request;
    } finally {
      inflightAudioRef.current.delete(hash);
    }
  }, []);

  const prefetchChunk = useCallback(async (index: number) => {
    const chunk = chunksRef.current[index];
    if (!chunk || chunk.audio || chunk.status === "generating") return;

    chunksRef.current = chunksRef.current.map((c, i) =>
      i === index ? { ...c, status: "generating" } : c
    );
    setState((prev) => ({ ...prev, chunks: [...chunksRef.current] }));

    try {
      const audio = await generateChunkAudio(chunk.text, chunk.hash, activeVoiceReferenceIdRef.current);
      chunksRef.current = chunksRef.current.map((c, i) =>
        i === index ? { ...c, audio, status: "ready" } : c
      );
      setState((prev) => ({ ...prev, chunks: [...chunksRef.current] }));
    } catch {
      chunksRef.current = chunksRef.current.map((c, i) =>
        i === index ? { ...c, status: "error" } : c
      );
      setState((prev) => ({ ...prev, chunks: [...chunksRef.current] }));
    }
  }, [generateChunkAudio]);

  const playFromChunk = useCallback(async (startIndex: number, token: number) => {
    for (let i = startIndex; i < chunksRef.current.length; i++) {
      if (token !== playbackTokenRef.current) return;

      let chunk = chunksRef.current[i];
      if (!chunk) return;
      currentChunkIndexRef.current = i;

      if (!chunk.audio) {
        chunksRef.current = chunksRef.current.map((c, idx) =>
          idx === i ? { ...c, status: "generating" } : c.status === "playing" ? { ...c, status: "ready" } : c
        );
        setState((prev) => ({
          ...prev,
          isLoading: true,
          isPlaying: true,
          isPaused: false,
          currentChunkIndex: i,
          loadingChunkIndex: i,
          error: null,
          chunks: [...chunksRef.current],
        }));

        try {
          const audio = await generateChunkAudio(chunk.text, chunk.hash, activeVoiceReferenceIdRef.current);
          if (token !== playbackTokenRef.current) return;

          chunksRef.current = chunksRef.current.map((c, idx) =>
            idx === i ? { ...c, audio, status: "ready" } : c
          );
          chunk = chunksRef.current[i];
          if (!chunk) return;
        } catch (err) {
          if (token !== playbackTokenRef.current) return;

          chunksRef.current = chunksRef.current.map((c, idx) =>
            idx === i ? { ...c, status: "error" } : c
          );
          setState((prev) => ({
            ...prev,
            isLoading: false,
            isPlaying: false,
            isPaused: false,
            currentChunkIndex: i,
            loadingChunkIndex: null,
            error: err instanceof Error ? err.message : "TTS error",
            chunks: [...chunksRef.current],
          }));
          return;
        }
      }

      if (token !== playbackTokenRef.current || !chunk.audio) return;

      chunksRef.current = chunksRef.current.map((c, idx) => ({
        ...c,
        status: idx === i ? "playing" : c.status === "playing" ? "ready" : c.status,
      }));
      setState((prev) => ({
        ...prev,
        isLoading: false,
        isPlaying: true,
        isPaused: false,
        currentChunkIndex: i,
        loadingChunkIndex: null,
        error: null,
        chunks: [...chunksRef.current],
      }));

      if (i + 1 < chunksRef.current.length) {
        void prefetchChunk(i + 1);
      }

      if (messageIdRef.current) {
        void saveProgress(messageIdRef.current, i);
      }

      stopAudio();
      const audio = new Audio(`data:audio/wav;base64,${chunk.audio}`);
      audioRef.current = audio;

      await new Promise<void>((resolve) => {
        const finish = (options?: { preserveAudio?: boolean }) => {
          if (audioWaitResolverRef.current === finish) {
            audioWaitResolverRef.current = null;
          }
          audio.onended = null;
          audio.onerror = null;
          if (!(options?.preserveAudio) && audioRef.current === audio) {
            audioRef.current = null;
          }
          resolve();
        };

        audioWaitResolverRef.current = finish;
        audio.onended = () => finish();
        audio.onerror = () => finish();
        audio.play().catch(() => finish());
      });

      if (token !== playbackTokenRef.current) return;
    }

    if (token === playbackTokenRef.current) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        isPlaying: false,
        isPaused: false,
        loadingChunkIndex: null,
      }));
    }
  }, [generateChunkAudio, prefetchChunk, saveProgress, stopAudio]);

  const jumpToChunk = useCallback(async (index: number) => {
    if (index < 0 || index >= chunksRef.current.length) return;

    const token = ++playbackTokenRef.current;
    currentChunkIndexRef.current = index;
    chunksRef.current = chunksRef.current.map((c, idx) => ({
      ...c,
      status: idx === index
        ? (c.audio ? "ready" : c.status)
        : c.status === "playing"
          ? "ready"
          : c.status,
    }));

    const targetChunk = chunksRef.current[index];
    if (!targetChunk) return;
    setState((prev) => ({
      ...prev,
      isLoading: !targetChunk.audio,
      isPlaying: true,
      isPaused: false,
      currentChunkIndex: index,
      loadingChunkIndex: targetChunk.audio ? null : index,
      error: null,
      chunks: [...chunksRef.current],
    }));

    stopAudio();
    await playFromChunk(index, token);
  }, [playFromChunk, stopAudio]);

  const startPlayback = useCallback(async (
    text: string,
    messageId: string,
    startChunkIndex: number = -1,
    voiceReferenceId: string | null = null
  ) => {
    reset();
    const requestToken = playbackTokenRef.current;
    messageIdRef.current = messageId;
    activeVoiceReferenceIdRef.current = voiceReferenceId;
    textRef.current = text;

    if (startChunkIndex < 0) {
      startChunkIndex = await fetchProgress(messageId);
      if (requestToken !== playbackTokenRef.current) return;
    }

    const textChunks = splitTextIntoTtsChunks(text);
    textChunksRef.current = textChunks;

    if (requestToken !== playbackTokenRef.current) return;

    if (textChunks.length === 0) {
      setState((prev) => ({
        ...prev,
        activeMessageId: messageId,
      }));
      return;
    }

    startChunkIndex = Math.max(0, Math.min(startChunkIndex, textChunks.length - 1));

    let wordOffset = 0;
    const builtChunks: TTSChunk[] = [];
    for (let index = 0; index < textChunks.length; index++) {
      const chunkTextValue = textChunks[index];
      if (!chunkTextValue) continue;

      const hash = buildChunkHash(messageId, index, chunkTextValue, activeVoiceReferenceIdRef.current);
      const cachedAudio = await getCachedAudio(hash);
      const words = chunkTextValue.split(/\s+/).length;

      builtChunks.push({
        id: index,
        text: chunkTextValue,
        hash,
        startWord: wordOffset,
        endWord: wordOffset + words,
        audio: cachedAudio,
        status: cachedAudio ? "ready" : "pending",
      });

      wordOffset += words;
    }

    chunksRef.current = builtChunks;

    if (requestToken !== playbackTokenRef.current) return;

    currentChunkIndexRef.current = startChunkIndex;
    const startChunk = chunksRef.current[startChunkIndex];
    if (!startChunk) return;

    setState({
      isLoading: !startChunk.audio,
      isPlaying: false,
      isPaused: false,
      currentChunkIndex: startChunkIndex,
      loadingChunkIndex: startChunk.audio ? null : startChunkIndex,
      totalChunks: textChunks.length,
      error: null,
      activeMessageId: messageId,
      chunks: [...chunksRef.current],
    });

    if (startChunkIndex + 1 < textChunks.length) {
      void prefetchChunk(startChunkIndex + 1);
    }

    const token = ++playbackTokenRef.current;
    await playFromChunk(startChunkIndex, token);
  }, [fetchProgress, playFromChunk, prefetchChunk, reset]);

  const pause = useCallback(() => {
    playbackTokenRef.current += 1;
    stopAudio({ preserveAudio: !!audioRef.current });
    setState((prev) => ({
      ...prev,
      isLoading: false,
      isPaused: true,
      isPlaying: false,
      loadingChunkIndex: null,
    }));
  }, [stopAudio]);

  const resume = useCallback(async () => {
    if (chunksRef.current.length === 0) return;

    const resumeIdx = Math.max(0, Math.min(currentChunkIndexRef.current, chunksRef.current.length - 1));

    if (audioRef.current && audioRef.current.paused) {
      const pausedAudio = audioRef.current;
      const token = ++playbackTokenRef.current;

      setState((prev) => ({
        ...prev,
        isLoading: false,
        isPaused: false,
        isPlaying: true,
        loadingChunkIndex: null,
        error: null,
      }));

      await new Promise<void>((resolve) => {
        const finish = (options?: { preserveAudio?: boolean }) => {
          if (audioWaitResolverRef.current === finish) {
            audioWaitResolverRef.current = null;
          }
          pausedAudio.onended = null;
          pausedAudio.onerror = null;
          if (!(options?.preserveAudio) && audioRef.current === pausedAudio) {
            audioRef.current = null;
          }
          resolve();
        };

        audioWaitResolverRef.current = finish;
        pausedAudio.onended = () => finish();
        pausedAudio.onerror = () => finish();
        pausedAudio.play().catch(() => finish());
      });

      if (token !== playbackTokenRef.current) return;

      if (resumeIdx + 1 < chunksRef.current.length) {
        await playFromChunk(resumeIdx + 1, token);
      } else {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          isPlaying: false,
          isPaused: false,
          loadingChunkIndex: null,
        }));
      }
      return;
    }

    const token = ++playbackTokenRef.current;
    await playFromChunk(resumeIdx, token);
  }, [playFromChunk]);

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
    await jumpToChunk(currentChunkIndexRef.current + 1);
  }, [jumpToChunk]);

  const prevChunk = useCallback(async () => {
    await jumpToChunk(currentChunkIndexRef.current - 1);
  }, [jumpToChunk]);

  const seekToChunk = useCallback(async (chunkIndex: number) => {
    await jumpToChunk(chunkIndex);
  }, [jumpToChunk]);

  const startFromWord = useCallback(async (
    text: string,
    messageId: string,
    wordIndex: number,
    voiceReferenceId: string | null = null
  ) => {
    const textChunks = splitTextIntoTtsChunks(text);
    const chunkIndex = findChunkForWordIndex(textChunks, wordIndex);
    await startPlayback(text, messageId, chunkIndex, voiceReferenceId);
  }, [startPlayback]);

  return {
    ...state,
    startPlayback,
    pause,
    resume,
    toggle,
    nextChunk,
    prevChunk,
    seekToChunk,
    startFromWord,
    stop: reset,
  };
}

export default useChunkedVastTTS;
