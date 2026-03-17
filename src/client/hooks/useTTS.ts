import { useState, useCallback, useRef, useEffect } from "react";

// Lazy-loaded Kokoro module
let kokoroModulePromise: Promise<typeof import("kokoro-js")> | null = null;

function getKokoroModule(): Promise<typeof import("kokoro-js")> {
  if (!kokoroModulePromise) {
    kokoroModulePromise = import("kokoro-js").catch((err) => {
      console.error("Failed to load kokoro-js module:", err);
      kokoroModulePromise = null;
      throw err;
    });
  }
  return kokoroModulePromise;
}

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
  progress: number; // 0-100 for model download progress
  currentTime: number;
  totalDuration: number;
  activeText: string | null;
  activeMessageId: string | null;
  error: string | null;
}

const CHUNK_SIZE = 500; // Characters per chunk for faster initial playback
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

  // Initialize AudioContext on first user interaction
  const initAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  // Load Kokoro TTS model lazily
  const loadModel = useCallback(async (): Promise<KokoroTTS | null> => {
    if (ttsRef.current) return ttsRef.current;

    setState((prev) => ({ ...prev, isModelLoading: true, progress: 0 }));

    try {
      // Use module-level import to avoid re-loading
      const mod = await getKokoroModule();
      const { KokoroTTS } = mod;

      // Create a custom progress handler
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

  // Split text into chunks for progressive playback
  const createChunks = useCallback((text: string): TTSChunk[] => {
    // Split by sentences and combine into chunks of appropriate size
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

  // Play a chunk
  const playChunk = useCallback(async (chunkIndex: number) => {
    const audioContext = initAudioContext();
    const chunk = chunksRef.current[chunkIndex];

    if (!chunk || !chunk.audio || isCancelledRef.current) {
      // If no more chunks or cancelled, stop playback
      if (chunkIndex >= chunksRef.current.length || isCancelledRef.current) {
        setState((prev) => ({
          ...prev,
          isPlaying: false,
          currentTime: prev.totalDuration,
        }));
        return;
      }
      // Wait for chunk to be ready
      return;
    }

    // Create audio buffer
    const audioBuffer = audioContext.createBuffer(1, chunk.audio.length, 24000);
    audioBuffer.copyToChannel(chunk.audio, 0);

    // Create source node
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    sourceNodeRef.current = source;

    // Calculate start offset if resuming
    const offset = pausedAtRef.current > 0 ? pausedAtRef.current : 0;
    const actualOffset = Math.min(offset, chunk.duration);

    // Update current chunk index
    currentChunkIndexRef.current = chunkIndex;

    // Start playback
    source.start(0, actualOffset);
    startTimeRef.current = audioContext.currentTime - actualOffset;
    pausedAtRef.current = 0;

    // Update state
    setState((prev) => ({ ...prev, isPlaying: true }));

    // Schedule next chunk or end
    const remainingDuration = chunk.duration - actualOffset;

    source.onended = () => {
      if (isCancelledRef.current) return;

      // Move to next chunk
      const nextIndex = chunkIndex + 1;
      if (nextIndex < chunksRef.current.length) {
        playChunk(nextIndex);
      } else {
        // All chunks played
        setState((prev) => ({
          ...prev,
          isPlaying: false,
          currentTime: prev.totalDuration,
        }));
      }
    };
  }, [initAudioContext]);

  // Update progress during playback
  const startProgressUpdates = useCallback(() => {
    const updateProgress = () => {
      if (!state.isPlaying || !audioContextRef.current) {
        animationFrameRef.current = requestAnimationFrame(updateProgress);
        return;
      }

      const audioContext = audioContextRef.current;
      const currentChunk = chunksRef.current[currentChunkIndexRef.current];

      if (currentChunk) {
        const elapsedInChunk = audioContext.currentTime - startTimeRef.current;
        let totalElapsed = 0;

        // Calculate total elapsed time from previous chunks
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

  // Start TTS for a message
  const play = useCallback(async (text: string, messageId: string) => {
    // Stop any current playback
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

    // Load model
    const tts = await loadModel();
    if (!tts || isCancelledRef.current) {
      setState((prev) => ({ ...prev, isLoading: false }));
      return;
    }

    // Create chunks
    const chunks = createChunks(text);
    chunksRef.current = chunks;

    // Estimate total duration (will be updated as chunks are generated)
    const estimatedDuration = chunks.length * 3; // Rough estimate: 3 seconds per chunk
    setState((prev) => ({ ...prev, totalDuration: estimatedDuration }));

    // Start generating audio for all chunks in parallel
    const generationPromises = chunks.map(async (chunk, index) => {
      if (isCancelledRef.current) return;

      // Update chunk status
      chunk.status = "generating";

      const audio = await generateChunkAudio(tts, chunk);

      if (isCancelledRef.current) return;

      if (audio) {
        chunk.audio = audio;
        chunk.duration = getAudioDuration(audio, 24000);
        chunk.status = "ready";

        // Update total duration
        const totalDuration = chunksRef.current.reduce((sum, c) => sum + (c.duration || 0), 0);
        setState((prev) => ({ ...prev, totalDuration }));

        // If this is the first chunk and we're not playing yet, start playback
        if (index === 0 && !state.isPlaying && !isCancelledRef.current) {
          setState((prev) => ({ ...prev, isLoading: false }));
          playChunk(0);
          startProgressUpdates();
        }
      } else {
        chunk.status = "error";
      }
    });

    // Wait for all generations to complete
    await Promise.all(generationPromises);

    // If playback hasn't started yet (e.g., first chunk took long), start now
    if (!state.isPlaying && !isCancelledRef.current && chunks[0]?.status === "ready") {
      setState((prev) => ({ ...prev, isLoading: false }));
      playChunk(0);
      startProgressUpdates();
    }
  }, [loadModel, createChunks, generateChunkAudio, getAudioDuration, playChunk, startProgressUpdates, stop]);

  // Pause playback
  const pause = useCallback(() => {
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop();
      } catch {
        // Ignore if already stopped
      }
      sourceNodeRef.current = null;
    }

    if (audioContextRef.current && startTimeRef.current > 0) {
      const elapsed = audioContextRef.current.currentTime - startTimeRef.current;
      const currentChunk = chunksRef.current[currentChunkIndexRef.current];
      if (currentChunk) {
        pausedAtRef.current = Math.min(elapsed, currentChunk.duration);
      }
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

  // Stop playback completely
  const stop = useCallback(async () => {
    isCancelledRef.current = true;

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop();
      } catch {
        // Ignore if already stopped
      }
      sourceNodeRef.current = null;
    }

    stopProgressUpdates();

    // Reset state
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

  // Toggle play/pause
  const toggle = useCallback(async (text: string, messageId: string) => {
    // If clicking the same message that's currently active
    if (state.activeMessageId === messageId) {
      if (state.isPlaying) {
        pause();
      } else if (state.isLoading) {
        // Still loading, do nothing
        return;
      } else {
        // Paused, resume
        resume();
      }
    } else {
      // New message, start playing
      await play(text, messageId);
    }
  }, [state.activeMessageId, state.isPlaying, state.isLoading, pause, resume, play]);

  // Seek to a specific time
  const seek = useCallback((time: number) => {
    if (chunksRef.current.length === 0) return;

    // Find which chunk contains this time
    let accumulatedTime = 0;
    let targetChunkIndex = 0;
    let offsetInChunk = 0;

    for (let i = 0; i < chunksRef.current.length; i++) {
      const chunk = chunksRef.current[i];
      if (!chunk) continue;

      if (accumulatedTime + chunk.duration >= time) {
        targetChunkIndex = i;
        offsetInChunk = time - accumulatedTime;
        break;
      }
      accumulatedTime += chunk.duration;
    }

    // Stop current playback
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop();
      } catch {
        // Ignore
      }
      sourceNodeRef.current = null;
    }

    // Update state
    currentChunkIndexRef.current = targetChunkIndex;
    pausedAtRef.current = offsetInChunk;
    setState((prev) => ({ ...prev, currentTime: time }));

    // Resume from new position if was playing
    if (state.isPlaying) {
      playChunk(targetChunkIndex);
    }
  }, [state.isPlaying, playChunk]);

  // Cleanup on unmount
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
      // Space to play/pause (only when not typing in input)
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

      // Escape to stop
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
