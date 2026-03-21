import { Capacitor, registerPlugin } from "@capacitor/core";

export interface NativeTtsStatePayload {
  activeMessageId: string | null;
  currentChunkIndex: number;
  loadingChunkIndex: number | null;
  totalChunks: number;
  isLoading: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  error: string | null;
  preparedChunkIndices: number[];
}

interface NativeTtsPlugin {
  startPlayback(options: {
    messageId: string;
    chunks: string[];
    startChunkIndex: number;
    voiceReferenceId?: string | null;
    playbackSpeed: number;
    baseUrl: string;
  }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  nextChunk(): Promise<void>;
  prevChunk(): Promise<void>;
  seekToChunk(options: { chunkIndex: number }): Promise<void>;
  setPlaybackSpeed(options: { playbackSpeed: number }): Promise<void>;
  getState(): Promise<NativeTtsStatePayload>;
  addListener(eventName: "stateChange", listenerFunc: (state: NativeTtsStatePayload) => void): Promise<{ remove: () => Promise<void> }>;
}

const nativeTtsPlugin = registerPlugin<NativeTtsPlugin>("BackgroundAudio");

export function isNativeTtsAvailable() {
  return Capacitor.getPlatform() === "android";
}

export function getNativeTtsPlugin() {
  return nativeTtsPlugin;
}
