import cron from "node-cron";
import type { GoogleAdsAgent } from "./agent.js";
import type { AdCampaignRecord, AdRuleRecord, CreativeFatigueAlert } from "@domien-sev/shared-types";
import { CampaignOptimizer } from "@domien-sev/ads-sdk";
import { getClient, readItems, createItem } from "./lib/directus.js";
import { formatRecommendationsForSlack, formatFatigueAlerts } from "./handlers/approval.js";
import { setPendingRecommendations } from "./handlers/optimize-rules.js";
import { runAudit, formatAuditForSlack } from "./handlers/audit.js";
import { slackPost, isSlackConfigured } from "./tools/slack.js";
import { syncKeywords, syncSearchTerms, syncAssetGroups } from "./tools/directus-sync.js";
import { syncPerformanceScores } from "./tools/performance-sync.js";

let optimizeTask: cron.ScheduledTask | null = null;
let alertsTask: cron.ScheduledTask | null = null;
let syncTask: cron.ScheduledTask | null = null;
let perfSyncTask: cron.ScheduledTask | null = null;
let auditTask: cron.ScheduledTask | null = null;

/**
 * Initialize the optimization scheduler.
 *
 * Three cron jobs:
 * 1. Optimization cycle — hourly (OPTIMIZE_CRON env var)
 * 2. Daily alerts — 8 AM Brussels (ALERTS_CRON env var)
 * 3. Data sync — every 6 hours (SYNC_CRON env var) — keywords, search terms, asset groups → Directus
 */
export function initScheduler(agent: GoogleAdsAgent): void {
  initOptimizationCron(agent);
  initAlertsCron(agent);
  initSyncCron(agent);
  initPerfSyncCron(agent);
  initAuditCron(agent);
}

function initOptimizationCron(agent: GoogleAdsAgent): void {
  const cronExpr = process.env.OPTIMIZE_CRON ?? "0 * * * *";

  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] Invalid OPTIMIZE_CRON: "${cronExpr}" — falling back to hourly`);
    return startOptimizationCron(agent, "0 * * * *");
  }

  startOptimizationCron(agent, cronExpr);
}

function startOptimizationCron(agent: GoogleAdsAgent, cronExpr: string): void {
  optimizeTask = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Running optimization cycle at ${new Date().toISOString()}`);
    try {
      await runOptimizationCycle(agent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Optimization cycle failed: ${msg}`);
    }
  }, {
    timezone: "Europe/Brussels",
  });

  const nextRun = estimateNextRun(cronExpr);
  console.log(`[scheduler] Optimization scheduled: "${cronExpr}"`);
  console.log(`[scheduler] Next optimization run: ${nextRun}`);
}

function initAlertsCron(agent: GoogleAdsAgent): void {
  const cronExpr = process.env.ALERTS_CRON ?? "0 8 * * *";

  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] Invalid ALERTS_CRON: "${cronExpr}" — falling back to 8 AM daily`);
    return startAlertsCron(agent, "0 8 * * *");
  }

  startAlertsCron(agent, cronExpr);
}

function startAlertsCron(agent: GoogleAdsAgent, cronExpr: string): void {
  alertsTask = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Running daily alerts at ${new Date().toISOString()}`);
    try {
      await runDailyAlerts(agent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Daily alerts failed: ${msg}`);
    }
  }, {
    timezone: "Europe/Brussels",
  });

  console.log(`[scheduler] Daily alerts scheduled: "${cronExpr}"`);
}

function initSyncCron(agent: GoogleAdsAgent): void {
  const cronExpr = process.env.SYNC_CRON ?? "0 */6 * * *"; // every 6 hours

  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] Invalid SYNC_CRON: "${cronExpr}" — falling back to every 6 hours`);
    return startSyncCron(agent, "0 */6 * * *");
  }

  startSyncCron(agent, cronExpr);
}

function startSyncCron(agent: GoogleAdsAgent, cronExpr: string): void {
  syncTask = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Running data sync at ${new Date().toISOString()}`);
    try {
      await runDataSync(agent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Data sync failed: ${msg}`);
    }
  }, {
    timezone: "Europe/Brussels",
  });

  console.log(`[scheduler] Data sync scheduled: "${cronExpr}"`);
}

function initPerfSyncCron(agent: GoogleAdsAgent): void {
  const cronExpr = process.env.PERF_SYNC_CRON ?? "0 6 * * 1"; // Monday 6 AM

  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] Invalid PERF_SYNC_CRON: "${cronExpr}" — falling back to Monday 6 AM`);
    return startPerfSyncCron(agent, "0 6 * * 1");
  }

  startPerfSyncCron(agent, cronExpr);
}

function startPerfSyncCron(agent: GoogleAdsAgent, cronExpr: string): void {
  perfSyncTask = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Running performance score sync at ${new Date().toISOString()}`);
    try {
      await runPerfSync(agent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Performance sync failed: ${msg}`);
    }
  }, {
    timezone: "Europe/Brussels",
  });

  console.log(`[scheduler] Performance score sync scheduled: "${cronExpr}"`);
}

// ─── Weekly Audit ────────────────────────────────────────────────────────────

function initAuditCron(agent: GoogleAdsAgent): void {
  const cronExpr = process.env.AUDIT_CRON ?? "0 9 * * 1"; // Monday 9 AM Brussels

  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] Invalid AUDIT_CRON: "${cronExpr}" — falling back to Monday 9 AM`);
    return startAuditCron(agent, "0 9 * * 1");
  }

  startAuditCron(agent, cronExpr);
}

function startAuditCron(agent: GoogleAdsAgent, cronExpr: string): void {
  auditTask = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Running weekly audit at ${new Date().toISOString()}`);
    try {
      await runWeeklyAudit(agent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Weekly audit failed: ${msg}`);
    }
  }, {
    timezone: "Europe/Brussels",
  });

  console.log(`[scheduler] Weekly audit scheduled: "${cronExpr}"`);
}

export async function runWeeklyAudit(agent: GoogleAdsAgent): Promise<void> {
  if (!agent.googleAds) {
    console.log("[scheduler] Google Ads client not configured — skipping audit");
    return;
  }

  const result = await runAudit(agent.googleAds);
  const slackMsg = formatAuditForSlack(result);
  await postToSlack(agent, slackMsg);

  // Log to Directus
  const client = getClient(agent);
  try {
    await client.request(
      createItem("agent_events", {
        agent: "google-ads",
        type: "weekly_audit",
        data: {
          date: result.date,
          score: result.overallScore,
          grade: result.overallGrade,
          categories: result.categories.map((c) => ({
            name: c.name, score: c.score, grade: c.grade,
          })),
          critical_count: result.critical.length,
          high_count: result.high.length,
        },
      }),
    );
  } catch {
    console.error("[scheduler] Failed to log audit to Directus");
  }

  console.log(`[scheduler] Weekly audit posted — score: ${result.overallScore}/100 (${result.overallGrade})`);
}

// ─── Performance Sync ────────────────────────────────────────────────────────

export async function runPerfSync(agent: GoogleAdsAgent): Promise<void> {
  if (!agent.googleAds) {
    console.log("[scheduler] Google Ads client not configured — skipping perf sync");
    return;
  }

  const result = await syncPerformanceScores(agent.googleAds);

  if (result.updated > 0) {
    await postToSlack(
      agent,
      `:bar_chart: *Ad Copy Library — Performance Scores Updated*\n` +
      `Matched: ${result.matched}/${result.total} entries | Updated: ${result.updated} scores`,
    );
  }
}

/**
 * Run the optimization cycle:
 * 1. Collect performance data across Google Ads campaigns in Directus
 * 2. Evaluate rules against campaign metrics
 * 3. Generate recommendations
 * 4. Post to Slack for approval
 */
async function runOptimizationCycle(agent: GoogleAdsAgent): Promise<void> {
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

  // Log cycle to agent_events
  try {
    await client.request(
      createItem("agent_events", {
        agent: "google-ads",
        type: "optimization_cycle",
        data: {
          timestamp: result.timestamp,
          campaigns_analyzed: result.campaigns_analyzed,
          rules_evaluated: result.rules_evaluated,
          recommendations_count: result.recommendations.length,
          fatigue_alerts_count: result.fatigue_alerts.length,
          errors_count: result.errors.length,
        },
      }),
    );
  } catch {
    console.error("[scheduler] Failed to log optimization cycle to Directus");
  }

  for (const err of result.errors) {
    console.warn(`[scheduler] Rule error: ${err.campaign} — ${err.error}`);
  }

  // Post fatigue alerts
  if (result.fatigue_alerts.length > 0) {
    const fatigueMsg = formatFatigueAlerts(result.fatigue_alerts);
    await postToSlack(agent, fatigueMsg);
    console.log(`[scheduler] Posted ${result.fatigue_alerts.length} fatigue alert(s)`);
  }

  if (result.recommendations.length === 0 && result.fatigue_alerts.length === 0) {
    console.log(`[scheduler] No recommendations or fatigue alerts — ${result.campaigns_analyzed} campaigns within thresholds.`);
    return;
  }

  if (result.recommendations.length > 0) {
    setPendingRecommendations(result.recommendations);

    const channelId = process.env.GOOGLE_ADS_CHANNEL ?? "agent-google-ads";
    const slackMsg = await formatRecommendationsForSlack(result.recommendations, channelId, undefined, agent);
    await postToSlack(agent, slackMsg.text ?? "Optimization recommendations pending.");
    console.log(`[scheduler] Posted ${result.recommendations.length} recommendation(s)`);
  }
}

/**
 * Daily alerts — summarizes account health, quality score issues, wasted spend.
 */
export async function runDailyAlerts(agent: GoogleAdsAgent): Promise<void> {
  if (!agent.googleAds) {
    console.log("[scheduler] Google Ads client not configured — skipping daily alerts");
    return;
  }

  try {
    // Quick account-level summary via GAQL
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];

    const query = `
      SELECT
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value
      FROM customer
      WHERE segments.date = '${startDate}'
    `;

    const results = await agent.googleAds.query(query) as Array<{
      results?: Array<Record<string, Record<string, string | number>>>;
    }>;

    const row = results[0]?.results?.[0];
    if (!row) return;

    const cost = Number(row.metrics?.costMicros ?? 0) / 1_000_000;
    const revenue = Number(row.metrics?.conversionsValue ?? 0);
    const impressions = Number(row.metrics?.impressions ?? 0);
    const clicks = Number(row.metrics?.clicks ?? 0);
    const conversions = Number(row.metrics?.conversions ?? 0);
    const roas = cost > 0 ? revenue / cost : 0;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;

    const lines: string[] = [
      `:chart_with_upwards_trend: *Google Ads Daily Summary — ${startDate}*`,
      "",
      `Spend: €${cost.toFixed(2)} | Revenue: €${revenue.toFixed(2)} | ROAS: ${roas.toFixed(2)}x`,
      `Impressions: ${impressions.toLocaleString()} | Clicks: ${clicks.toLocaleString()} | CTR: ${ctr.toFixed(2)}%`,
      `Conversions: ${conversions.toFixed(1)}`,
    ];

    if (roas < 1 && cost > 10) {
      lines.push("");
      lines.push(":warning: ROAS below 1.0x — check campaign performance.");
    }

    await postToSlack(agent, lines.join("\n"));
    console.log("[scheduler] Daily alert posted");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] Daily alerts error: ${msg}`);
  }
}

/**
 * Sync Google Ads data to Directus — keywords, search terms, asset groups.
 */
export async function runDataSync(agent: GoogleAdsAgent): Promise<void> {
  if (!agent.googleAds || !agent.directus) {
    console.log("[scheduler] Google Ads or Directus not configured — skipping sync");
    return;
  }

  try {
    const [keywords, searchTerms, assetGroups] = await Promise.allSettled([
      syncKeywords(agent.googleAds, agent.directus),
      syncSearchTerms(agent.googleAds, agent.directus),
      syncAssetGroups(agent.googleAds, agent.directus),
    ]);

    const kwCount = keywords.status === "fulfilled" ? keywords.value : 0;
    const stCount = searchTerms.status === "fulfilled" ? searchTerms.value : 0;
    const agCount = assetGroups.status === "fulfilled" ? assetGroups.value : 0;

    console.log(`[scheduler] Data sync complete: ${kwCount} keywords, ${stCount} search terms, ${agCount} asset groups`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] Data sync error: ${msg}`);
  }
}

/**
 * Post a message to Slack.
 * Uses direct Slack API if configured, falls back to Directus agent_events.
 */
async function postToSlack(agent: GoogleAdsAgent, text: string): Promise<void> {
  const channelId = process.env.GOOGLE_ADS_CHANNEL ?? "agent-google-ads";

  if (isSlackConfigured()) {
    try {
      await slackPost(channelId, { text });
      return;
    } catch {
      // Fall through to Directus
    }
  }

  // Fallback: log to agent_events
  const client = getClient(agent);
  try {
    await client.request(
      createItem("agent_events", {
        agent: "google-ads",
        type: "slack_message",
        data: { channel_id: channelId, text },
      }),
    );
  } catch (err) {
    console.error(`[scheduler] Failed to post to Slack: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Run optimization cycle on demand (HTTP trigger).
 */
export async function runOptimizationCycleHttp(agent: GoogleAdsAgent) {
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

  if (result.recommendations.length > 0) {
    setPendingRecommendations(result.recommendations);
  }

  return { ok: true, ...result };
}

/** Stop all cron jobs for graceful shutdown */
export function stopScheduler(): void {
  if (optimizeTask) {
    optimizeTask.stop();
    optimizeTask = null;
    console.log("[scheduler] Optimization cron stopped");
  }
  if (alertsTask) {
    alertsTask.stop();
    alertsTask = null;
    console.log("[scheduler] Alerts cron stopped");
  }
  if (syncTask) {
    syncTask.stop();
    syncTask = null;
    console.log("[scheduler] Sync cron stopped");
  }
  if (perfSyncTask) {
    perfSyncTask.stop();
    perfSyncTask = null;
    console.log("[scheduler] Performance sync cron stopped");
  }
  if (auditTask) {
    auditTask.stop();
    auditTask = null;
    console.log("[scheduler] Audit cron stopped");
  }
}

function estimateNextRun(expression: string): string {
  const parts = expression.split(" ");
  if (parts.length < 5) return "unknown";

  const minute = parseInt(parts[0], 10);
  const hour = parseInt(parts[1], 10);

  if (parts[1] === "*") {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(isNaN(minute) ? 0 : minute, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next.toISOString();
  }

  if (isNaN(minute) || isNaN(hour)) return "unknown (complex expression)";

  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}
