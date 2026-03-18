import { useState, useCallback, useRef, useEffect } from "react";

// Kokoro TTS types
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
  const pausedAtRef = useRef<number>(0);
  const animationFrameRef = useRef<number>(0);
  const isCancelledRef = useRef(false);
  const moduleRef = useRef<typeof import("kokoro-js") | null>(null);

  // Initialize AudioContext
  const initAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  // Load Kokoro TTS model
  const loadModel = useCallback(async (): Promise<KokoroTTS | null> => {
    if (ttsRef.current) return ttsRef.current;

    setState((prev) => ({ ...prev, isModelLoading: true, progress: 0 }));

    try {
      // Load module if not cached
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
        error: "Failed to load TTS model. Please try again.",
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

  // Generate audio for a chunk
  const generateChunkAudio = useCallback(async (
    tts: KokoroTTS,
    chunk: TTSChunk
  ): Promise<Float32Array | null> => {
    try {
      const result = await tts.generate(chunk.text, { voice: DEFAULT_VOICE });
      return result.audio;
    } catch (error) {
      console.error("Failed to generate audio for chunk:", error);
      return null;
    }
  }, []);

  // Calculate audio duration
  const getAudioDuration = useCallback((audio: Float32Array, sampleRate: number): number => {
    return audio.length / sampleRate;
  }, []);

  // Update progress
  const startProgressUpdates = useCallback(() => {
    const updateProgress = () => {
      if (!state.isPlaying || !audioContextRef.current) {
        animationFrameRef.current = requestAnimationFrame(updateProgress);
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

  // Stop progress updates
  const stopProgressUpdates = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }
  }, []);

  // Play a chunk
  const playChunk = useCallback(async (chunkIndex: number) => {
    const audioContext = initAudioContext();
    const chunk = chunksRef.current[chunkIndex];

    if (!chunk || !chunk.audio || isCancelledRef.current) {
      if (chunkIndex >= chunksRef.current.length || isCancelledRef.current) {
        setState((prev) => ({
          ...prev,
          isPlaying: false,
          currentTime: prev.totalDuration,
        }));
        return;
      }
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
        setState((prev) => ({
          ...prev,
          isPlaying: false,
          currentTime: prev.totalDuration,
        }));
      }
    };
  }, [initAudioContext]);

  // Stop playback
  const stop = useCallback(async () => {
    isCancelledRef.current = true;

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop();
      } catch {}
      sourceNodeRef.current = null;
    }

    stopProgressUpdates();

    chunksRef.current = [];
    currentChunkIndexRef.current = 0;
    startTimeRef.current = 0;
    pausedAtRef.current = 0;

    setState((prev) => ({
      ...prev,
      isLoading: false,
      isPlaying: false,
      currentTime: 0,
      totalDuration: 0,
      activeText: null,
      activeMessageId: null,
    }));
  }, [stopProgressUpdates]);

  // Start TTS
  const play = useCallback(async (text: string, messageId: string) => {
    await stop();

    isCancelledRef.current = false;
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

    const chunks = createChunks(text);
    chunksRef.current = chunks;

    const estimatedDuration = chunks.length * 3;
    setState((prev) => ({ ...prev, totalDuration: estimatedDuration }));

    const generationPromises = chunks.map(async (chunk, index) => {
      if (isCancelledRef.current) return;

      chunk.status = "generating";
      const audio = await generateChunkAudio(tts, chunk);

      if (isCancelledRef.current) return;

      if (audio) {
        chunk.audio = audio;
        chunk.duration = getAudioDuration(audio, 24000);
        chunk.status = "ready";

        const totalDuration = chunksRef.current.reduce((sum, c) => sum + (c.duration || 0), 0);
        setState((prev) => ({ ...prev, totalDuration }));

        if (index === 0 && !state.isPlaying && !isCancelledRef.current) {
          setState((prev) => ({ ...prev, isLoading: false }));
          playChunk(0);
          startProgressUpdates();
        }
      } else {
        chunk.status = "error";
      }
    });

    await Promise.all(generationPromises);

    if (!state.isPlaying && !isCancelledRef.current && chunks[0]?.status === "ready") {
      setState((prev) => ({ ...prev, isLoading: false }));
      playChunk(0);
      startProgressUpdates();
    }
  }, [loadModel, createChunks, generateChunkAudio, getAudioDuration, playChunk, startProgressUpdates, stop, state.isPlaying]);

  // Pause playback
  const pause = useCallback(() => {
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop();
      } catch {}
      sourceNodeRef.current = null;
    }

    stopProgressUpdates();
    setState((prev) => ({ ...prev, isPlaying: false }));
  }, [stopProgressUpdates]);

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

  // Seek
  const seek = useCallback((time: number) => {
    // Seek implementation simplified
    setState((prev) => ({ ...prev, currentTime: time }));
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      stop();
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, [stop]);

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
