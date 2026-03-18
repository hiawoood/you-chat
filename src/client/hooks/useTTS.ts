import { useState, useCallback, useRef, useEffect } from "react";

interface TTSChunk {
  id: number;
  text: string;
  audio: Float32Array | null;
  duration: number;
  status: "pending" | "generating" | "ready" | "error";
}

interface TTSState {
  isLoading: boolean;
  isPlaying: boolean;
  isModelLoading: boolean;
  progress: number;
  currentTime: number;
  totalDuration: number;
  activeText: string | null;
  activeMessageId: string | null;
  error: string | null;
}

const CHUNK_SIZE = 500;
const FIRST_CHUNK_SIZE = 200; // Smaller first chunk for faster start
const SAMPLE_RATE = 24000;

// Strip markdown formatting for TTS
function stripMarkdown(text: string): string {
  return (
    text
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/(\*{1,2}|_{1,2})(.+?)\1/g, "$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*>>\s*/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^\s*[-*_]{3,}\s*$/gm, "")
      .replace(/<[^\u003e]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// Split text into chunks - first chunk is smaller for faster initial playback
function createChunks(text: string): TTSChunk[] {
  const sentences = text.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
  const chunks: TTSChunk[] = [];
  let currentChunk = "";
  let chunkId = 0;
  let isFirstChunk = true;
  const maxChunkSize = isFirstChunk ? FIRST_CHUNK_SIZE : CHUNK_SIZE;

  for (const sentence of sentences) {
    const currentMax = chunkId === 0 ? FIRST_CHUNK_SIZE : CHUNK_SIZE;
    
    if ((currentChunk + sentence).length > currentMax && currentChunk.length > 0) {
      chunks.push({
        id: chunkId++,
        text: currentChunk.trim(),
        audio: null,
        duration: 0,
        status: "pending",
      });
      currentChunk = sentence;
      isFirstChunk = false;
    } else {
      currentChunk += " " + sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push({
      id: chunkId++,
      text: currentChunk.trim(),
      audio: null,
      duration: 0,
      status: "pending",
    });
  }

  return chunks;
}

export function useTTS() {
  const [state, setState] = useState<TTSState>({
    isLoading: false,
    isPlaying: false,
    isModelLoading: false,
    progress: 0,
    currentTime: 0,
    totalDuration: 0,
    activeText: null,
    activeMessageId: null,
    error: null,
  });

  const workerRef = useRef<Worker | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const chunksRef = useRef<TTSChunk[]>([]);
  const currentChunkIndexRef = useRef(0);
  const startTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number>(0);
  const isCancelledRef = useRef(false);
  const hasStartedPlayingRef = useRef(false);

  // Initialize worker
  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL("../workers/tts.worker.ts", import.meta.url),
        { type: "module" }
      );

      workerRef.current.onmessage = (event) => {
        const { type, chunkId, audio, sampleRate, progress, error } = event.data;

        if (type === "progress") {
          setState((prev) => ({ ...prev, progress }));
        } else if (type === "model-loading") {
          setState((prev) => ({ ...prev, isModelLoading: true }));
        } else if (type === "model-ready") {
          setState((prev) => ({ ...prev, isModelLoading: false, progress: 100 }));
        } else if (type === "chunk-ready") {
          const chunk = chunksRef.current[chunkId];
          if (chunk) {
            chunk.audio = audio;
            chunk.duration = audio.length / (sampleRate || SAMPLE_RATE);
            chunk.status = "ready";

            // Update total duration
            const totalDuration = chunksRef.current.reduce(
              (sum, c) => sum + (c.duration || 3),
              0
            );
            setState((prev) => ({ ...prev, totalDuration }));

            // Start playing if this is the first chunk and we haven't started yet
            if (chunkId === 0 && !hasStartedPlayingRef.current && !isCancelledRef.current) {
              hasStartedPlayingRef.current = true;
              playChunk(0);
              startProgressUpdates();
            }
          }
        } else if (type === "chunk-error") {
          const chunk = chunksRef.current[chunkId];
          if (chunk) {
            chunk.status = "error";
          }
        }
      };
    }
    return workerRef.current;
  }, []);

  // Stop everything
  const stop = useCallback(() => {
    isCancelledRef.current = true;
    hasStartedPlayingRef.current = false;

    // Clear worker queue
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "clear" });
    }

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.onended = null;
        sourceNodeRef.current.stop();
      } catch {}
      sourceNodeRef.current = null;
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }

    chunksRef.current = [];
    currentChunkIndexRef.current = 0;
    startTimeRef.current = 0;

    setState({
      isLoading: false,
      isPlaying: false,
      isModelLoading: false,
      progress: 0,
      currentTime: 0,
      totalDuration: 0,
      activeText: null,
      activeMessageId: null,
      error: null,
    });
  }, []);

  // Initialize AudioContext
  const initAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioContext();
    }
    if (audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  // Update progress
  const startProgressUpdates = useCallback(() => {
    const updateProgress = () => {
      if (!state.isPlaying || !audioContextRef.current) return;

      const currentChunk = chunksRef.current[currentChunkIndexRef.current];
      if (currentChunk) {
        const elapsedInChunk = audioContextRef.current.currentTime - startTimeRef.current;
        let totalElapsed = 0;

        for (let i = 0; i < currentChunkIndexRef.current; i++) {
          totalElapsed += chunksRef.current[i]?.duration || 0;
        }
        totalElapsed += Math.min(elapsedInChunk, currentChunk.duration);
        setState((prev) => ({ ...prev, currentTime: Math.max(0, totalElapsed) }));
      }

      animationFrameRef.current = requestAnimationFrame(updateProgress);
    };

    animationFrameRef.current = requestAnimationFrame(updateProgress);
  }, [state.isPlaying]);

  // Play a chunk
  const playChunk = useCallback(
    async (chunkIndex: number) => {
      if (isCancelledRef.current) return;

      const audioContext = initAudioContext();
      const chunk = chunksRef.current[chunkIndex];

      if (!chunk || !chunk.audio) {
        const nextIndex = chunkIndex + 1;
        if (nextIndex < chunksRef.current.length) {
          setTimeout(() => playChunk(nextIndex), 100);
        } else {
          setState((prev) => ({ ...prev, isPlaying: false }));
        }
        return;
      }

      const audioBuffer = audioContext.createBuffer(1, chunk.audio.length, SAMPLE_RATE);
      audioBuffer.copyToChannel(chunk.audio, 0);

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      sourceNodeRef.current = source;

      currentChunkIndexRef.current = chunkIndex;

      source.start(0);
      startTimeRef.current = audioContext.currentTime;
      setState((prev) => ({ ...prev, isPlaying: true }));

      source.onended = () => {
        if (isCancelledRef.current) return;
        const nextIndex = chunkIndex + 1;
        if (nextIndex < chunksRef.current.length) {
          playChunk(nextIndex);
        } else {
          setState((prev) => ({ ...prev, isPlaying: false }));
        }
      };
    },
    [initAudioContext]
  );

  // Start TTS
  const play = useCallback(
    async (text: string, messageId: string) => {
      stop();

      isCancelledRef.current = false;
      hasStartedPlayingRef.current = false;

      setState((prev) => ({
        ...prev,
        isLoading: true,
        activeText: text,
        activeMessageId: messageId,
        error: null,
        currentTime: 0,
        totalDuration: 0,
      }));

      const worker = getWorker();
      const plainText = stripMarkdown(text);
      const chunks = createChunks(plainText);
      chunksRef.current = chunks;

      setState((prev) => ({
        ...prev,
        totalDuration: chunks.length * 3,
        isLoading: false,
      }));

      // Send all chunks to worker for generation
      chunks.forEach((chunk) => {
        worker.postMessage({
          type: "generate",
          text: chunk.text,
          chunkId: chunk.id,
        });
      });
    },
    [getWorker, stop]
  );

  // Pause playback
  const pause = useCallback(() => {
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.onended = null;
        sourceNodeRef.current.stop();
      } catch {}
      sourceNodeRef.current = null;
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }

    setState((prev) => ({ ...prev, isPlaying: false }));
  }, []);

  // Resume playback
  const resume = useCallback(() => {
    if (chunksRef.current.length === 0) return;
    const currentChunk = chunksRef.current[currentChunkIndexRef.current];
    if (currentChunk?.status === "ready") {
      playChunk(currentChunkIndexRef.current);
      startProgressUpdates();
    }
  }, [playChunk, startProgressUpdates]);

  // Toggle play/pause
  const toggle = useCallback(
    async (text: string, messageId: string) => {
      if (state.activeMessageId === messageId) {
        if (state.isPlaying) {
          pause();
        } else {
          resume();
        }
      } else {
        await play(text, messageId);
      }
    },
    [state.activeMessageId, state.isPlaying, pause, resume, play]
  );

  // Seek (simplified)
  const seek = useCallback((time: number) => {
    setState((prev) => ({ ...prev, currentTime: time }));
  }, []);

  // Initialize worker and preload model on first interaction
  useEffect(() => {
    const worker = getWorker();
    
    // Preload model after a short delay (on mount)
    const preloadTimer = setTimeout(() => {
      worker.postMessage({ type: "preload" });
    }, 1000);

    return () => {
      clearTimeout(preloadTimer);
    };
  }, [getWorker]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.onended = null;
          sourceNodeRef.current.stop();
        } catch {}
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if (workerRef.current) {
        workerRef.current.terminate();
      }
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && state.activeMessageId && !e.repeat) {
        const target = e.target as HTMLElement;
        if (
          target.tagName !== "INPUT" &&
          target.tagName !== "TEXTAREA" &&
          !target.isContentEditable
        ) {
          e.preventDefault();
          if (state.isPlaying) {
            pause();
          } else {
            resume();
          }
        }
      }

      if (e.code === "Escape" && state.activeMessageId) {
        stop();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.activeMessageId, state.isPlaying, pause, resume, stop]);

  return {
    ...state,
    play,
    pause,
    resume,
    stop,
    toggle,
    seek,
  };
}
