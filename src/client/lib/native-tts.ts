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
  motionAutoStopEnabled: boolean;
  motionIdleRemainingMs: number | null;
  motionFadeActive: boolean;
}

export interface NativeMotionAutoStopConfig {
  enabled: boolean;
}

export interface NativeTtsChunkPartDescriptor {
  text: string;
  speakerKey: string;
  speakerLabel: string;
  voiceReferenceId: string | null;
}

export interface NativeTtsSpeakerMappingDescriptor {
  speakerKey: string;
  speakerLabel: string;
  voiceReferenceId: string | null;
}

export interface NativeTtsChunkDescriptor {
  displayText: string;
  parts: NativeTtsChunkPartDescriptor[];
}

interface NativeTtsPlugin {
  startPlayback(options: {
    sessionId?: string | null;
    messageId: string;
    chunks: NativeTtsChunkDescriptor[];
    speakerMappings: NativeTtsSpeakerMappingDescriptor[];
    defaultVoiceReferenceId?: string | null;
    startChunkIndex: number;
    playbackSpeed: number;
    baseUrl: string;
    streaming?: boolean;
  }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  nextChunk(): Promise<void>;
  prevChunk(): Promise<void>;
  seekToChunk(options: { chunkIndex: number }): Promise<void>;
  setPlaybackSpeed(options: { playbackSpeed: number }): Promise<void>;
  updatePlaybackChunks(options: { sessionId?: string | null; messageId: string; chunks: NativeTtsChunkDescriptor[]; speakerMappings?: NativeTtsSpeakerMappingDescriptor[]; defaultVoiceReferenceId?: string | null }): Promise<void>;
  getState(): Promise<NativeTtsStatePayload>;
  getMotionAutoStopConfig(): Promise<NativeMotionAutoStopConfig>;
  setMotionAutoStopConfig(options: NativeMotionAutoStopConfig): Promise<NativeMotionAutoStopConfig>;
  addListener(eventName: "stateChange", listenerFunc: (state: NativeTtsStatePayload) => void): Promise<{ remove: () => Promise<void> }>;
}

const nativeTtsPlugin = registerPlugin<NativeTtsPlugin>("BackgroundAudio");

export function isNativeTtsAvailable() {
  return Capacitor.getPlatform() === "android";
}

export function getNativeTtsPlugin() {
  return nativeTtsPlugin;
}
