import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import * as gaql from "../tools/gaql.js";
import { getTopShoppingProducts } from "../tools/feed.js";
import { reply } from "../tools/reply.js";

/**
 * Reporting handler — performance analytics, GAQL reports.
 *
 * Commands:
 *   "report daily/weekly" — Performance summary
 *   "performance [campaign]" — Detailed campaign metrics
 *   "quality score" — Quality score overview
 */
export async function handleReport(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  if (text.includes("quality score")) {
    return handleQualityScoreReport(agent, message);
  }

  if (text.includes("shopping") || text.includes("product")) {
    return handleShoppingReport(agent, message);
  }

  if (text.includes("pmax") || text.includes("asset group")) {
    return handlePMaxReport(agent, message);
  }

  return handlePerformanceReport(agent, message);
}

async function handlePerformanceReport(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();
  const isWeekly = text.includes("weekly") || text.includes("week");
  const days = isWeekly ? 7 : 1;

  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];

  const range = { startDate, endDate };
  const results = await agent.googleAds.query(gaql.campaignOverview(range)) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  let totalImpressions = 0;
  let totalClicks = 0;
  let totalCost = 0;
  let totalConversions = 0;
  let totalRevenue = 0;

  const campaigns: Array<{
    name: string;
    type: string;
    status: string;
    impressions: number;
    clicks: number;
    cost: number;
    conversions: number;
    roas: number;
  }> = [];

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      const cost = Number(row.metrics?.costMicros ?? 0) / 1_000_000;
      const revenue = Number(row.metrics?.conversionsValue ?? 0);
      const impressions = Number(row.metrics?.impressions ?? 0);
      const clicks = Number(row.metrics?.clicks ?? 0);
      const conversions = Number(row.metrics?.conversions ?? 0);

      totalImpressions += impressions;
      totalClicks += clicks;
      totalCost += cost;
      totalConversions += conversions;
      totalRevenue += revenue;

      campaigns.push({
        name: String(row.campaign?.name ?? "Unknown"),
        type: String(row.campaign?.advertisingChannelType ?? "UNKNOWN"),
        status: String(row.campaign?.status ?? "UNKNOWN"),
        impressions,
        clicks,
        cost,
        conversions,
        roas: cost > 0 ? revenue / cost : 0,
      });
    }
  }

  const totalCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const totalRoas = totalCost > 0 ? totalRevenue / totalCost : 0;
  const totalCpa = totalConversions > 0 ? totalCost / totalConversions : 0;

  const lines: string[] = [
    `*Google Ads ${isWeekly ? "Weekly" : "Daily"} Report (${startDate} → ${endDate})*`,
    "",
    `*Total:* ${totalImpressions.toLocaleString()} impressions | ${totalClicks.toLocaleString()} clicks | CTR ${totalCtr.toFixed(2)}%`,
    `*Spend:* €${totalCost.toFixed(2)} | *Revenue:* €${totalRevenue.toFixed(2)} | *ROAS:* ${totalRoas.toFixed(2)}x`,
    `*Conversions:* ${totalConversions.toFixed(1)} | *CPA:* €${totalCpa.toFixed(2)}`,
    "",
    "*By Campaign:*",
  ];

  for (const c of campaigns.sort((a, b) => b.cost - a.cost).slice(0, 10)) {
    const statusIcon = c.status === "ENABLED" ? "" : ` [${c.status}]`;
    lines.push(
      `  *${c.name}*${statusIcon} (${formatType(c.type)})`,
      `    €${c.cost.toFixed(2)} | ${c.clicks} clicks | ${c.conversions.toFixed(1)} conv | ROAS ${c.roas.toFixed(2)}x`,
    );
  }

  return reply(message, lines.join("\n"));
}

async function handleQualityScoreReport(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const results = await agent.googleAds.query(gaql.qualityScoreDistribution()) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  const distribution: Record<number, { count: number; impressions: number; cost: number }> = {};
  let total = 0;

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      const qs = Number(row.adGroupCriterion?.qualityInfo?.qualityScore ?? 0);
      if (qs === 0) continue;

      if (!distribution[qs]) distribution[qs] = { count: 0, impressions: 0, cost: 0 };
      distribution[qs].count++;
      distribution[qs].impressions += Number(row.metrics?.impressions ?? 0);
      distribution[qs].cost += Number(row.metrics?.costMicros ?? 0) / 1_000_000;
      total++;
    }
  }

  if (total === 0) {
    return reply(message, "No quality score data available. This is normal for Shopping and PMax campaigns.");
  }

  const lines: string[] = [
    `*Quality Score Distribution — ${total} keywords*`,
    "",
    "| QS | Keywords | Impressions | Spend |",
    "|----|----------|-------------|-------|",
  ];

  for (let qs = 10; qs >= 1; qs--) {
    const d = distribution[qs];
    if (d) {
      lines.push(
        `| ${qs} | ${d.count} | ${d.impressions.toLocaleString()} | €${d.cost.toFixed(2)} |`,
      );
    }
  }

  const lowQS = Object.entries(distribution)
    .filter(([qs]) => Number(qs) <= 5)
    .reduce((s, [, d]) => s + d.cost, 0);

  if (lowQS > 0) {
    lines.push("", `_€${lowQS.toFixed(2)} spent on keywords with QS ≤ 5. Run \`improve quality\` for optimization plan._`);
  }

  return reply(message, lines.join("\n"));
}

async function handleShoppingReport(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const products = await getTopShoppingProducts(agent.googleAds);

  if (products.length === 0) {
    return reply(message, "No Shopping performance data found. Ensure you have active Shopping or PMax campaigns.");
  }

  const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
  const totalCost = products.reduce((s, p) => s + p.cost, 0);

  const lines: string[] = [
    `*Shopping Product Performance (last 30 days) — ${products.length} products*`,
    "",
    `*Total:* €${totalCost.toFixed(2)} spend | €${totalRevenue.toFixed(2)} revenue | ROAS ${totalCost > 0 ? (totalRevenue / totalCost).toFixed(2) : "N/A"}x`,
    "",
    "*Top Products:*",
  ];

  for (const p of products.slice(0, 15)) {
    lines.push(
      `  *${p.title}* (${p.brand})`,
      `    ${p.impressions.toLocaleString()} imp | ${p.clicks} clicks | €${p.cost.toFixed(2)} | ${p.conversions.toFixed(1)} conv | ROAS ${p.roas.toFixed(2)}x`,
    );
  }

  return reply(message, lines.join("\n"));
}

async function handlePMaxReport(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const results = await agent.googleAds.query(gaql.assetGroupPerformance()) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  const assetGroups: Array<{
    campaign: string;
    name: string;
    status: string;
    impressions: number;
    clicks: number;
    cost: number;
    conversions: number;
    revenue: number;
  }> = [];

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      assetGroups.push({
        campaign: String(row.campaign?.name ?? "Unknown"),
        name: String(row.assetGroup?.name ?? "Unknown"),
        status: String(row.assetGroup?.primaryStatus ?? row.assetGroup?.status ?? "UNKNOWN"),
        impressions: Number(row.metrics?.impressions ?? 0),
        clicks: Number(row.metrics?.clicks ?? 0),
        cost: Number(row.metrics?.costMicros ?? 0) / 1_000_000,
        conversions: Number(row.metrics?.conversions ?? 0),
        revenue: Number(row.metrics?.conversionsValue ?? 0),
      });
    }
  }

  if (assetGroups.length === 0) {
    return reply(message, "No Performance Max asset groups found.");
  }

  const lines: string[] = [
    `*Performance Max Asset Group Report (last 30 days) — ${assetGroups.length} groups*`,
    "",
  ];

  for (const ag of assetGroups) {
    const roas = ag.cost > 0 ? (ag.revenue / ag.cost).toFixed(2) : "N/A";
    lines.push(
      `  *${ag.campaign}* → ${ag.name} [${ag.status}]`,
      `    ${ag.impressions.toLocaleString()} imp | ${ag.clicks} clicks | €${ag.cost.toFixed(2)} | ${ag.conversions.toFixed(1)} conv | ROAS ${roas}x`,
    );
  }

  return reply(message, lines.join("\n"));
}

function formatType(type: string): string {
  const map: Record<string, string> = {
    SEARCH: "Search",
    SHOPPING: "Shopping",
    PERFORMANCE_MAX: "PMax",
    DISPLAY: "Display",
    VIDEO: "YouTube",
  };
  return map[type] ?? type;
}
