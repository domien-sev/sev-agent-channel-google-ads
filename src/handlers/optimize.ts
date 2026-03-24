import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import * as gaql from "../tools/gaql.js";
import { getQualityScoreBreakdown, findNegativeCandidates } from "../tools/keyword-planner.js";
import { reply } from "../tools/reply.js";

/** Campaigns with ROAS above this are candidates for budget increase */
const HIGH_ROAS_THRESHOLD = 3;
/** Campaigns with ROAS below this (with min spend) are flagged as underperforming */
const LOW_ROAS_THRESHOLD = 1;
/** Minimum spend (€) before a campaign is flagged as underperforming */
const MIN_SPEND_FOR_FLAG = 10;
/** CTR (%) below this triggers a low-CTR warning */
const LOW_CTR_THRESHOLD = 1;
/** Minimum spend (€) before a low-CTR campaign is flagged */
const MIN_SPEND_FOR_CTR_FLAG = 5;
/** Budget scale-up factor for high-ROAS campaigns */
const BUDGET_SCALE_UP = 1.5;
/** Budget rebalance scale-up factor (more conservative than full optimization) */
const REBALANCE_SCALE_UP = 1.3;
/** Budget rebalance scale-down factor for underperformers */
const REBALANCE_SCALE_DOWN = 0.7;

/**
 * Optimization handler — budget reallocation, bid adjustments, quality score.
 *
 * Commands:
 *   "optimize" — Full optimization analysis + recommendations
 *   "rebalance budget" — Budget reallocation suggestions
 *   "improve quality" — Quality score improvement plan
 */
export async function handleOptimize(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  if (text.includes("rebalance") || text.includes("budget")) {
    return handleBudgetRebalance(agent, message);
  }

  if (text.includes("quality") || text.includes("improve")) {
    return handleQualityImprovement(agent, message);
  }

  return handleFullOptimization(agent, message);
}

async function handleFullOptimization(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  agent.log.info("Running full optimization analysis...");

  // Gather data in parallel
  const [campaignResults, qsBreakdown, negativeCandidates] = await Promise.all([
    agent.googleAds.query(gaql.campaignOverview()),
    getQualityScoreBreakdown(agent.googleAds),
    findNegativeCandidates(agent.googleAds),
  ]) as [
    Array<{ results?: Array<Record<string, Record<string, string | number>>> }>,
    Awaited<ReturnType<typeof getQualityScoreBreakdown>>,
    Awaited<ReturnType<typeof findNegativeCandidates>>,
  ];

  // Analyze campaigns
  const campaigns: Array<{
    name: string;
    id: string;
    cost: number;
    conversions: number;
    roas: number;
    ctr: number;
    budget: number;
  }> = [];

  for (const batch of campaignResults) {
    for (const row of batch.results ?? []) {
      const cost = Number(row.metrics?.costMicros ?? 0) / 1_000_000;
      const revenue = Number(row.metrics?.conversionsValue ?? 0);
      const impressions = Number(row.metrics?.impressions ?? 0);
      const clicks = Number(row.metrics?.clicks ?? 0);

      campaigns.push({
        name: String(row.campaign?.name ?? "Unknown"),
        id: String(row.campaign?.id ?? ""),
        cost,
        conversions: Number(row.metrics?.conversions ?? 0),
        roas: cost > 0 ? revenue / cost : 0,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        budget: Number(row.campaignBudget?.amountMicros ?? 0) / 1_000_000,
      });
    }
  }

  const lines: string[] = [
    "*Optimization Analysis*",
    "",
  ];

  // 1. Budget recommendations
  const highRoas = campaigns.filter((c) => c.roas > HIGH_ROAS_THRESHOLD && c.cost > 0).sort((a, b) => b.roas - a.roas);
  const lowRoas = campaigns.filter((c) => c.roas < LOW_ROAS_THRESHOLD && c.cost > MIN_SPEND_FOR_FLAG).sort((a, b) => a.roas - b.roas);

  if (highRoas.length > 0) {
    lines.push("*Budget Scale-Up Opportunities:*");
    for (const c of highRoas.slice(0, 3)) {
      const suggestedBudget = Math.round(c.budget * BUDGET_SCALE_UP);
      lines.push(
        `  *${c.name}* — ROAS ${c.roas.toFixed(2)}x, current €${c.budget.toFixed(0)}/day → suggest €${suggestedBudget}/day`,
      );
    }
    lines.push("");
  }

  if (lowRoas.length > 0) {
    lines.push("*Underperforming Campaigns (consider pausing or restructuring):*");
    for (const c of lowRoas.slice(0, 3)) {
      lines.push(
        `  *${c.name}* — ROAS ${c.roas.toFixed(2)}x, €${c.cost.toFixed(2)} spent, ${c.conversions.toFixed(1)} conv`,
      );
    }
    lines.push("");
  }

  // 2. Quality Score
  if (qsBreakdown.average > 0) {
    lines.push(`*Quality Score:* Average ${qsBreakdown.average.toFixed(1)}/10`);
    if (qsBreakdown.lowScoreKeywords.length > 0) {
      lines.push(`  ${qsBreakdown.lowScoreKeywords.length} keywords with QS ≤ 5 — run \`improve quality\` for details`);
    }
    lines.push("");
  }

  // 3. Negative keywords
  if (negativeCandidates.length > 0) {
    const wastedSpend = negativeCandidates.reduce((s, c) => s + c.cost, 0);
    lines.push(`*Wasted Spend:* €${wastedSpend.toFixed(2)} on ${negativeCandidates.length} irrelevant search terms`);
    lines.push("  Top candidates to add as negatives:");
    for (const c of negativeCandidates.slice(0, 5)) {
      lines.push(`    "${c.searchTerm}" — ${c.reason}`);
    }
    lines.push(`  _Run \`add negatives ${negativeCandidates.slice(0, 3).map((c) => c.searchTerm).join(", ")}\` to clean up_`);
    lines.push("");
  }

  // 4. Low CTR campaigns
  const lowCtr = campaigns.filter((c) => c.ctr < LOW_CTR_THRESHOLD && c.cost > MIN_SPEND_FOR_CTR_FLAG);
  if (lowCtr.length > 0) {
    lines.push("*Low CTR Campaigns (< 1%):*");
    for (const c of lowCtr.slice(0, 3)) {
      lines.push(`  *${c.name}* — CTR ${c.ctr.toFixed(2)}% → Review ad copy and targeting`);
    }
    lines.push("");
  }

  if (lines.length === 2) {
    lines.push("No optimization opportunities found. Account is performing well.");
  }

  return reply(message, lines.join("\n"));
}

async function handleBudgetRebalance(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const results = await agent.googleAds.query(gaql.campaignOverview()) as Array<{
    results?: Array<Record<string, Record<string, string | number>>>;
  }>;

  const campaigns: Array<{
    name: string;
    resourceName: string;
    budget: number;
    cost: number;
    roas: number;
    conversions: number;
  }> = [];

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      const cost = Number(row.metrics?.costMicros ?? 0) / 1_000_000;
      const revenue = Number(row.metrics?.conversionsValue ?? 0);

      if (String(row.campaign?.status) !== "ENABLED") continue;

      campaigns.push({
        name: String(row.campaign?.name ?? "Unknown"),
        resourceName: String(row.campaign?.id ?? ""),
        budget: Number(row.campaignBudget?.amountMicros ?? 0) / 1_000_000,
        cost,
        roas: cost > 0 ? revenue / cost : 0,
        conversions: Number(row.metrics?.conversions ?? 0),
      });
    }
  }

  if (campaigns.length === 0) {
    return reply(message, "No active campaigns to rebalance.");
  }

  const totalBudget = campaigns.reduce((s, c) => s + c.budget, 0);

  // Sort by ROAS — shift budget from lowest to highest performers
  const sorted = [...campaigns].sort((a, b) => b.roas - a.roas);

  const lines: string[] = [
    `*Budget Rebalance Suggestions* (total: €${totalBudget.toFixed(0)}/day)`,
    "",
    "| Campaign | Current | ROAS | Suggested | Change |",
    "|----------|---------|------|-----------|--------|",
  ];

  for (const c of sorted) {
    let suggestedBudget = c.budget;
    let change = "";

    if (c.roas > HIGH_ROAS_THRESHOLD) {
      suggestedBudget = Math.round(c.budget * REBALANCE_SCALE_UP);
      change = `+${((suggestedBudget - c.budget) / c.budget * 100).toFixed(0)}%`;
    } else if (c.roas < LOW_ROAS_THRESHOLD && c.cost > MIN_SPEND_FOR_FLAG) {
      suggestedBudget = Math.round(c.budget * REBALANCE_SCALE_DOWN);
      change = `${((suggestedBudget - c.budget) / c.budget * 100).toFixed(0)}%`;
    } else {
      change = "—";
    }

    lines.push(
      `| ${c.name} | €${c.budget.toFixed(0)} | ${c.roas.toFixed(2)}x | €${suggestedBudget} | ${change} |`,
    );
  }

  lines.push("", "_These are suggestions only. Budget changes must be applied manually or via approval flow._");

  return reply(message, lines.join("\n"));
}

async function handleQualityImprovement(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const breakdown = await getQualityScoreBreakdown(agent.googleAds);

  const lines: string[] = [
    "*Quality Score Improvement Plan*",
    "",
    `*Current Average:* ${breakdown.average.toFixed(1)}/10`,
    "",
  ];

  if (breakdown.lowScoreKeywords.length === 0) {
    lines.push("All keywords have quality scores above 5. No immediate action needed.");
    return reply(message, lines.join("\n"));
  }

  // Group by issue type
  const ctrIssues = breakdown.lowScoreKeywords.filter((k) => k.expectedCtr === "BELOW_AVERAGE");
  const relevanceIssues = breakdown.lowScoreKeywords.filter((k) => k.adRelevance === "BELOW_AVERAGE");
  const landingIssues = breakdown.lowScoreKeywords.filter((k) => k.landingPage === "BELOW_AVERAGE");

  if (ctrIssues.length > 0) {
    const wastedSpend = ctrIssues.reduce((s, k) => s + k.cost, 0);
    lines.push(`*Expected CTR: Below Average* (${ctrIssues.length} keywords, €${wastedSpend.toFixed(2)} spend)`);
    lines.push("  Actions: Improve ad headlines, add callout extensions, test new CTAs");
    for (const k of ctrIssues.slice(0, 5)) {
      lines.push(`    \`${k.keyword}\` QS:${k.score}`);
    }
    lines.push("");
  }

  if (relevanceIssues.length > 0) {
    const wastedSpend = relevanceIssues.reduce((s, k) => s + k.cost, 0);
    lines.push(`*Ad Relevance: Below Average* (${relevanceIssues.length} keywords, €${wastedSpend.toFixed(2)} spend)`);
    lines.push("  Actions: Include keywords in ad copy, tighten ad group themes, use DKI");
    for (const k of relevanceIssues.slice(0, 5)) {
      lines.push(`    \`${k.keyword}\` QS:${k.score}`);
    }
    lines.push("");
  }

  if (landingIssues.length > 0) {
    const wastedSpend = landingIssues.reduce((s, k) => s + k.cost, 0);
    lines.push(`*Landing Page Experience: Below Average* (${landingIssues.length} keywords, €${wastedSpend.toFixed(2)} spend)`);
    lines.push("  Actions: Improve page speed, mobile experience, content relevance");
    for (const k of landingIssues.slice(0, 5)) {
      lines.push(`    \`${k.keyword}\` QS:${k.score}`);
    }
    lines.push("");
  }

  return reply(message, lines.join("\n"));
}
