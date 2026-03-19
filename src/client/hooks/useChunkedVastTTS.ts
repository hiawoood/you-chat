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

// ---- Browser audio cache (localStorage, keyed by text hash) ----
const CACHE_PREFIX = "tts_audio_";
const MAX_CACHE_ENTRIES = 50;

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return "h" + (h >>> 0).toString(36);
}

function getCachedAudio(hash: string): string | null {
  try {
    return localStorage.getItem(CACHE_PREFIX + hash);
  } catch {
    return null;
  }
}

function setCachedAudio(hash: string, audio: string): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    if (keys.length >= MAX_CACHE_ENTRIES) {
      keys.slice(0, 10).forEach((k) => localStorage.removeItem(k));
    }
    localStorage.setItem(CACHE_PREFIX + hash, audio);
  } catch {
    // Storage full or unavailable - ignore.
  }
}

// ---- Chunking ----
function chunkText(text: string, targetWordsPerChunk: number = 80): string[] {
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
    const chunkWordCount = chunks[i].trim().split(/\s+/).length;
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

  const generateChunkAudio = useCallback(async (text: string, hash: string): Promise<string> => {
    const cached = getCachedAudio(hash);
    if (cached) return cached;

    const inFlight = inflightAudioRef.current.get(hash);
    if (inFlight) return inFlight;

    const request = (async () => {
      const response = await api.post("/tts/speak", { text });
      if (!response.success || !response.audio) {
        throw new Error(response.error || "Failed to generate audio");
      }
      setCachedAudio(hash, response.audio);
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
      const audio = await generateChunkAudio(chunk.text, chunk.hash);
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
          const audio = await generateChunkAudio(chunk.text, chunk.hash);
          if (token !== playbackTokenRef.current) return;

          chunksRef.current = chunksRef.current.map((c, idx) =>
            idx === i ? { ...c, audio, status: "ready" } : c
          );
          chunk = chunksRef.current[i];
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
    startChunkIndex: number = -1
  ) => {
    reset();
    const requestToken = playbackTokenRef.current;
    messageIdRef.current = messageId;
    textRef.current = text;

    if (startChunkIndex < 0) {
      startChunkIndex = await fetchProgress(messageId);
      if (requestToken !== playbackTokenRef.current) return;
    }

    const textChunks = chunkText(text);
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
    chunksRef.current = textChunks.map((chunkTextValue, index) => {
      const hash = hashText(chunkTextValue);
      const cachedAudio = getCachedAudio(hash);
      const words = chunkTextValue.split(/\s+/).length;
      const chunk: TTSChunk = {
        id: index,
        text: chunkTextValue,
        hash,
        startWord: wordOffset,
        endWord: wordOffset + words,
        audio: cachedAudio,
        status: cachedAudio ? "ready" : "pending",
      };
      wordOffset += words;
      return chunk;
    });

    currentChunkIndexRef.current = startChunkIndex;
    const startChunk = chunksRef.current[startChunkIndex];

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

  const toggle = useCallback(async (text: string, messageId: string) => {
    if (state.activeMessageId === messageId) {
      if (state.isPlaying) {
        pause();
      } else if (state.isPaused) {
        await resume();
      } else {
        await startPlayback(text, messageId);
      }
    } else {
      await startPlayback(text, messageId);
    }
  }, [pause, resume, startPlayback, state.activeMessageId, state.isPaused, state.isPlaying]);

  const nextChunk = useCallback(async () => {
    await jumpToChunk(currentChunkIndexRef.current + 1);
  }, [jumpToChunk]);

  const prevChunk = useCallback(async () => {
    await jumpToChunk(currentChunkIndexRef.current - 1);
  }, [jumpToChunk]);

  const startFromWord = useCallback(async (
    text: string,
    messageId: string,
    wordIndex: number
  ) => {
    const textChunks = chunkText(text);
    const chunkIndex = findChunkForWordIndex(textChunks, wordIndex);
    await startPlayback(text, messageId, chunkIndex);
  }, [startPlayback]);

  return {
    ...state,
    startPlayback,
    pause,
    resume,
    toggle,
    nextChunk,
    prevChunk,
    startFromWord,
    stop: reset,
  };
}

export default useChunkedVastTTS;
