import { formatTextForTts } from "./tts-text";

export interface SpeakerVoiceMapping {
  speakerKey: string;
  speakerLabel: string;
  voiceReferenceId: string | null;
}

export interface TtsChunkPartPlan {
  speakerKey: string;
  speakerLabel: string;
  text: string;
  displayText: string;
  voiceReferenceId: string | null;
}

export interface TtsChunkPlan {
  text: string;
  displayText: string;
  parts: TtsChunkPartPlan[];
}

const SENTENCE_PATTERN = /[^.!?]+(?:[.!?]+["')\]”’]*|$)/g;
const SPEAKER_TAG_PATTERN = /^\s*(["“])\[([^\]\n]+)\]\s*/;
const COMPLETE_SENTENCE_PATTERN = /[.!?]+["')\]”’]*$/;

export function normalizeSpeakerKey(label: string) {
  const trimmed = label.trim();
  if (!trimmed) return "narrator";
  return trimmed.toLowerCase().replace(/\s+/g, " ");
}

function splitSentences(text: string) {
  return text.match(SENTENCE_PATTERN)?.map((sentence) => sentence.trim()).filter(Boolean) || [text.trim()];
}

function parseSpeakerLine(line: string) {
  const match = line.match(SPEAKER_TAG_PATTERN);
  if (!match) {
    return {
      speakerKey: "narrator",
      speakerLabel: "Narrator",
      prefix: "",
      ttsLead: "",
      body: line,
    };
  }

  const speakerLabel = match[2]?.trim() || "Narrator";
  return {
    speakerKey: normalizeSpeakerKey(speakerLabel),
    speakerLabel,
    prefix: match[0],
    ttsLead: match[1] || "",
    body: line.slice(match[0].length),
  };
}

export function buildSpeakerChunkPlans(
  text: string,
  speakerMappings: SpeakerVoiceMapping[],
  defaultVoiceReferenceId: string | null,
  options: { completeSentencesOnly?: boolean; targetWordsPerChunk?: number } = {}
): TtsChunkPlan[] {
  const targetWordsPerChunk = options.targetWordsPerChunk ?? 60;
  const voiceBySpeakerKey = new Map(speakerMappings.map((mapping) => [mapping.speakerKey, mapping.voiceReferenceId]));
  const lines = text.split(/\r?\n/);
  const sentenceUnits: TtsChunkPartPlan[] = [];

  for (const line of lines) {
    const parsedLine = parseSpeakerLine(line);
    const displaySentences = splitSentences(parsedLine.body);

    for (let index = 0; index < displaySentences.length; index++) {
      const displaySentence = displaySentences[index];
      if (!displaySentence) continue;

      const ttsSentence = `${index === 0 ? parsedLine.ttsLead : ""}${formatTextForTts(displaySentence).trim()}`.trim();
      if (!ttsSentence) continue;
      if (options.completeSentencesOnly && !COMPLETE_SENTENCE_PATTERN.test(ttsSentence)) {
        continue;
      }

      sentenceUnits.push({
        speakerKey: parsedLine.speakerKey,
        speakerLabel: parsedLine.speakerLabel,
        voiceReferenceId: voiceBySpeakerKey.get(parsedLine.speakerKey) ?? defaultVoiceReferenceId,
        text: ttsSentence,
        displayText: `${index === 0 ? parsedLine.prefix : ""}${displaySentence}`,
      });
    }
  }

  const chunks: TtsChunkPlan[] = [];
  let currentParts: TtsChunkPartPlan[] = [];
  let currentWordCount = 0;

  const flushChunk = () => {
    if (currentParts.length === 0) return;
    chunks.push({
      text: currentParts.map((part) => part.text).join(" ").trim(),
      displayText: currentParts.map((part) => part.displayText).join("\n").trim(),
      parts: currentParts.map((part) => ({ ...part })),
    });
    currentParts = [];
    currentWordCount = 0;
  };

  for (const unit of sentenceUnits) {
    const wordCount = unit.text.split(/\s+/).filter(Boolean).length;
    if (currentWordCount + wordCount > targetWordsPerChunk && currentParts.length > 0) {
      flushChunk();
    }

    const previousPart = currentParts[currentParts.length - 1];
    if (
      previousPart &&
      previousPart.speakerKey === unit.speakerKey &&
      previousPart.voiceReferenceId === unit.voiceReferenceId
    ) {
      previousPart.text = `${previousPart.text} ${unit.text}`.trim();
      previousPart.displayText = `${previousPart.displayText}\n${unit.displayText}`.trim();
    } else {
      currentParts.push({ ...unit });
    }
    currentWordCount += wordCount;
  }

  flushChunk();
  return chunks;
}
