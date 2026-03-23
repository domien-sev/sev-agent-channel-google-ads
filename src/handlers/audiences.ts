import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import * as gaql from "../tools/gaql.js";

/**
 * Audiences handler — custom segments, remarketing, in-market.
 *
 * Commands:
 *   "create audience [name]" — Create custom audience segment
 *   "audience report" — Audience performance report
 */
export async function handleAudiences(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  if (text.startsWith("create") && text.includes("audience")) {
    return handleCreateAudience(agent, message);
  }

  return handleAudienceReport(agent, message);
}

async function handleAudienceReport(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const query = gaql.audiencePerformance();
  const results = await agent.googleAds.query(query) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  const audiences: Array<{
    campaign: string;
    audience: string;
    impressions: number;
    clicks: number;
    cost: number;
    conversions: number;
    revenue: number;
  }> = [];

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      const cost = Number(row.metrics?.costMicros ?? 0) / 1_000_000;
      audiences.push({
        campaign: String(row.campaign?.name ?? "Unknown"),
        audience: String(
          row.adGroupCriterion?.userList?.userList ??
          row.adGroupCriterion?.customAudience?.customAudience ??
          "Unknown",
        ),
        impressions: Number(row.metrics?.impressions ?? 0),
        clicks: Number(row.metrics?.clicks ?? 0),
        cost,
        conversions: Number(row.metrics?.conversions ?? 0),
        revenue: Number(row.metrics?.conversionsValue ?? 0),
      });
    }
  }

  if (audiences.length === 0) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: "No audience data found. Your campaigns may not have audience targeting configured yet.",
    };
  }

  const lines: string[] = [
    `*Audience Performance Report (last 30 days) — ${audiences.length} segments*`,
    "",
  ];

  for (const a of audiences.slice(0, 15)) {
    const roas = a.cost > 0 ? (a.revenue / a.cost).toFixed(2) : "N/A";
    lines.push(
      `  *${a.campaign}* → ${a.audience}`,
      `    ${a.impressions.toLocaleString()} imp | ${a.clicks} clicks | €${a.cost.toFixed(2)} | ${a.conversions.toFixed(1)} conv | ROAS ${roas}x`,
    );
  }

  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: lines.join("\n"),
  };
}

async function handleCreateAudience(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim();
  const nameMatch = text.match(/create\s+(?:audience|segment)\s+["']?(.+?)["']?\s*$/i);

  if (!nameMatch) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: [
        'Usage: `create audience "Audience Name"`',
        "",
        "This creates a custom intent audience on Google Ads.",
        "You can then assign it to campaigns for targeting.",
        "",
        'Example: `create audience "Fashion Shoppers Belgium"`',
      ].join("\n"),
    };
  }

  const [, audienceName] = nameMatch;

  try {
    // Create custom audience via Google Ads API
    const result = await agent.googleAds.mutateResource("customAudiences", [{
      create: {
        name: audienceName,
        type: "AUTO",
        status: "ENABLED",
      },
    }]);

    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: [
        `*Custom Audience Created: "${audienceName}"*`,
        "",
        `Resource: \`${result.results[0].resourceName}\``,
        "",
        "Next: Add this audience as targeting to your campaigns.",
        "You can add keywords, URLs, and apps to refine the audience in Google Ads UI.",
      ].join("\n"),
    };
  } catch (err) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: `Failed to create audience: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
