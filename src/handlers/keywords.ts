import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import * as gaql from "../tools/gaql.js";
import { findNegativeCandidates, addNegativeKeywords, getQualityScoreBreakdown } from "../tools/keyword-planner.js";
import { syncKeywords, syncSearchTerms } from "../tools/directus-sync.js";
import { reply } from "../tools/reply.js";

/**
 * Keywords handler — research, bid management, negatives, search term analysis.
 *
 * Commands:
 *   "keywords for [topic]" — Keyword performance overview
 *   "keyword report" — Quality score + performance report
 *   "add negatives [terms]" — Add negative keywords
 *   "search terms [campaign]" — Search term report
 */
export async function handleKeywords(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim().toLowerCase();

  if (text.startsWith("add negative")) {
    return handleAddNegatives(agent, message);
  }

  if (text.startsWith("search term")) {
    return handleSearchTerms(agent, message);
  }

  if (text.includes("keyword report") || text.includes("quality score")) {
    return handleKeywordReport(agent, message);
  }

  // Default: keyword overview
  return handleKeywordOverview(agent, message);
}

async function handleKeywordOverview(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const query = gaql.keywordPerformance();
  const results = await agent.googleAds.query(query) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  const keywords: Array<{
    keyword: string;
    matchType: string;
    qs: number;
    impressions: number;
    clicks: number;
    cost: number;
    conversions: number;
    cpc: number;
  }> = [];

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      keywords.push({
        keyword: String(row.adGroupCriterion?.keyword?.text ?? ""),
        matchType: String(row.adGroupCriterion?.keyword?.matchType ?? "BROAD"),
        qs: Number(row.adGroupCriterion?.qualityInfo?.qualityScore ?? 0),
        impressions: Number(row.metrics?.impressions ?? 0),
        clicks: Number(row.metrics?.clicks ?? 0),
        cost: Number(row.metrics?.costMicros ?? 0) / 1_000_000,
        conversions: Number(row.metrics?.conversions ?? 0),
        cpc: Number(row.metrics?.averageCpc ?? 0) / 1_000_000,
      });
    }
  }

  if (keywords.length === 0) {
    return reply(message, "No keywords found. Your campaigns may not have search keywords (e.g., Shopping or PMax only).");
  }

  const totalCost = keywords.reduce((s, k) => s + k.cost, 0);
  const totalConv = keywords.reduce((s, k) => s + k.conversions, 0);
  const avgQS = keywords.filter((k) => k.qs > 0).reduce((s, k) => s + k.qs, 0) /
    (keywords.filter((k) => k.qs > 0).length || 1);

  const lines: string[] = [
    `*Keyword Overview (last 30 days) — ${keywords.length} keywords*`,
    "",
    `*Total:* €${totalCost.toFixed(2)} spend | ${totalConv.toFixed(0)} conversions | Avg QS: ${avgQS.toFixed(1)}`,
    "",
    "*Top keywords by spend:*",
  ];

  for (const kw of keywords.slice(0, 15)) {
    const qsLabel = kw.qs > 0 ? ` QS:${kw.qs}` : "";
    lines.push(
      `  \`${kw.keyword}\` [${formatMatchType(kw.matchType)}]${qsLabel} — €${kw.cost.toFixed(2)} | ${kw.clicks} clicks | ${kw.conversions.toFixed(1)} conv | CPC €${kw.cpc.toFixed(2)}`,
    );
  }

  // Sync to Directus in background
  syncKeywords(agent.googleAds, agent.directus).catch((err) =>
    agent.log.warn(`Keyword sync failed: ${err instanceof Error ? err.message : String(err)}`),
  );

  return reply(message, lines.join("\n"));
}

async function handleKeywordReport(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const breakdown = await getQualityScoreBreakdown(agent.googleAds);

  const lines: string[] = [
    `*Quality Score Report*`,
    "",
    `*Average Quality Score:* ${breakdown.average.toFixed(1)}/10`,
    "",
    "*Distribution:*",
  ];

  for (let qs = 1; qs <= 10; qs++) {
    const count = breakdown.distribution[qs] ?? 0;
    if (count > 0) {
      const bar = "█".repeat(Math.min(20, Math.round(count / 2)));
      lines.push(`  QS ${qs}: ${bar} ${count}`);
    }
  }

  if (breakdown.lowScoreKeywords.length > 0) {
    lines.push("", "*Low Quality Score Keywords (QS ≤ 5):*");
    for (const kw of breakdown.lowScoreKeywords.slice(0, 10)) {
      lines.push(
        `  \`${kw.keyword}\` QS:${kw.score} — CTR: ${kw.expectedCtr}, Relevance: ${kw.adRelevance}, Landing: ${kw.landingPage} (€${kw.cost.toFixed(2)} spend)`,
      );
    }
  }

  return reply(message, lines.join("\n"));
}

async function handleSearchTerms(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  // Find negative keyword candidates
  const candidates = await findNegativeCandidates(agent.googleAds);

  const query = gaql.searchTermReport();
  const results = await agent.googleAds.query(query) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  const terms: Array<{
    term: string;
    impressions: number;
    clicks: number;
    cost: number;
    conversions: number;
  }> = [];

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      terms.push({
        term: String(row.searchTermView?.searchTerm ?? ""),
        impressions: Number(row.metrics?.impressions ?? 0),
        clicks: Number(row.metrics?.clicks ?? 0),
        cost: Number(row.metrics?.costMicros ?? 0) / 1_000_000,
        conversions: Number(row.metrics?.conversions ?? 0),
      });
    }
  }

  const lines: string[] = [
    `*Search Term Report (last 30 days) — ${terms.length} terms*`,
    "",
    "*Top search terms:*",
  ];

  for (const t of terms.slice(0, 15)) {
    lines.push(
      `  "${t.term}" — ${t.impressions} imp | ${t.clicks} clicks | €${t.cost.toFixed(2)} | ${t.conversions.toFixed(1)} conv`,
    );
  }

  if (candidates.length > 0) {
    lines.push("", `*Negative Keyword Candidates (${candidates.length}):*`);
    for (const c of candidates.slice(0, 10)) {
      lines.push(`  "${c.searchTerm}" — ${c.reason}`);
    }
    lines.push("", '_Use `add negatives [term1], [term2]` to add them._');
  }

  // Sync to Directus in background
  syncSearchTerms(agent.googleAds, agent.directus).catch((err) =>
    agent.log.warn(`Search term sync failed: ${err instanceof Error ? err.message : String(err)}`),
  );

  return reply(message, lines.join("\n"));
}

async function handleAddNegatives(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  // Parse negative keywords from message
  const text = message.text.trim();
  const afterCommand = text.replace(/^add\s+negatives?\s*/i, "").trim();

  if (!afterCommand) {
    return reply(message, 'Usage: `add negatives [term1], [term2], ...`\nOr run `search terms` first to see candidates.');
  }

  const terms = afterCommand.split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

  if (terms.length === 0) {
    return reply(message, "No keywords found. Separate multiple keywords with commas.");
  }

  // Get first enabled campaign to add negatives to
  const campaignQuery = `
    SELECT campaign.resource_name, campaign.name
    FROM campaign
    WHERE campaign.status = 'ENABLED'
    LIMIT 1
  `;

  const campaignResults = await agent.googleAds.query(campaignQuery) as Array<{
    results?: Array<Record<string, Record<string, string>>>;
  }>;

  const campaignRn = campaignResults[0]?.results?.[0]?.campaign?.resourceName;
  if (!campaignRn) {
    return reply(message, "No enabled campaigns found to add negatives to.");
  }

  const added = await addNegativeKeywords(agent.googleAds, campaignRn, terms);

  return reply(message, `Added ${added} negative keywords: ${terms.map((t) => `"${t}"`).join(", ")}`);
}

function formatMatchType(type: string): string {
  const map: Record<string, string> = {
    EXACT: "Exact",
    PHRASE: "Phrase",
    BROAD: "Broad",
  };
  return map[type] ?? type;
}
