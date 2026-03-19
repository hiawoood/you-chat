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
    // Evict oldest if too many
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    if (keys.length >= MAX_CACHE_ENTRIES) {
      // Remove first N entries to make room
      keys.slice(0, 10).forEach((k) => localStorage.removeItem(k));
    }
    localStorage.setItem(CACHE_PREFIX + hash, audio);
  } catch {
    // Storage full or unavailable — ignore
  }
}

// ---- Chunking ----
// Split text into ≤100 word chunks at sentence boundaries (floor rounding)
function chunkText(text: string, targetWordsPerChunk: number = 100): string[] {
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
    totalChunks: 0,
    error: null,
    activeMessageId: null,
    chunks: [],
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const chunksRef = useRef<TTSChunk[]>([]);
  const messageIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const textRef = useRef<string>("");
  const textChunksRef = useRef<string[]>([]);

  // Stop audio element
  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, []);

  // Full reset
  const reset = useCallback(() => {
    cancelledRef.current = true;
    stopAudio();
    chunksRef.current = [];
    messageIdRef.current = null;
    textRef.current = "";
    textChunksRef.current = [];
    setState({
      isLoading: false,
      isPlaying: false,
      isPaused: false,
      currentChunkIndex: 0,
      totalChunks: 0,
      error: null,
      activeMessageId: null,
      chunks: [],
    });
  }, [stopAudio]);

  // Generate audio for a single chunk (with cache)
  const generateChunkAudio = useCallback(async (text: string, hash: string): Promise<string> => {
    const cached = getCachedAudio(hash);
    if (cached) return cached;

    const response = await api.post("/tts/speak", { text });
    if (!response.success || !response.audio) {
      throw new Error(response.error || "Failed to generate audio");
    }
    setCachedAudio(hash, response.audio);
    return response.audio;
  }, []);

  // Prefetch a chunk by index (fire-and-forget, updates chunksRef)
  const prefetchChunk = useCallback(async (index: number) => {
    const chunk = chunksRef.current[index];
    if (!chunk || chunk.audio || chunk.status === "generating") return;

    chunksRef.current = chunksRef.current.map((c, i) =>
      i === index ? { ...c, status: "generating" } : c
    );

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
    }
  }, [generateChunkAudio]);

  // Play chunk at index, then auto-advance
  const playFromChunk = useCallback(async (startIndex: number) => {
    for (let i = startIndex; i < chunksRef.current.length; i++) {
      if (cancelledRef.current) return;

      let chunk = chunksRef.current[i];

      // If audio not ready yet, generate it now
      if (!chunk.audio) {
        chunksRef.current = chunksRef.current.map((c, idx) =>
          idx === i ? { ...c, status: "generating" } : c
        );
        setState((prev) => ({
          ...prev,
          isLoading: true,
          currentChunkIndex: i,
          chunks: [...chunksRef.current],
        }));

        try {
          const audio = await generateChunkAudio(chunk.text, chunk.hash);
          if (cancelledRef.current) return;
          chunksRef.current = chunksRef.current.map((c, idx) =>
            idx === i ? { ...c, audio, status: "ready" } : c
          );
          chunk = chunksRef.current[i];
        } catch (err) {
          chunksRef.current = chunksRef.current.map((c, idx) =>
            idx === i ? { ...c, status: "error" } : c
          );
          setState((prev) => ({
            ...prev,
            isLoading: false,
            error: err instanceof Error ? err.message : "TTS error",
            chunks: [...chunksRef.current],
          }));
          return;
        }
      }

      if (cancelledRef.current || !chunk.audio) return;

      // Mark playing
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
        chunks: [...chunksRef.current],
      }));

      // Prefetch next chunk in background
      if (i + 1 < chunksRef.current.length) {
        void prefetchChunk(i + 1);
      }

      // Play audio and wait for it to finish
      stopAudio();
      const audio = new Audio(`data:audio/wav;base64,${chunk.audio}`);
      audioRef.current = audio;

      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });

      if (cancelledRef.current) return;
    }

    // Finished all chunks
    if (!cancelledRef.current) {
      setState((prev) => ({ ...prev, isPlaying: false }));
    }
  }, [generateChunkAudio, prefetchChunk, stopAudio]);

  // Start playback from a specific chunk index
  const startPlayback = useCallback(async (
    text: string,
    messageId: string,
    startChunkIndex: number = 0
  ) => {
    reset();
    cancelledRef.current = false;
    messageIdRef.current = messageId;
    textRef.current = text;

    const textChunks = chunkText(text);
    textChunksRef.current = textChunks;

    let wordOffset = 0;
    chunksRef.current = textChunks.map((t, index) => {
      const words = t.split(/\s+/).length;
      const chunk: TTSChunk = {
        id: index,
        text: t,
        hash: hashText(t),
        startWord: wordOffset,
        endWord: wordOffset + words,
        audio: getCachedAudio(hashText(t)),
        status: getCachedAudio(hashText(t)) ? "ready" : "pending",
      };
      wordOffset += words;
      return chunk;
    });

    setState({
      isLoading: true,
      isPlaying: false,
      isPaused: false,
      currentChunkIndex: startChunkIndex,
      totalChunks: textChunks.length,
      error: null,
      activeMessageId: messageId,
      chunks: [...chunksRef.current],
    });

    // Also prefetch startChunkIndex+1 eagerly
    if (startChunkIndex + 1 < textChunks.length) {
      void prefetchChunk(startChunkIndex + 1);
    }

    await playFromChunk(startChunkIndex);
  }, [reset, prefetchChunk, playFromChunk]);

  // Pause
  const pause = useCallback(() => {
    if (audioRef.current) audioRef.current.pause();
    cancelledRef.current = true;
    setState((prev) => ({ ...prev, isPaused: true, isPlaying: false }));
  }, []);

  // Resume from current chunk
  const resume = useCallback(async () => {
    cancelledRef.current = false;
    const idx = chunksRef.current.findIndex((c) => c.status === "playing");
    const resumeIdx = idx >= 0 ? idx : 0;

    // If audio element exists and is paused, just resume it
    if (audioRef.current && audioRef.current.paused && idx >= 0) {
      setState((prev) => ({ ...prev, isPaused: false, isPlaying: true }));
      audioRef.current.play().catch(() => {});

      // Wait for it to end, then auto-advance
      await new Promise<void>((resolve) => {
        if (!audioRef.current) return resolve();
        audioRef.current.onended = () => resolve();
        audioRef.current.onerror = () => resolve();
      });

      if (!cancelledRef.current && resumeIdx + 1 < chunksRef.current.length) {
        await playFromChunk(resumeIdx + 1);
      } else if (!cancelledRef.current) {
        setState((prev) => ({ ...prev, isPlaying: false }));
      }
    } else {
      await playFromChunk(resumeIdx);
    }
  }, [playFromChunk]);

  // Toggle play/pause
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
  }, [state.activeMessageId, state.isPlaying, state.isPaused, pause, resume, startPlayback]);

  // Navigate to next chunk
  const nextChunk = useCallback(async () => {
    const next = state.currentChunkIndex + 1;
    if (next >= chunksRef.current.length) return;
    cancelledRef.current = true;
    stopAudio();
    cancelledRef.current = false;
    await playFromChunk(next);
  }, [state.currentChunkIndex, stopAudio, playFromChunk]);

  // Navigate to previous chunk
  const prevChunk = useCallback(async () => {
    const prev = state.currentChunkIndex - 1;
    if (prev < 0) return;
    cancelledRef.current = true;
    stopAudio();
    cancelledRef.current = false;
    await playFromChunk(prev);
  }, [state.currentChunkIndex, stopAudio, playFromChunk]);

  // Start from specific word
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
