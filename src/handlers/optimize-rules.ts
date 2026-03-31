/**
 * Rule-based optimization handler — uses the shared CampaignOptimizer engine.
 * Keeps the old optimize.ts for ad-hoc analysis (optimize, rebalance, improve quality).
 * This handler manages rules, approval flow, and cron-triggered optimization.
 *
 * Commands:
 *   "rules" — Run optimization rules cycle
 *   "approve ..." / "reject ..." / "snooze ..." — Handle approval responses
 *   "status rules" — Show current pending recommendations
 */
import type { RoutedMessage, AgentResponse, AdCampaignRecord, AdRuleRecord, OptimizationRecommendation } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import { CampaignOptimizer } from "@domien-sev/ads-sdk";
import { getClient, readItems } from "../lib/directus.js";
import { formatRecommendationsForSlack, handleApprovalResponse } from "./approval.js";
import { reply } from "../tools/reply.js";

/** Pending recommendations awaiting approval (in-memory, per agent instance) */
let pendingRecommendations: OptimizationRecommendation[] = [];

/**
 * Handler for rule-based optimization and approval flow.
 */
export async function handleOptimizeRules(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  // Handle approval/rejection of pending recommendations
  if (text.startsWith("approve") || text.startsWith("reject") || text.startsWith("snooze")) {
    if (pendingRecommendations.length === 0) {
      return reply(message, "No pending optimization recommendations. Run `rules` first.");
    }
    return handleApprovalResponse(
      agent,
      text,
      pendingRecommendations,
      message.channel_id,
      message.thread_ts ?? message.ts,
    );
  }

  // Show pending recommendations
  if (text.includes("status") && text.includes("rule")) {
    if (pendingRecommendations.length === 0) {
      return reply(message, "No pending recommendations. Run `rules` to trigger an optimization cycle.");
    }
    return await formatRecommendationsForSlack(
      pendingRecommendations,
      message.channel_id,
      message.thread_ts ?? message.ts,
    );
  }

  // Run optimization cycle via shared engine
  return runRulesCycle(agent, message);
}

async function runRulesCycle(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const optimizer = new CampaignOptimizer(agent.performanceCollector);
  const client = getClient(agent);

  const fetchCampaigns = async () =>
    client.request(
      readItems("ad_campaigns", {
        filter: {
          status: { _eq: "active" },
          platform: { _eq: "google" },
          platform_campaign_id: { _nnull: true },
        },
      }),
    ) as Promise<AdCampaignRecord[]>;

  const fetchRules = async () =>
    client.request(
      readItems("ad_rules", {
        filter: {
          enabled: { _eq: true },
          platform: { _in: ["google", "all"] },
        },
      }),
    ) as Promise<AdRuleRecord[]>;

  const result = await optimizer.runCycle(fetchCampaigns, fetchRules);

  // Store pending recommendations for approval flow
  pendingRecommendations = result.recommendations;

  // Build response
  const lines: string[] = [
    `*Google Ads Optimization Cycle Complete*`,
    `Campaigns analyzed: ${result.campaigns_analyzed} | Rules evaluated: ${result.rules_evaluated}`,
  ];

  if (result.errors.length > 0) {
    lines.push("");
    lines.push(`*Errors (${result.errors.length}):*`);
    for (const err of result.errors.slice(0, 5)) {
      lines.push(`- ${err.campaign}: ${err.error}`);
    }
  }

  if (result.fatigue_alerts.length > 0) {
    lines.push("");
    lines.push(`:warning: *Creative Fatigue (${result.fatigue_alerts.length}):*`);
    for (const alert of result.fatigue_alerts) {
      const actionLabels: Record<string, string> = {
        refresh_creative: "Generate new creatives",
        rotate_creative: "Rotate creative",
        pause_creative: "Pause creative",
        monitor: "Monitor",
      };
      lines.push(`- *${alert.campaign_name}* — Score: ${alert.fatigue_score}/100`);
      lines.push(`  CTR drop: ${Math.abs(alert.metrics.ctr_drop_pct).toFixed(0)}% | Recommended: ${actionLabels[alert.action] ?? alert.action}`);
    }
  }

  if (result.recommendations.length > 0) {
    const recResponse = await formatRecommendationsForSlack(
      result.recommendations,
      message.channel_id,
      message.thread_ts ?? message.ts,
      agent,
    );
    if (result.fatigue_alerts.length > 0 || result.errors.length > 0) {
      recResponse.text = lines.join("\n") + "\n\n" + recResponse.text;
    }
    return recResponse;
  }

  if (result.fatigue_alerts.length > 0) {
    return reply(message, lines.join("\n"));
  }

  lines.push("", "No actions needed — all campaigns performing within thresholds.");
  return reply(message, lines.join("\n"));
}

/** Get current pending recommendations */
export function getPendingRecommendations(): OptimizationRecommendation[] {
  return pendingRecommendations;
}

/** Set pending recommendations (for cron-triggered optimization) */
export function setPendingRecommendations(recs: OptimizationRecommendation[]): void {
  pendingRecommendations = recs;
}
