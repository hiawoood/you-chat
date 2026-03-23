const TTS_STAGE_DIRECTIONS = [
  "clear throat",
  "sigh",
  "shush",
  "cough",
  "groan",
  "sniff",
  "gasp",
  "chuckle",
  "laugh",
] as const;

const TTS_STAGE_DIRECTION_PATTERN = new RegExp(`\\[(${TTS_STAGE_DIRECTIONS.join("|")})\\]`, "gi");
const ALL_CAPS_WORD_PATTERN = /\b[A-Z]{2,}(?:['-][A-Z]+)*\b/g;

interface ProtectedCue {
  token: string;
  value: string;
}

function protectTtsStageDirections(text: string): { text: string; cues: ProtectedCue[] } {
  const cues: ProtectedCue[] = [];
  let index = 0;

  const protectedText = text.replace(TTS_STAGE_DIRECTION_PATTERN, (match) => {
    const token = `TTSCUEPLACEHOLDER${index++}ZZZ`;
    cues.push({ token, value: match });
    return token;
  });

  return { text: protectedText, cues };
}

function restoreTtsStageDirections(text: string, cues: ProtectedCue[]): string {
  let restoredText = text;
  for (const cue of cues) {
    restoredText = restoredText.replaceAll(cue.token, cue.value);
  }
  return restoredText;
}

function normalizeAllCapsWords(text: string): string {
  return text.replace(ALL_CAPS_WORD_PATTERN, (word) => word.toLowerCase());
}

export function formatTextForTts(text: string): string {
  const { text: protectedText, cues } = protectTtsStageDirections(text);

  const strippedText = protectedText
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*{1,2}|_{1,2})(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*>+\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/<[^\u003e]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return restoreTtsStageDirections(normalizeAllCapsWords(strippedText), cues);
}

export { TTS_STAGE_DIRECTIONS };
