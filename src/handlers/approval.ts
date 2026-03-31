/**
 * Optimization approval flow for Google Ads.
 * Handles approve/reject/snooze of pending optimization recommendations.
 * Executes approved actions via Google Ads API.
 */
import type { AgentResponse, OptimizationRecommendation, AdCampaignRecord, CreativeFatigueAlert } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import { requestGovernanceApproval, recordGovernanceDecision } from "@domien-sev/agent-sdk";
import { getClient, readItems, updateItem, createItem } from "../lib/directus.js";

/** Map recommendation IDs to Paperclip approval IDs for tracking */
const approvalMap = new Map<string, string>();

/**
 * Format optimization recommendations as Slack messages for human approval.
 */
export async function formatRecommendationsForSlack(
  recommendations: OptimizationRecommendation[],
  channelId: string,
  threadTs?: string,
  agent?: GoogleAdsAgent,
): Promise<AgentResponse> {
  if (recommendations.length === 0) {
    return {
      channel_id: channelId,
      thread_ts: threadTs,
      text: "Optimization cycle complete. No actions needed — all campaigns performing within thresholds.",
    };
  }

  const lines: string[] = [
    `*Google Ads Optimization — ${recommendations.length} action(s) pending approval:*`,
    "",
  ];

  for (const rec of recommendations) {
    const emoji = getActionEmoji(rec.action.type);
    const actionLabel = getActionLabel(rec);

    lines.push(`${emoji} *${rec.campaign_name}*`);
    lines.push(`   Action: ${actionLabel}`);
    lines.push(`   Reason: ${rec.reason}`);
    lines.push(`   Metrics (${rec.metrics.period_days}d): ROAS ${rec.metrics.current_roas.toFixed(2)} | CPA €${rec.metrics.current_cpa.toFixed(2)} | CTR ${rec.metrics.current_ctr.toFixed(2)}% | Spend €${rec.metrics.total_spend.toFixed(2)}`);
    if (rec.rule_name) {
      lines.push(`   Rule: ${rec.rule_name}`);
    }
    lines.push(`   ID: \`${rec.id}\``);
    lines.push("");
  }

  lines.push("─".repeat(40));
  lines.push("*Reply with:*");
  lines.push("`approve all` — Approve and execute all recommendations");
  lines.push("`approve <id>` — Approve a specific recommendation");
  lines.push("`reject all` — Reject all recommendations");
  lines.push("`reject <id>` — Reject a specific recommendation");
  lines.push("`snooze all` — Snooze all for next cycle");

  // Dual-write: create Paperclip approval records for audit trail
  if (agent) {
    for (const rec of recommendations) {
      const approvalId = await requestGovernanceApproval(agent, {
        type: rec.action.type === "scale_budget" ? "budget_change" : rec.action.type,
        description: `${rec.campaign_name}: ${getActionLabel(rec)}`,
        context: {
          recommendationId: rec.id,
          campaignId: rec.campaign_id,
          campaignName: rec.campaign_name,
          platform: rec.platform,
          action: rec.action,
          reason: rec.reason,
          metrics: rec.metrics,
        },
      });
      if (approvalId) {
        approvalMap.set(rec.id, approvalId);
      }
    }
  }

  return {
    channel_id: channelId,
    thread_ts: threadTs,
    text: lines.join("\n"),
  };
}

/**
 * Handle an approval/rejection response from Slack.
 */
export async function handleApprovalResponse(
  agent: GoogleAdsAgent,
  text: string,
  pendingRecommendations: OptimizationRecommendation[],
  channelId: string,
  threadTs?: string,
): Promise<AgentResponse> {
  const lower = text.trim().toLowerCase();

  if (lower === "approve all") {
    // Record governance decisions in Paperclip
    for (const rec of pendingRecommendations) {
      await recordGovernanceDecision(agent, approvalMap.get(rec.id) ?? null, "approved", { campaignName: rec.campaign_name });
    }
    return executeApprovedRecommendations(agent, pendingRecommendations, channelId, threadTs);
  }

  if (lower === "reject all") {
    for (const rec of pendingRecommendations) {
      rec.status = "rejected";
      await recordGovernanceDecision(agent, approvalMap.get(rec.id) ?? null, "rejected", { campaignName: rec.campaign_name });
    }
    await logDecisions(agent, pendingRecommendations, "rejected");
    return {
      channel_id: channelId,
      thread_ts: threadTs,
      text: `Rejected all ${pendingRecommendations.length} recommendation(s). No actions taken.`,
    };
  }

  if (lower === "snooze all") {
    for (const rec of pendingRecommendations) rec.status = "snoozed";
    await logDecisions(agent, pendingRecommendations, "snoozed");
    return {
      channel_id: channelId,
      thread_ts: threadTs,
      text: `Snoozed all ${pendingRecommendations.length} recommendation(s). Will re-evaluate next cycle.`,
    };
  }

  // Single approve
  const approveMatch = lower.match(/^approve\s+(.+)$/);
  if (approveMatch) {
    const id = approveMatch[1].trim();
    const rec = pendingRecommendations.find((r) => r.id === id);
    if (!rec) {
      return { channel_id: channelId, thread_ts: threadTs, text: `Recommendation \`${id}\` not found.` };
    }
    await recordGovernanceDecision(agent, approvalMap.get(id) ?? null, "approved", { campaignName: rec.campaign_name });
    return executeApprovedRecommendations(agent, [rec], channelId, threadTs);
  }

  // Single reject
  const rejectMatch = lower.match(/^reject\s+(.+)$/);
  if (rejectMatch) {
    const id = rejectMatch[1].trim();
    const rec = pendingRecommendations.find((r) => r.id === id);
    if (!rec) {
      return { channel_id: channelId, thread_ts: threadTs, text: `Recommendation \`${id}\` not found.` };
    }
    rec.status = "rejected";
    await recordGovernanceDecision(agent, approvalMap.get(id) ?? null, "rejected", { campaignName: rec.campaign_name });
    await logDecisions(agent, [rec], "rejected");
    return { channel_id: channelId, thread_ts: threadTs, text: `Rejected recommendation for "${rec.campaign_name}".` };
  }

  return {
    channel_id: channelId,
    thread_ts: threadTs,
    text: "Unknown command. Use `approve all`, `approve <id>`, `reject all`, `reject <id>`, or `snooze all`.",
  };
}

/**
 * Execute approved recommendations — actual Google Ads API calls.
 */
async function executeApprovedRecommendations(
  agent: GoogleAdsAgent,
  recommendations: OptimizationRecommendation[],
  channelId: string,
  threadTs?: string,
): Promise<AgentResponse> {
  const client = getClient(agent);
  const results: string[] = [];

  for (const rec of recommendations) {
    try {
      const campaign = (await client.request(
        readItems("ad_campaigns", { filter: { id: { _eq: rec.campaign_id } }, limit: 1 }),
      ) as AdCampaignRecord[])[0];

      if (!campaign) {
        results.push(`Campaign "${rec.campaign_name}" not found in Directus — skipped.`);
        rec.status = "failed";
        continue;
      }

      switch (rec.action.type) {
        case "pause": {
          // Pause via Google Ads API
          if (campaign.platform_campaign_id && agent.googleAds) {
            await agent.googleAds.pauseCampaign(campaign.platform_campaign_id);
          }
          await client.request(updateItem("ad_campaigns", campaign.id!, { status: "paused" }));
          results.push(`Paused "${campaign.name}" on Google Ads`);
          break;
        }

        case "scale_budget": {
          const newBudget = rec.action.params.proposed_budget as number;
          const oldBudget = campaign.daily_budget;

          // Update budget in Google Ads via GAQL
          if (campaign.platform_campaign_id && agent.googleAds) {
            try {
              await scaleBudgetOnGoogleAds(agent, campaign.platform_campaign_id, newBudget);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              results.push(`Budget update in Google Ads failed for "${campaign.name}": ${msg} — Directus updated only.`);
            }
          }

          await client.request(updateItem("ad_campaigns", campaign.id!, { daily_budget: newBudget }));
          results.push(`Scaled "${campaign.name}" budget: €${oldBudget.toFixed(2)} → €${newBudget.toFixed(2)}`);
          break;
        }

        case "archive": {
          await client.request(updateItem("ad_campaigns", campaign.id!, { status: "archived" }));
          results.push(`Archived "${campaign.name}"`);
          break;
        }

        case "alert": {
          results.push(`Alert noted for "${campaign.name}": ${rec.reason}`);
          break;
        }

        // Google Ads-specific actions
        case "adjust_keyword_bid": {
          if (agent.googleAds) {
            try {
              const keywordResource = rec.action.params.keyword_resource as string;
              const newBidMicros = rec.action.params.new_bid_micros as number;
              await agent.googleAds.mutateResource("adGroupCriteria", [{
                update: {
                  resourceName: keywordResource,
                  cpcBidMicros: String(newBidMicros),
                },
                updateMask: "cpc_bid_micros",
              }]);
              const newBidEuros = newBidMicros / 1_000_000;
              results.push(`Adjusted keyword bid in "${campaign.name}": €${newBidEuros.toFixed(2)}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              results.push(`Failed to adjust keyword bid in "${campaign.name}": ${msg}`);
            }
          }
          break;
        }

        case "add_negative_keyword": {
          if (agent.googleAds) {
            try {
              const searchTerm = rec.action.params.search_term as string;
              const campaignResource = campaign.platform_campaign_id;
              await agent.googleAds.mutateResource("campaignCriteria", [{
                create: {
                  campaign: campaignResource,
                  keyword: {
                    text: searchTerm,
                    matchType: "EXACT",
                  },
                  negative: true,
                },
              }]);
              results.push(`Added negative keyword "${searchTerm}" to "${campaign.name}"`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              results.push(`Failed to add negative keyword to "${campaign.name}": ${msg}`);
            }
          }
          break;
        }

        case "pause_ad": {
          if (agent.googleAds) {
            try {
              const adResource = rec.action.params.ad_resource as string;
              await agent.googleAds.mutateResource("adGroupAds", [{
                update: {
                  resourceName: adResource,
                  status: "PAUSED",
                },
                updateMask: "status",
              }]);
              results.push(`Paused ad in "${campaign.name}"`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              results.push(`Failed to pause ad in "${campaign.name}": ${msg}`);
            }
          }
          break;
        }

        case "adjust_bid_modifier": {
          if (agent.googleAds) {
            try {
              const criterionResource = rec.action.params.criterion_resource as string;
              const modifier = rec.action.params.bid_modifier as number;
              await agent.googleAds.mutateResource("campaignBidModifiers", [{
                update: {
                  resourceName: criterionResource,
                  bidModifier: modifier,
                },
                updateMask: "bid_modifier",
              }]);
              results.push(`Adjusted bid modifier in "${campaign.name}" to ${modifier.toFixed(2)}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              results.push(`Failed to adjust bid modifier in "${campaign.name}": ${msg}`);
            }
          }
          break;
        }
      }

      rec.status = "executed";
      rec.decided_at = new Date().toISOString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`Failed to execute for "${rec.campaign_name}": ${msg}`);
      rec.status = "failed";
    }
  }

  await logDecisions(agent, recommendations, "executed");

  return {
    channel_id: channelId,
    thread_ts: threadTs,
    text: [
      `*Executed ${results.length} optimization action(s):*`,
      "",
      ...results.map((r) => `- ${r}`),
    ].join("\n"),
  };
}

/**
 * Scale campaign budget on Google Ads.
 * Reads the campaign's budget resource name, then mutates the budget amount.
 */
async function scaleBudgetOnGoogleAds(
  agent: GoogleAdsAgent,
  platformCampaignId: string,
  newBudgetEuros: number,
): Promise<void> {
  // Get the budget resource name from the campaign
  const query = `
    SELECT campaign.campaign_budget
    FROM campaign
    WHERE campaign.resource_name = '${platformCampaignId}'
    LIMIT 1
  `;

  const results = await agent.googleAds.query(query) as Array<{
    results?: Array<{ campaign?: { campaignBudget?: string } }>;
  }>;

  const budgetResourceName = results[0]?.results?.[0]?.campaign?.campaignBudget;
  if (!budgetResourceName) {
    throw new Error("Could not find campaign budget resource");
  }

  // Update the budget
  await agent.googleAds.mutateResource("campaignBudgets", [{
    update: {
      resourceName: budgetResourceName,
      amountMicros: String(Math.round(newBudgetEuros * 1_000_000)),
    },
    updateMask: "amount_micros",
  }]);
}

/** Format creative fatigue alerts as a Slack message */
export function formatFatigueAlerts(alerts: CreativeFatigueAlert[]): string {
  const actionEmoji: Record<string, string> = {
    refresh_creative: ":art:",
    rotate_creative: ":arrows_counterclockwise:",
    pause_creative: ":no_entry_sign:",
    monitor: ":eyes:",
  };

  const actionLabels: Record<string, string> = {
    refresh_creative: "Generate new creatives",
    rotate_creative: "Rotate to different creative",
    pause_creative: "Pause this creative",
    monitor: "Keep monitoring",
  };

  const lines: string[] = [
    `:warning: *Google Ads Creative Fatigue — ${alerts.length} creative(s) showing fatigue:*`,
    "",
  ];

  for (const alert of alerts) {
    const emoji = actionEmoji[alert.action] ?? ":gear:";
    lines.push(`${emoji} *${alert.campaign_name}* — Score: ${alert.fatigue_score}/100`);
    lines.push(`   ${alert.reason}`);
    lines.push(`   Recommended: ${actionLabels[alert.action] ?? alert.action}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Log optimization decisions to Directus agent_events */
async function logDecisions(
  agent: GoogleAdsAgent,
  recommendations: OptimizationRecommendation[],
  decision: string,
): Promise<void> {
  const client = getClient(agent);
  try {
    for (const rec of recommendations) {
      await client.request(
        createItem("agent_events", {
          agent: "google-ads",
          type: `optimization_${decision}`,
          data: {
            recommendation_id: rec.id,
            campaign_id: rec.campaign_id,
            campaign_name: rec.campaign_name,
            platform: rec.platform,
            action: rec.action,
            reason: rec.reason,
            metrics: rec.metrics,
            previous_state: rec.previous_state,
            rule_name: rec.rule_name,
          },
        }),
      );
    }
  } catch (err) {
    agent.log.error(`Failed to log optimization decisions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getActionEmoji(actionType: string): string {
  switch (actionType) {
    case "pause": return ":pause_button:";
    case "scale_budget": return ":chart_with_upwards_trend:";
    case "archive": return ":file_cabinet:";
    case "alert": return ":warning:";
    case "adjust_keyword_bid": return ":dart:";
    case "add_negative_keyword": return ":no_entry:";
    case "pause_ad": return ":pause_button:";
    case "adjust_bid_modifier": return ":control_knobs:";
    default: return ":gear:";
  }
}

function getActionLabel(rec: OptimizationRecommendation): string {
  switch (rec.action.type) {
    case "pause":
      return "Pause campaign";
    case "scale_budget": {
      const oldBudget = rec.action.params.original_budget as number;
      const newBudget = rec.action.params.proposed_budget as number;
      const direction = newBudget > oldBudget ? "Increase" : "Decrease";
      const pct = oldBudget > 0 ? Math.abs(((newBudget - oldBudget) / oldBudget) * 100).toFixed(0) : "?";
      return `${direction} budget €${oldBudget?.toFixed(2)} → €${newBudget?.toFixed(2)} (${pct}%)`;
    }
    case "archive":
      return "Archive campaign";
    case "alert": {
      const blockedReason = rec.action.params.blocked_reason as string | undefined;
      return blockedReason ? `Alert (budget change blocked: ${blockedReason})` : "Alert";
    }
    case "adjust_keyword_bid": {
      const newBid = (rec.action.params.new_bid_micros as number) / 1_000_000;
      return `Adjust keyword bid → €${newBid.toFixed(2)}`;
    }
    case "add_negative_keyword": {
      const term = rec.action.params.search_term as string;
      return `Add negative keyword: "${term}"`;
    }
    case "pause_ad":
      return "Pause underperforming ad";
    case "adjust_bid_modifier": {
      const mod = rec.action.params.bid_modifier as number;
      return `Adjust bid modifier → ${(mod * 100).toFixed(0)}%`;
    }
    default:
      return rec.action.type;
  }
}
