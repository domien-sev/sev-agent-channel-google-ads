/**
 * Shared reply utility — splits long messages to avoid Slack truncation.
 * Slack truncates messages around 3000 characters.
 */
import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";

const SLACK_MAX_CHARS = 2900; // Leave some margin under Slack's ~3000 limit

export interface SplitAgentResponse extends AgentResponse {
  messages: string[];
}

/**
 * Build a reply, auto-splitting text into multiple messages if needed.
 * Splits at logical boundaries: section dividers (---), blank lines between
 * sections (*Bold Header*), or line breaks as a last resort.
 */
export function reply(message: RoutedMessage, text: string): SplitAgentResponse {
  const messages = splitMessage(text, SLACK_MAX_CHARS);
  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: messages[0] ?? "",
    messages,
  };
}

/**
 * Split a long message into chunks that fit within maxLen characters.
 * Tries to split at logical boundaries in order of preference:
 *   1. Horizontal rule (---)
 *   2. Double newline before a bold header (*...*)
 *   3. Double newline (paragraph break)
 *   4. Single newline
 */
export function splitMessage(text: string, maxLen: number = SLACK_MAX_CHARS): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const cutRegion = remaining.slice(0, maxLen);

    // Try split strategies in order of preference
    let splitIdx = -1;

    // 1. Horizontal rule divider
    const hrMatch = cutRegion.lastIndexOf("\n---\n");
    if (hrMatch > maxLen * 0.3) {
      splitIdx = hrMatch;
    }

    // 2. Double newline before a bold header
    if (splitIdx === -1) {
      const headerPattern = /\n\n\*[^*]+\*[:\n]/g;
      let match: RegExpExecArray | null;
      let lastMatch = -1;
      while ((match = headerPattern.exec(cutRegion)) !== null) {
        if (match.index > maxLen * 0.3) lastMatch = match.index;
      }
      if (lastMatch > -1) splitIdx = lastMatch;
    }

    // 3. Double newline (paragraph break)
    if (splitIdx === -1) {
      const paraBreak = cutRegion.lastIndexOf("\n\n");
      if (paraBreak > maxLen * 0.3) splitIdx = paraBreak;
    }

    // 4. Single newline
    if (splitIdx === -1) {
      const lineBreak = cutRegion.lastIndexOf("\n");
      if (lineBreak > maxLen * 0.3) splitIdx = lineBreak;
    }

    // 5. Fallback: hard cut
    if (splitIdx === -1) splitIdx = maxLen;

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).replace(/^\n+---\n*/, "").trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining.trimEnd());

  return chunks;
}
