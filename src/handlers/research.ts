import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import * as gaql from "../tools/gaql.js";
import type { AccountHealthScore, CampaignAudit, GaqlRow } from "../types.js";

/**
 * Research handler — account audit, campaign discovery, health scoring.
 *
 * Commands:
 *   "audit" — Full account health audit
 *   "research account" — Discover campaigns and structure
 *   "discover campaigns" — List all campaigns with metrics
 */
export async function handleResearch(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  if (text.includes("audit")) {
    return runAccountAudit(agent, message);
  }

  // Default: campaign discovery
  return discoverCampaigns(agent, message);
}

async function discoverCampaigns(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const query = gaql.campaignOverview();
  const results = await agent.googleAds.query(query) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  const campaigns: Array<{
    name: string;
    type: string;
    status: string;
    budget: number;
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

      campaigns.push({
        name: String(row.campaign?.name ?? "Unknown"),
        type: String(row.campaign?.advertisingChannelType ?? "UNKNOWN"),
        status: String(row.campaign?.status ?? "UNKNOWN"),
        budget: Number(row.campaignBudget?.amountMicros ?? 0) / 1_000_000,
        impressions: Number(row.metrics?.impressions ?? 0),
        clicks: Number(row.metrics?.clicks ?? 0),
        cost,
        conversions: Number(row.metrics?.conversions ?? 0),
        roas: cost > 0 ? revenue / cost : 0,
      });
    }
  }

  if (campaigns.length === 0) {
    return {
      channel_id: message.channel_id,
      thread_ts: message.thread_ts ?? message.ts,
      text: "No campaigns found in this Google Ads account.",
    };
  }

  const lines: string[] = [
    `*Account Overview — ${campaigns.length} campaigns found (last 30 days):*`,
    "",
  ];

  const totalCost = campaigns.reduce((s, c) => s + c.cost, 0);
  const totalConv = campaigns.reduce((s, c) => s + c.conversions, 0);
  const totalRevenue = campaigns.reduce((s, c) => s + c.cost * c.roas, 0);

  lines.push(
    `*Total:* €${totalCost.toFixed(2)} spend | ${totalConv.toFixed(0)} conversions | ROAS ${totalCost > 0 ? (totalRevenue / totalCost).toFixed(2) : "N/A"}x`,
    "",
  );

  // Group by type
  const byType = new Map<string, typeof campaigns>();
  for (const c of campaigns) {
    const existing = byType.get(c.type) ?? [];
    existing.push(c);
    byType.set(c.type, existing);
  }

  for (const [type, typeCampaigns] of byType) {
    lines.push(`*${formatType(type)}* (${typeCampaigns.length}):`);
    for (const c of typeCampaigns.slice(0, 5)) {
      const statusEmoji = c.status === "ENABLED" ? "" : ` [${c.status}]`;
      lines.push(
        `  ${c.name}${statusEmoji} — €${c.cost.toFixed(2)} | ${c.clicks} clicks | ${c.conversions.toFixed(1)} conv | ROAS ${c.roas.toFixed(2)}x`,
      );
    }
    if (typeCampaigns.length > 5) {
      lines.push(`  _...and ${typeCampaigns.length - 5} more_`);
    }
    lines.push("");
  }

  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: lines.join("\n"),
  };
}

async function runAccountAudit(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  agent.log.info("Starting account audit...");

  // Run multiple queries in parallel
  const [campaignData, conversionData, qualityData] = await Promise.all([
    agent.googleAds.query(gaql.campaignOverview()),
    agent.googleAds.query(gaql.conversionActions()),
    agent.googleAds.query(gaql.qualityScoreDistribution()),
  ]) as [
    Array<{ results?: GaqlRow[] }>,
    Array<{ results?: GaqlRow[] }>,
    Array<{ results?: GaqlRow[] }>,
  ];

  // Analyze campaigns
  const campaignAudits: CampaignAudit[] = [];
  let totalBudget = 0;
  let totalSpend = 0;

  for (const batch of campaignData) {
    for (const row of batch.results ?? []) {
      const budget = Number(row.campaignBudget?.amountMicros ?? 0) / 1_000_000;
      const cost = Number(row.metrics?.costMicros ?? 0) / 1_000_000;
      const impressions = Number(row.metrics?.impressions ?? 0);
      const clicks = Number(row.metrics?.clicks ?? 0);
      const conversions = Number(row.metrics?.conversions ?? 0);
      const revenue = Number(row.metrics?.conversionsValue ?? 0);

      totalBudget += budget * 30; // Monthly
      totalSpend += cost;

      const issues: string[] = [];
      const recommendations: string[] = [];

      // Check for common issues
      if (impressions > 0 && clicks === 0) {
        issues.push("Zero clicks despite impressions");
        recommendations.push("Review ad copy and targeting");
      }
      if (clicks > 50 && conversions === 0) {
        issues.push("No conversions despite clicks");
        recommendations.push("Check conversion tracking and landing pages");
      }
      if (cost > 0 && revenue === 0 && conversions > 0) {
        issues.push("Conversions have no value assigned");
        recommendations.push("Set up conversion values");
      }
      const ctr = impressions > 0 ? clicks / impressions : 0;
      if (ctr < 0.01 && impressions > 100) {
        issues.push(`Low CTR: ${(ctr * 100).toFixed(2)}%`);
        recommendations.push("Improve ad relevance and extensions");
      }

      campaignAudits.push({
        campaignId: String(row.campaign?.id ?? ""),
        campaignName: String(row.campaign?.name ?? "Unknown"),
        type: String(row.campaign?.advertisingChannelType ?? "UNKNOWN"),
        status: String(row.campaign?.status ?? "UNKNOWN"),
        budgetMicros: Number(row.campaignBudget?.amountMicros ?? 0),
        impressions30d: impressions,
        clicks30d: clicks,
        cost30d: cost,
        conversions30d: conversions,
        roas30d: cost > 0 ? revenue / cost : 0,
        issues,
        recommendations,
      });
    }
  }

  // Analyze quality scores
  let totalQS = 0;
  let qsCount = 0;
  for (const batch of qualityData) {
    for (const row of batch.results ?? []) {
      const qs = Number(row.adGroupCriterion?.qualityInfo?.qualityScore ?? 0);
      if (qs > 0) {
        totalQS += qs * Number(row.metrics?.impressions ?? 1);
        qsCount += Number(row.metrics?.impressions ?? 1);
      }
    }
  }
  const avgQS = qsCount > 0 ? totalQS / qsCount : 0;

  // Check conversion tracking
  let conversionActionsCount = 0;
  for (const batch of conversionData) {
    for (const row of batch.results ?? []) {
      const allConv = Number(row.metrics?.allConversions ?? 0);
      if (allConv > 0 || row.conversionAction?.status === "ENABLED") {
        conversionActionsCount++;
      }
    }
  }

  // Calculate scores
  const budgetUtilization = totalBudget > 0 ? Math.min(100, (totalSpend / totalBudget) * 100) : 0;
  const qualityScoreScore = Math.min(100, avgQS * 10);
  const conversionTrackingScore = conversionActionsCount > 0 ? 100 : 0;
  const issueCount = campaignAudits.reduce((s, c) => s + c.issues.length, 0);
  const adCoverageScore = Math.max(0, 100 - issueCount * 10);

  const overall = Math.round(
    (budgetUtilization * 0.2 +
      qualityScoreScore * 0.3 +
      conversionTrackingScore * 0.2 +
      adCoverageScore * 0.3),
  );

  // Format output
  const lines: string[] = [
    `*Account Health Audit*`,
    "",
    `*Overall Score: ${overall}/100* ${overall >= 80 ? "Good" : overall >= 60 ? "Needs Work" : "Critical"}`,
    "",
    `*Scores:*`,
    `  Budget Utilization: ${budgetUtilization.toFixed(0)}/100`,
    `  Quality Score (avg): ${avgQS.toFixed(1)}/10 (${qualityScoreScore.toFixed(0)}/100)`,
    `  Conversion Tracking: ${conversionTrackingScore}/100 (${conversionActionsCount} actions)`,
    `  Ad Coverage: ${adCoverageScore}/100`,
    "",
    `*Campaigns (${campaignAudits.length}):*`,
  ];

  for (const audit of campaignAudits.slice(0, 10)) {
    const statusIcon = audit.status === "ENABLED" ? "" : ` [${audit.status}]`;
    lines.push(
      `  *${audit.campaignName}*${statusIcon} (${formatType(audit.type)})`,
      `    €${audit.cost30d.toFixed(2)} spend | ${audit.conversions30d.toFixed(1)} conv | ROAS ${audit.roas30d.toFixed(2)}x`,
    );
    if (audit.issues.length > 0) {
      for (const issue of audit.issues) {
        lines.push(`    Issue: ${issue}`);
      }
    }
  }

  // Top issues
  const allIssues = campaignAudits.flatMap((a) =>
    a.issues.map((i) => `${a.campaignName}: ${i}`),
  );
  if (allIssues.length > 0) {
    lines.push("", `*Top Issues (${allIssues.length}):*`);
    for (const issue of allIssues.slice(0, 5)) {
      lines.push(`  - ${issue}`);
    }
  }

  // Store audit in shared memory for other agents
  try {
    await agent.setMemory("google_ads_audit", {
      score: overall,
      avgQualityScore: avgQS,
      campaignCount: campaignAudits.length,
      totalSpend: totalSpend,
      issueCount,
      date: new Date().toISOString(),
    });
  } catch {
    // Non-critical
  }

  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text: lines.join("\n"),
  };
}

function formatType(type: string): string {
  const map: Record<string, string> = {
    SEARCH: "Search",
    SHOPPING: "Shopping",
    PERFORMANCE_MAX: "Performance Max",
    DISPLAY: "Display",
    VIDEO: "YouTube",
  };
  return map[type] ?? type;
}
