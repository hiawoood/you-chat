import { mkdir, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { dataDir } from "../db";

const TTS_VOICE_ROOT_DIR = join(dataDir, "tts-voices");

const MIME_EXTENSION_MAP: Record<string, string> = {
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/webm": ".webm",
  "audio/x-m4a": ".m4a",
};

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getAudioExtension(filename: string, mimeType: string): string {
  const normalizedExtension = extname(filename).toLowerCase();
  if (normalizedExtension) return normalizedExtension;
  return MIME_EXTENSION_MAP[mimeType] || ".bin";
}

async function ensureDirectory(path: string) {
  await mkdir(path, { recursive: true });
}

export async function saveTtsVoiceFile(userId: string, voiceId: string, file: File) {
  const userDir = join(TTS_VOICE_ROOT_DIR, sanitizePathSegment(userId));
  await ensureDirectory(userDir);

  const extension = getAudioExtension(file.name, file.type);
  const filename = `${sanitizePathSegment(voiceId)}${extension}`;
  const storagePath = join(userDir, filename);
  const bytes = await file.arrayBuffer();
  await Bun.write(storagePath, bytes);

  return {
    storagePath,
    originalFilename: basename(file.name) || filename,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
  };
}

export async function deleteTtsVoiceFile(storagePath: string) {
  try {
    await unlink(storagePath);
  } catch {
    // Ignore missing files.
  }
}

export function getStoredTtsVoiceFile(storagePath: string) {
  return Bun.file(storagePath);
}
