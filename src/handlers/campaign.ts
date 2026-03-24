import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import { buildCampaign } from "../tools/campaign-builder.js";
import type { CampaignConfig, GoogleCampaignType } from "../types.js";
import { reply } from "../tools/reply.js";

/**
 * Campaign creation handler.
 * Supports all 5 campaign types: search, shopping, pmax, display, youtube.
 *
 * Commands:
 *   "create search campaign \"Name\"" — Create a search campaign
 *   "create shopping campaign \"Name\"" — Create a shopping campaign
 *   "create pmax campaign \"Name\"" — Create a Performance Max campaign
 *   "create display campaign \"Name\"" — Create a display campaign
 *   "create youtube campaign \"Name\"" — Create a YouTube campaign
 */
export async function handleCampaign(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim();

  // Parse campaign type and name
  const match = text.match(
    /create\s+(search|shopping|pmax|display|youtube)\s+campaign\s+["']?(.+?)["']?\s*$/i,
  );

  if (!match) {
    return reply(message, [
      "Usage: `create [type] campaign \"Campaign Name\"`",
      "",
      "Campaign types:",
      "  `search` — Text ads on Google Search",
      "  `shopping` — Product ads from Merchant Center",
      "  `pmax` — Performance Max (all Google channels)",
      "  `display` — Banner ads on Display Network",
      "  `youtube` — Video ads on YouTube",
      "",
      'Example: `create search campaign "Summer Sale BE"`',
    ].join("\n"));
  }

  const [, typeStr, campaignName] = match;
  const campaignType = typeStr.toLowerCase() as GoogleCampaignType;

  agent.log.info(`Creating ${campaignType} campaign: "${campaignName}"`);

  // Build default config — campaign starts paused for approval
  const config: CampaignConfig = {
    type: campaignType,
    name: campaignName,
    dailyBudgetMicros: 20_000_000, // €20/day default
    locations: ["BE", "NL"],
    languages: ["nl", "fr"],
    startDate: new Date().toISOString().split("T")[0],
  };

  // Type-specific defaults
  switch (campaignType) {
    case "search":
      config.adGroupName = `${campaignName} - Ad Group 1`;
      break;

    case "shopping":
      config.merchantId = process.env.GOOGLE_MERCHANT_ID;
      config.feedLabel = "online";
      break;

    case "pmax":
      config.assetGroup = {
        name: `${campaignName} - Asset Group`,
        finalUrls: [process.env.LANDING_PAGE_URL ?? "https://www.shoppingeventvip.be"],
        headlines: [
          campaignName,
          "Shop Nu",
          "Beste Deals",
        ],
        descriptions: [
          `Ontdek ${campaignName} bij Shopping Event VIP. Topmerken aan outletprijzen.`,
          "Gratis verzending vanaf €50. Snelle levering.",
        ],
      };
      break;

    case "youtube":
      config.targetCpa = 15; // €15 CPA target
      break;

    case "display":
      config.displayNetwork = true;
      break;
  }

  try {
    const result = await buildCampaign(agent.googleAds, config);

    // Post approval summary
    const lines: string[] = [
      `*Campaign Created: "${campaignName}"*`,
      "",
      `*Type:* ${formatCampaignType(campaignType)}`,
      `*Budget:* €${(config.dailyBudgetMicros / 1_000_000).toFixed(2)}/day`,
      `*Locations:* ${config.locations.join(", ")}`,
      `*Status:* PAUSED (awaiting approval)`,
      "",
      `*Resource:* \`${result.campaignResourceName}\``,
    ];

    if (result.adGroupResourceName) {
      lines.push(`*Ad Group:* \`${result.adGroupResourceName}\``);
    }
    if (result.assetGroupResourceName) {
      lines.push(`*Asset Group:* \`${result.assetGroupResourceName}\``);
    }

    lines.push(
      "",
      "_Campaign is paused. Configure targeting, add creatives, then enable when ready._",
      "",
      "Next steps:",
    );

    switch (campaignType) {
      case "search":
        lines.push(
          "  1. `keywords for [topic]` — Add keywords",
          "  2. Write RSA headlines + descriptions",
          "  3. Enable campaign when ready",
        );
        break;
      case "shopping":
        lines.push(
          "  1. Verify Merchant Center feed is linked",
          "  2. Set product group filters",
          "  3. Enable campaign when ready",
        );
        break;
      case "pmax":
        lines.push(
          "  1. `request creatives for [campaign]` — Get image/video assets",
          "  2. Add audience signals",
          "  3. Enable campaign when ready",
        );
        break;
      case "display":
        lines.push(
          "  1. `request creatives for [campaign]` — Get display banners",
          "  2. `create audience [name]` — Set targeting",
          "  3. Enable campaign when ready",
        );
        break;
      case "youtube":
        lines.push(
          "  1. `request creatives for [campaign]` — Get video assets",
          "  2. Set audience targeting",
          "  3. Enable campaign when ready",
        );
        break;
    }

    return reply(message, lines.join("\n"));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    agent.log.error(`Campaign creation failed: ${errMsg}`);
    return reply(message, `Failed to create campaign: ${errMsg}`);
  }
}

function formatCampaignType(type: GoogleCampaignType): string {
  const map: Record<GoogleCampaignType, string> = {
    search: "Search",
    shopping: "Shopping",
    pmax: "Performance Max",
    display: "Display",
    youtube: "YouTube",
  };
  return map[type];
}
