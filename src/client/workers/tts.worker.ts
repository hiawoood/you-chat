// TTS Web Worker - runs Kokoro.js in background thread
import type { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_VOICE = "af_heart";

let tts: KokoroTTS | null = null;
let isModelLoading = false;

// Load the model
async function loadModel(): Promise<KokoroTTS> {
  if (tts) return tts;
  if (isModelLoading) {
    // Wait for existing load to complete
    while (isModelLoading) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (tts) return tts;
  }

  isModelLoading = true;
  self.postMessage({ type: "model-loading" });

  try {
    const { KokoroTTS } = await import("kokoro-js");
    tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: "q8",
      progress_callback: (progress: { loaded: number; total: number }) => {
        const percent = Math.round((progress.loaded / progress.total) * 100);
        self.postMessage({ type: "progress", progress: percent });
      },
    });
    self.postMessage({ type: "model-ready" });
    return tts;
  } finally {
    isModelLoading = false;
  }
}

// Generate audio for text
async function generate(text: string, chunkId: number) {
  try {
    const model = await loadModel();
    const result = await model.generate(text, { voice: DEFAULT_VOICE });

    // Transfer the audio buffer (zero-copy)
    self.postMessage(
      {
        type: "chunk-ready",
        chunkId,
        audio: result.audio,
        sampleRate: result.sample_rate || 24000,
      },
      [result.audio.buffer] // Transfer ownership
    );
  } catch (error) {
    self.postMessage({
      type: "chunk-error",
      chunkId,
      error: error instanceof Error ? error.message : "Generation failed",
    });
  }
}

// Handle messages from main thread
self.onmessage = async (event) => {
  const { type, text, chunkId } = event.data;

  if (type === "generate") {
    await generate(text, chunkId);
  } else if (type === "preload") {
    // Preload the model
    await loadModel();
  }
};
