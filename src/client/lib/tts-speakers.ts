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
  sourceStartOffset: number;
  sourceEndOffset: number;
}

export interface TtsChunkPlan {
  text: string;
  displayText: string;
  parts: TtsChunkPartPlan[];
  sourceStartOffset: number;
  sourceEndOffset: number;
}

const SENTENCE_PATTERN = /[^.!?]+(?:[.!?]+["')\]”’]*|$)/g;
const DIALOG_SPEAKER_TAG_PATTERN = /(["“])\[([^\]\n]+)\]\s*/g;
const DIALOG_CLOSING_QUOTE_PATTERN = /["”]/;
const COMPLETE_SENTENCE_PATTERN = /[.!?]+["')\]”’]*$/;

export function normalizeSpeakerKey(label: string) {
  const trimmed = label.trim();
  if (!trimmed) return "narrator";
  return trimmed.toLowerCase().replace(/\s+/g, " ");
}

function splitSentences(text: string) {
  const sentences: Array<{ text: string; startOffset: number; endOffset: number }> = [];
  const matches = text.matchAll(SENTENCE_PATTERN);

  for (const match of matches) {
    const sentence = match[0] || "";
    if (!sentence.trim()) continue;
    const startOffset = match.index ?? 0;
    sentences.push({
      text: sentence,
      startOffset,
      endOffset: startOffset + sentence.length,
    });
  }

  if (sentences.length > 0) {
    return sentences;
  }

  return text
    ? [{ text, startOffset: 0, endOffset: text.length }]
    : [];
}

interface SpeakerSegment {
  speakerKey: string;
  speakerLabel: string;
  prefix: string;
  ttsLead: string;
  body: string;
  isDialog: boolean;
  sourceStartOffset: number;
  bodyStartOffset: number;
}

function splitSpeakerSegments(text: string): SpeakerSegment[] {
  const segments: SpeakerSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  DIALOG_SPEAKER_TAG_PATTERN.lastIndex = 0;

  while ((match = DIALOG_SPEAKER_TAG_PATTERN.exec(text)) !== null) {
    const matchIndex = match.index;
    if (matchIndex > cursor) {
      const narratorText = text.slice(cursor, matchIndex);
      if (narratorText.trim()) {
        segments.push({
          speakerKey: "narrator",
          speakerLabel: "Narrator",
          prefix: "",
          ttsLead: "",
          body: narratorText,
          isDialog: false,
          sourceStartOffset: cursor,
          bodyStartOffset: cursor,
        });
      }
    }

    const dialogStart = matchIndex + match[0].length;
    const remainingText = text.slice(dialogStart);
    const closingQuoteMatch = remainingText.match(DIALOG_CLOSING_QUOTE_PATTERN);
    const dialogEnd = closingQuoteMatch && closingQuoteMatch.index !== undefined
      ? dialogStart + closingQuoteMatch.index + closingQuoteMatch[0].length
      : text.length;
    const dialogBody = text.slice(dialogStart, dialogEnd);
    const speakerLabel = match[2]?.trim() || "Narrator";

    segments.push({
      speakerKey: normalizeSpeakerKey(speakerLabel),
      speakerLabel,
      prefix: match[0],
      ttsLead: match[1] || "",
      body: dialogBody,
      isDialog: true,
      sourceStartOffset: matchIndex,
      bodyStartOffset: dialogStart,
    });

    cursor = dialogEnd;
    DIALOG_SPEAKER_TAG_PATTERN.lastIndex = dialogEnd;
  }

  if (cursor < text.length) {
    const narratorText = text.slice(cursor);
    if (narratorText.trim()) {
      segments.push({
        speakerKey: "narrator",
        speakerLabel: "Narrator",
        prefix: "",
        ttsLead: "",
        body: narratorText,
        isDialog: false,
        sourceStartOffset: cursor,
        bodyStartOffset: cursor,
      });
    }
  }

  if (segments.length === 0 && text.trim()) {
    segments.push({
      speakerKey: "narrator",
      speakerLabel: "Narrator",
      prefix: "",
      ttsLead: "",
      body: text,
      isDialog: false,
      sourceStartOffset: 0,
      bodyStartOffset: 0,
    });
  }

  return segments;
}

export function buildSpeakerChunkPlans(
  text: string,
  speakerMappings: SpeakerVoiceMapping[],
  defaultVoiceReferenceId: string | null,
  options: { completeSentencesOnly?: boolean; targetWordsPerChunk?: number } = {}
): TtsChunkPlan[] {
  const targetWordsPerChunk = options.targetWordsPerChunk ?? 60;
  const voiceBySpeakerKey = new Map(speakerMappings.map((mapping) => [mapping.speakerKey, mapping.voiceReferenceId]));
  const chunks: TtsChunkPlan[] = [];
  let currentParts: TtsChunkPartPlan[] = [];
  let currentWordCount = 0;

  const flushChunk = () => {
    if (currentParts.length === 0) return;
    chunks.push({
      text: currentParts.map((part) => part.text).join(" ").trim(),
      displayText: currentParts.map((part) => part.displayText).join("").trim(),
      parts: currentParts.map((part) => ({ ...part })),
      sourceStartOffset: currentParts[0]?.sourceStartOffset ?? 0,
      sourceEndOffset: currentParts[currentParts.length - 1]?.sourceEndOffset ?? 0,
    });
    currentParts = [];
    currentWordCount = 0;
  };

  const appendUnit = (unit: TtsChunkPartPlan, wordCount: number) => {
    const previousPart = currentParts[currentParts.length - 1];
    if (
      previousPart &&
      previousPart.speakerKey === unit.speakerKey &&
      previousPart.voiceReferenceId === unit.voiceReferenceId
    ) {
      previousPart.text = `${previousPart.text} ${unit.text}`.trim();
      previousPart.displayText = `${previousPart.displayText}${unit.displayText}`;
      previousPart.sourceEndOffset = unit.sourceEndOffset;
    } else {
      currentParts.push({ ...unit });
    }
    currentWordCount += wordCount;
  };

  for (const segment of splitSpeakerSegments(text)) {
    const displaySentences = splitSentences(segment.body);
    const segmentUnits: Array<{ unit: TtsChunkPartPlan; wordCount: number }> = [];

    for (let index = 0; index < displaySentences.length; index++) {
      const displaySentence = displaySentences[index];
      if (!displaySentence) continue;

      const ttsSentence = `${index === 0 ? segment.ttsLead : ""}${formatTextForTts(displaySentence.text).trim()}`.trim();
      if (!ttsSentence) continue;
      if (options.completeSentencesOnly && !COMPLETE_SENTENCE_PATTERN.test(ttsSentence)) {
        continue;
      }

      const sourceStartOffset = index === 0
        ? segment.sourceStartOffset
        : segment.bodyStartOffset + displaySentence.startOffset;
      const sourceEndOffset = segment.bodyStartOffset + displaySentence.endOffset;

      segmentUnits.push({
        unit: {
          speakerKey: segment.speakerKey,
          speakerLabel: segment.speakerLabel,
          voiceReferenceId: voiceBySpeakerKey.get(segment.speakerKey) ?? defaultVoiceReferenceId,
          text: ttsSentence,
          displayText: `${index === 0 ? segment.prefix : ""}${displaySentence.text}`,
          sourceStartOffset,
          sourceEndOffset,
        },
        wordCount: ttsSentence.split(/\s+/).filter(Boolean).length,
      });
    }

    if (segmentUnits.length === 0) {
      continue;
    }

    if (segment.isDialog) {
      const segmentWordCount = segmentUnits.reduce((sum, entry) => sum + entry.wordCount, 0);
      const canKeepDialogWhole = segmentWordCount <= targetWordsPerChunk;

      if (canKeepDialogWhole && currentWordCount + segmentWordCount > targetWordsPerChunk && currentParts.length > 0) {
        flushChunk();
      }

      if (canKeepDialogWhole) {
        for (const entry of segmentUnits) {
          appendUnit(entry.unit, entry.wordCount);
        }
        continue;
      }

      for (const entry of segmentUnits) {
        if (currentWordCount + entry.wordCount > targetWordsPerChunk && currentParts.length > 0) {
          flushChunk();
        }
        appendUnit(entry.unit, entry.wordCount);
      }
      continue;
    }

    for (const entry of segmentUnits) {
      if (currentWordCount + entry.wordCount > targetWordsPerChunk && currentParts.length > 0) {
        flushChunk();
      }
      appendUnit(entry.unit, entry.wordCount);
    }
  }

  flushChunk();
  return chunks;
}
