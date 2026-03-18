import { useState, useCallback, useRef, useEffect } from "react";

interface KokoroTTS {
  generate: (text: string, options: { voice: string }) => Promise<{ audio: Float32Array; sampleRate: number }>;
}

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
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_VOICE = "af_heart";

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
      .replace(/^\s*>\s*/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^\s*[-*_]{3,}\s*$/gm, "")
      .replace(/<[^\u003e]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
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

  const ttsRef = useRef<KokoroTTS | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const chunksRef = useRef<TTSChunk[]>([]);
  const currentChunkIndexRef = useRef(0);
  const startTimeRef = useRef<number>(0);
  const animationFrameRef = useRef<number>(0);
  const isCancelledRef = useRef(false);
  const moduleRef = useRef<typeof import("kokoro-js") | null>(null);
  const hasStartedPlayingRef = useRef(false);

  // Stop everything - SYNCHRONOUS cleanup
  const stop = useCallback(() => {
    isCancelledRef.current = true;
    hasStartedPlayingRef.current = false;

    // Stop audio immediately
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.onended = null;
        sourceNodeRef.current.stop();
      } catch {}
      sourceNodeRef.current = null;
    }

    // Cancel animation frame
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }

    // Reset refs
    chunksRef.current = [];
    currentChunkIndexRef.current = 0;
    startTimeRef.current = 0;

    // Reset state
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

  // Load Kokoro TTS model
  const loadModel = useCallback(async (): Promise<KokoroTTS | null> => {
    if (ttsRef.current) return ttsRef.current;

    setState((prev) => ({ ...prev, isModelLoading: true, progress: 0 }));

    try {
      if (!moduleRef.current) {
        moduleRef.current = await import("kokoro-js");
      }
      const { KokoroTTS } = moduleRef.current;

      const progressCallback = (progress: { loaded: number; total: number }) => {
        const percent = Math.round((progress.loaded / progress.total) * 100);
        setState((prev) => ({ ...prev, progress: percent }));
      };

      const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8",
        progress_callback: progressCallback,
      });

      ttsRef.current = tts;
      setState((prev) => ({ ...prev, isModelLoading: false, progress: 100 }));
      return tts;
    } catch (error) {
      console.error("Failed to load TTS model:", error);
      setState((prev) => ({
        ...prev,
        isModelLoading: false,
        error: "Failed to load TTS model",
      }));
      return null;
    }
  }, []);

  // Split text into chunks
  const createChunks = useCallback((text: string): TTSChunk[] => {
    const sentences = text.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
    const chunks: TTSChunk[] = [];
    let currentChunk = "";
    let chunkId = 0;

    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > CHUNK_SIZE && currentChunk.length > 0) {
        chunks.push({
          id: chunkId++,
          text: currentChunk.trim(),
          audio: null,
          duration: 0,
          status: "pending",
        });
        currentChunk = sentence;
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
  }, []);

  // Update progress
  const startProgressUpdates = useCallback(() => {
    const updateProgress = () => {
      if (!state.isPlaying || !audioContextRef.current) {
        return;
      }

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
  const playChunk = useCallback(async (chunkIndex: number) => {
    if (isCancelledRef.current) return;

    const audioContext = initAudioContext();
    const chunk = chunksRef.current[chunkIndex];

    if (!chunk || !chunk.audio) {
      // Try next chunk if available
      const nextIndex = chunkIndex + 1;
      if (nextIndex < chunksRef.current.length) {
        // Wait a bit and try next chunk
        setTimeout(() => playChunk(nextIndex), 100);
        return;
      }
      // No more chunks
      setState((prev) => ({ ...prev, isPlaying: false }));
      return;
    }

    const audioBuffer = audioContext.createBuffer(1, chunk.audio.length, 24000);
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
  }, [initAudioContext]);

  // Start TTS - begins immediately with first chunk
  const play = useCallback(async (text: string, messageId: string) => {
    // Stop any current playback first
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

    const tts = await loadModel();
    if (!tts || isCancelledRef.current) {
      setState((prev) => ({ ...prev, isLoading: false }));
      return;
    }

    const plainText = stripMarkdown(text);
    const chunks = createChunks(plainText);
    chunksRef.current = chunks;

    // Set estimated total duration
    setState((prev) => ({
      ...prev,
      totalDuration: chunks.length * 3,
      isLoading: false, // Stop loading since we start playing immediately
    }));

    // Start generating and playing FIRST chunk immediately
    // Other chunks generate in background
    const firstChunk = chunks[0];
    if (firstChunk) {
      firstChunk.status = "generating";

      // Fire generation for first chunk
      tts.generate(firstChunk.text, { voice: DEFAULT_VOICE })
        .then((result) => {
          if (isCancelledRef.current) return;
          firstChunk.audio = result.audio;
          firstChunk.duration = result.audio.length / 24000;
          firstChunk.status = "ready";

          // Update total duration
          const totalDuration = chunks.reduce((sum, c) => sum + (c.duration || 3), 0);
          setState((prev) => ({ ...prev, totalDuration }));

          // Start playing if not already started and not cancelled
          if (!hasStartedPlayingRef.current && !isCancelledRef.current) {
            hasStartedPlayingRef.current = true;
            playChunk(0);
            startProgressUpdates();
          }
        })
        .catch((err) => {
          console.error("Failed to generate first chunk:", err);
          firstChunk.status = "error";
        });
    }

    // Generate remaining chunks in background (fire and forget)
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;

      chunk.status = "generating";
      tts.generate(chunk.text, { voice: DEFAULT_VOICE })
        .then((result) => {
          if (isCancelledRef.current) return;
          chunk.audio = result.audio;
          chunk.duration = result.audio.length / 24000;
          chunk.status = "ready";

          // Update total duration
          const totalDuration = chunks.reduce((sum, c) => sum + (c.duration || 3), 0);
          setState((prev) => ({ ...prev, totalDuration }));
        })
        .catch((err) => {
          console.error(`Failed to generate chunk ${i}:`, err);
          chunk.status = "error";
        });
    }
  }, [loadModel, createChunks, playChunk, startProgressUpdates, stop]);

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
  const toggle = useCallback(async (text: string, messageId: string) => {
    if (state.activeMessageId === messageId) {
      if (state.isPlaying) {
        pause();
      } else {
        resume();
      }
    } else {
      await play(text, messageId);
    }
  }, [state.activeMessageId, state.isPlaying, pause, resume, play]);

  // Seek (simplified)
  const seek = useCallback((time: number) => {
    setState((prev) => ({ ...prev, currentTime: time }));
  }, []);

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
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && state.activeMessageId && !e.repeat) {
        const target = e.target as HTMLElement;
        if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA" && !target.isContentEditable) {
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
