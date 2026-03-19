import { useState, useCallback, useRef, useEffect } from "react";
import { api } from "../lib/api";

export interface TTSChunk {
  id: number;
  text: string;
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

// Split text into ~300 word chunks at sentence boundaries
function chunkText(text: string, targetWordsPerChunk: number = 300): string[] {
  // Split into sentences
  const sentences = text.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
  const chunks: string[] = [];
  let currentChunk = "";
  let currentWordCount = 0;

  for (const sentence of sentences) {
    const wordCount = sentence.trim().split(/\s+/).length;
    
    if (currentWordCount + wordCount > targetWordsPerChunk && currentChunk.length > 0) {
      // Finish current chunk
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
      currentWordCount = wordCount;
    } else {
      currentChunk += " " + sentence;
      currentWordCount += wordCount;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// Find which chunk contains a specific word index
function findChunkForWordIndex(chunks: string[], targetWordIndex: number): number {
  let wordCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunkWordCount = chunks[i].trim().split(/\s+/).length;
    if (wordCount + chunkWordCount > targetWordIndex) {
      return i;
    }
    wordCount += chunkWordCount;
  }
  return 0;
}

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

  // Stop any current playback
  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, []);

  // Reset state
  const reset = useCallback(() => {
    stopPlayback();
    chunksRef.current = [];
    messageIdRef.current = null;
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
  }, [stopPlayback]);

  // Generate audio for a chunk
  const generateChunkAudio = useCallback(async (chunkText: string): Promise<string> => {
    const response = await api.post("/tts/speak", { text: chunkText });
    if (!response.success || !response.audio) {
      throw new Error(response.error || "Failed to generate audio");
    }
    return response.audio;
  }, []);

  // Play a specific chunk
  const playChunk = useCallback(async (chunkIndex: number) => {
    const chunks = chunksRef.current;
    const chunk = chunks[chunkIndex];
    
    if (!chunk || !chunk.audio) return;

    // Update state to show current chunk
    setState(prev => ({
      ...prev,
      currentChunkIndex: chunkIndex,
      isPlaying: true,
      isPaused: false,
    }));

    // Update chunk status
    chunksRef.current = chunks.map((c, i) => ({
      ...c,
      status: i === chunkIndex ? "playing" : c.status,
    }));
    setState(prev => ({ ...prev, chunks: chunksRef.current }));

    // Play audio
    const audio = new Audio(`data:audio/wav;base64,${chunk.audio}`);
    audioRef.current = audio;

    return new Promise<void>((resolve) => {
      audio.onended = () => {
        resolve();
      };
      audio.onerror = () => {
        resolve();
      };
      audio.play().catch(() => resolve());
    });
  }, []);

  // Start TTS playback
  const startPlayback = useCallback(async (
    text: string, 
    messageId: string,
    startChunkIndex: number = 0
  ) => {
    reset();
    messageIdRef.current = messageId;

    // Chunk the text
    const textChunks = chunkText(text);
    
    // Create chunk objects
    chunksRef.current = textChunks.map((chunkText, index) => ({
      id: index,
      text: chunkText,
      startWord: textChunks.slice(0, index).reduce((sum, c) => sum + c.split(/\s+/).length, 0),
      endWord: textChunks.slice(0, index + 1).reduce((sum, c) => sum + c.split(/\s+/).length, 0),
      audio: null,
      status: index === startChunkIndex ? "generating" : "pending",
    }));

    setState({
      isLoading: true,
      isPlaying: false,
      isPaused: false,
      currentChunkIndex: startChunkIndex,
      totalChunks: textChunks.length,
      error: null,
      activeMessageId: messageId,
      chunks: chunksRef.current,
    });

    // Generate audio for all chunks starting from startChunkIndex
    for (let i = startChunkIndex; i < textChunks.length; i++) {
      // Update status
      chunksRef.current = chunksRef.current.map((c, idx) => ({
        ...c,
        status: idx === i ? "generating" : c.status,
      }));
      setState(prev => ({ ...prev, chunks: chunksRef.current }));

      try {
        const audio = await generateChunkAudio(textChunks[i]);
        
        chunksRef.current = chunksRef.current.map((c, idx) =>
          idx === i ? { ...c, audio, status: "ready" } : c
        );
        setState(prev => ({ ...prev, chunks: chunksRef.current, isLoading: false }));

        // If this is the first chunk or we're resuming, start playing
        if (i === startChunkIndex) {
          await playChunk(i);
        }
      } catch (error) {
        chunksRef.current = chunksRef.current.map((c, idx) =>
          idx === i ? { ...c, status: "error" } : c
        );
        setState(prev => ({ ...prev, chunks: chunksRef.current }));
        console.error(`Failed to generate chunk ${i}:`, error);
        break;
      }
    }

    setState(prev => ({ ...prev, isPlaying: false }));
  }, [reset, generateChunkAudio, playChunk]);

  // Pause playback
  const pause = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setState(prev => ({ ...prev, isPaused: true, isPlaying: false }));
  }, []);

  // Resume playback
  const resume = useCallback(async () => {
    const currentIndex = state.currentChunkIndex;
    const chunk = chunksRef.current[currentIndex];
    
    if (chunk?.audio) {
      setState(prev => ({ ...prev, isPaused: false, isPlaying: true }));
      await playChunk(currentIndex);
    }
  }, [state.currentChunkIndex, playChunk]);

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

  // Get current playing chunk
  const getCurrentChunk = useCallback(() => {
    return chunksRef.current[state.currentChunkIndex];
  }, [state.currentChunkIndex]);

  return {
    ...state,
    startPlayback,
    pause,
    resume,
    toggle,
    startFromWord,
    stop: reset,
    getCurrentChunk,
  };
}

export default useChunkedVastTTS;
