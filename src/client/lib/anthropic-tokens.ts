import claudeTokenizer from "@anthropic-ai/tokenizer/claude.json";
import { Tiktoken, type TiktokenBPE } from "js-tiktoken/lite";

const MAX_TOKEN_COUNT_CACHE_ENTRIES = 512;

export interface TokenCountMessage {
  role: "user" | "assistant";
  content: string;
}

let tokenizer: Tiktoken | null = null;
const tokenCountCache = new Map<string, number>();

function getTokenizer() {
  if (!tokenizer) {
    tokenizer = new Tiktoken(claudeTokenizer as TiktokenBPE);
  }

  return tokenizer;
}

function setCachedTokenCount(text: string, count: number) {
  tokenCountCache.set(text, count);

  while (tokenCountCache.size > MAX_TOKEN_COUNT_CACHE_ENTRIES) {
    const oldestKey = tokenCountCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }

    tokenCountCache.delete(oldestKey);
  }
}

export function countAnthropicTokens(text: string): number {
  const normalized = text.normalize("NFKC");
  const cached = tokenCountCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }

  const count = getTokenizer().encode(normalized, "all").length;
  setCachedTokenCount(normalized, count);
  return count;
}

export function buildEffectiveChatHistory(messages: TokenCountMessage[]): Array<{ question: string; answer: string }> {
  const pairs: Array<{ question: string; answer: string }> = [];
  let pendingQuestion: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      pendingQuestion = pendingQuestion !== null
        ? `${pendingQuestion}\n\n${message.content}`
        : message.content;
      continue;
    }

    if (pendingQuestion === null) {
      continue;
    }

    pairs.push({
      question: pendingQuestion,
      answer: message.content,
    });
    pendingQuestion = null;
  }

  return pairs;
}

export function countEffectiveChatHistoryTokens(messages: TokenCountMessage[]): number {
  return buildEffectiveChatHistory(messages).reduce((total, pair) => {
    return total + countAnthropicTokens(pair.question) + countAnthropicTokens(pair.answer);
  }, 0);
}
