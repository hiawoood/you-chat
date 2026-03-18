// TTS Web Worker - runs Kokoro.js in background thread
import type { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_VOICE = "af_heart";

let tts: KokoroTTS | null = null;
let isModelLoading = false;
let modelLoadPromise: Promise<KokoroTTS> | null = null;

// Priority queue: chunk 0 gets processed first
const priorityQueue: Array<{ text: string; chunkId: number }> = [];
const normalQueue: Array<{ text: string; chunkId: number }> = [];
let isProcessing = false;

// Load the model
async function loadModel(): Promise<KokoroTTS> {
  if (tts) return tts;
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
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
  })();

  return modelLoadPromise;
}

// Generate audio for text
async function generate(text: string, chunkId: number) {
  try {
    const model = await loadModel();
    const startTime = Date.now();

    const result = await model.generate(text, { voice: DEFAULT_VOICE });

    const duration = Date.now() - startTime;
    console.log(`[TTS Worker] Chunk ${chunkId} generated in ${duration}ms (${text.length} chars)`);

    self.postMessage(
      {
        type: "chunk-ready",
        chunkId,
        audio: result.audio,
        sampleRate: result.sample_rate || 24000,
      },
      [result.audio.buffer]
    );
  } catch (error) {
    console.error(`[TTS Worker] Chunk ${chunkId} failed:`, error);
    self.postMessage({
      type: "chunk-error",
      chunkId,
      error: error instanceof Error ? error.message : "Generation failed",
    });
  }
}

// Process queue
async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (priorityQueue.length > 0 || normalQueue.length > 0) {
    const item = priorityQueue.shift() || normalQueue.shift();
    if (!item) continue;

    await generate(item.text, item.chunkId);
  }

  isProcessing = false;
}

// Handle messages from main thread
self.onmessage = async (event) => {
  const { type, text, chunkId } = event.data;

  if (type === "generate") {
    // Chunk 0 gets highest priority
    if (chunkId === 0) {
      priorityQueue.push({ text, chunkId });
    } else {
      normalQueue.push({ text, chunkId });
    }
    processQueue();
  } else if (type === "preload") {
    loadModel();
  } else if (type === "clear") {
    priorityQueue.length = 0;
    normalQueue.length = 0;
  }
};
