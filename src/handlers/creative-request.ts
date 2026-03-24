import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import { reply } from "../tools/reply.js";

/**
 * Creative request handler — delegates creative generation to sev-agent-ads.
 *
 * Commands:
 *   "request creatives for [campaign]" — Request from ads agent
 *   "need creatives for [campaign]" — Same
 */
export async function handleCreativeRequest(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim();
  const match = text.match(/(?:request|need)\s+creatives?\s+for\s+["']?(.+?)["']?\s*$/i);

  if (!match) {
    return reply(message, 'Usage: `request creatives for "Campaign Name"`\n\nThis delegates creative generation to the Ads Agent, which handles image and video creation.');
  }

  const [, campaignName] = match;

  try {
    // Delegate task to sev-agent-ads
    const task = await agent.delegateTask(
      "ads",
      `Generate Google Ads creatives for campaign "${campaignName}"`,
      {
        campaignName,
        platform: "google",
        requestedBy: message.user_id,
        formats: [
          { type: "image", aspectRatio: "1.91:1", label: "Landscape (Display/YouTube)" },
          { type: "image", aspectRatio: "1:1", label: "Square (Discovery/PMax)" },
          { type: "image", aspectRatio: "4:5", label: "Portrait (PMax)" },
        ],
      },
    );

    return reply(message, [
      `*Creative Request Sent to Ads Agent*`,
      "",
      `Campaign: "${campaignName}"`,
      `Task ID: ${task.id ?? "pending"}`,
      `Status: ${task.status}`,
      "",
      "Requested formats:",
      "  - Landscape 1.91:1 (Display/YouTube)",
      "  - Square 1:1 (Discovery/PMax)",
      "  - Portrait 4:5 (PMax)",
      "",
      "You'll be notified in `#ads-review` when creatives are ready for approval.",
    ].join("\n"));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    agent.log.error(`Creative request failed: ${errMsg}`);
    return reply(message, `Failed to request creatives: ${errMsg}\n\nYou can also request directly in \`#ads-commands\`: \`generate ads for [product]\``);
  }
}
