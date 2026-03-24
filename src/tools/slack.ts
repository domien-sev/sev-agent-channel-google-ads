/**
 * Lightweight Slack API client — direct posting with Block Kit.
 * Uses native fetch(), no @slack/web-api dependency.
 */

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";

export interface SlackBlock {
  type: string;
  [key: string]: any;
}

interface SlackPostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

/**
 * Post a message to Slack with optional Block Kit blocks.
 */
export async function slackPost(
  channel: string,
  opts: {
    text: string;
    blocks?: SlackBlock[];
    thread_ts?: string;
  },
): Promise<SlackPostResult> {
  if (!SLACK_BOT_TOKEN) {
    console.warn("[slack] No SLACK_BOT_TOKEN — cannot post directly");
    return { ok: false, error: "no_token" };
  }

  const body: Record<string, any> = {
    channel,
    text: opts.text,
  };
  if (opts.blocks) body.blocks = opts.blocks;
  if (opts.thread_ts) body.thread_ts = opts.thread_ts;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as SlackPostResult;
  if (!data.ok) {
    console.error(`[slack] chat.postMessage failed: ${data.error}`);
  }
  return data;
}

/**
 * Update an existing Slack message (e.g., to disable buttons after click).
 */
export async function slackUpdate(
  channel: string,
  ts: string,
  opts: {
    text?: string;
    blocks?: SlackBlock[];
  },
): Promise<SlackPostResult> {
  if (!SLACK_BOT_TOKEN) return { ok: false, error: "no_token" };

  const body: Record<string, any> = { channel, ts };
  if (opts.text) body.text = opts.text;
  if (opts.blocks) body.blocks = opts.blocks;

  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as SlackPostResult;
  if (!data.ok) {
    console.error(`[slack] chat.update failed: ${data.error}`);
  }
  return data;
}

/**
 * Check if direct Slack posting is available.
 */
export function isSlackConfigured(): boolean {
  return SLACK_BOT_TOKEN.length > 0;
}
