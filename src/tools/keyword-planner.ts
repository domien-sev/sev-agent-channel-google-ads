/**
 * Keyword research and planning helpers.
 * Uses GAQL queries to analyze existing keywords and suggest improvements.
 */
import type { GoogleAdsClient } from "@domien-sev/ads-sdk";
import type { KeywordMatchType } from "../types.js";

export interface KeywordSuggestion {
  text: string;
  matchType: KeywordMatchType;
  estimatedVolume?: number;
  competition?: "LOW" | "MEDIUM" | "HIGH";
  suggestedBid?: number;
  reason: string;
}

export interface NegativeKeywordCandidate {
  searchTerm: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  reason: string;
}

/** Minimum spend (€) with 0 conversions before flagging as negative candidate */
const NEGATIVE_SPEND_THRESHOLD = 5;
/** Minimum clicks with 0 conversions (+ min spend) before flagging */
const NEGATIVE_CLICK_THRESHOLD = 10;
/** Minimum spend (€) for click-based negative flagging */
const NEGATIVE_CLICK_MIN_SPEND = 2;

/**
 * Analyze search terms and find negative keyword candidates.
 * Looks for high-cost, low-conversion terms.
 */
export async function findNegativeCandidates(
  client: GoogleAdsClient,
  campaignId?: string,
  days: number = 30,
): Promise<NegativeKeywordCandidate[]> {
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];

  const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";

  const query = `
    SELECT
      search_term_view.search_term,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions
    FROM search_term_view
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      ${campaignFilter}
      AND metrics.clicks > 2
    ORDER BY metrics.cost_micros DESC
    LIMIT 500
  `;

  const results = await client.query(query) as Array<{ results?: Array<Record<string, any>> }>;
  const candidates: NegativeKeywordCandidate[] = [];

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      const cost = Number(row.metrics?.costMicros ?? 0) / 1_000_000;
      const conversions = Number(row.metrics?.conversions ?? 0);
      const clicks = Number(row.metrics?.clicks ?? 0);
      const impressions = Number(row.metrics?.impressions ?? 0);
      const searchTerm = String(row.searchTermView?.searchTerm ?? "");

      // Flag terms with spend but no conversions, or very low CTR
      if (cost > NEGATIVE_SPEND_THRESHOLD && conversions === 0) {
        candidates.push({
          searchTerm,
          impressions,
          clicks,
          cost,
          conversions,
          reason: `Spent €${cost.toFixed(2)} with 0 conversions`,
        });
      } else if (clicks > NEGATIVE_CLICK_THRESHOLD && conversions === 0 && cost > NEGATIVE_CLICK_MIN_SPEND) {
        candidates.push({
          searchTerm,
          impressions,
          clicks,
          cost,
          conversions,
          reason: `${clicks} clicks, 0 conversions`,
        });
      }
    }
  }

  return candidates.sort((a, b) => b.cost - a.cost);
}

/**
 * Add negative keywords to a campaign or ad group.
 */
export async function addNegativeKeywords(
  client: GoogleAdsClient,
  campaignResourceName: string,
  keywords: string[],
  level: "campaign" | "ad_group" = "campaign",
  adGroupResourceName?: string,
): Promise<number> {
  if (level === "campaign") {
    const ops = keywords.map((kw) => ({
      create: {
        campaign: campaignResourceName,
        negative: true,
        keyword: {
          text: kw,
          matchType: "PHRASE",
        },
      },
    }));
    const result = await (client as any).mutateResource("campaignCriteria", ops);
    return result.results.length;
  }

  if (!adGroupResourceName) {
    throw new Error("adGroupResourceName required for ad_group level negatives");
  }

  const ops = keywords.map((kw) => ({
    create: {
      adGroup: adGroupResourceName,
      negative: true,
      keyword: {
        text: kw,
        matchType: "PHRASE",
      },
    },
  }));
  const result = await (client as any).mutateResource("adGroupCriteria", ops);
  return result.results.length;
}

/**
 * Get quality score breakdown for keywords.
 */
export async function getQualityScoreBreakdown(
  client: GoogleAdsClient,
): Promise<{
  average: number;
  distribution: Record<number, number>;
  lowScoreKeywords: Array<{
    keyword: string;
    score: number;
    expectedCtr: string;
    adRelevance: string;
    landingPage: string;
    cost: number;
  }>;
}> {
  const query = `
    SELECT
      ad_group_criterion.keyword.text,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.quality_info.creative_quality_score,
      ad_group_criterion.quality_info.search_predicted_ctr,
      ad_group_criterion.quality_info.post_click_quality_score,
      metrics.cost_micros,
      metrics.impressions
    FROM keyword_view
    WHERE ad_group_criterion.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
      AND ad_group_criterion.quality_info.quality_score IS NOT NULL
    ORDER BY metrics.cost_micros DESC
    LIMIT 200
  `;

  const results = await client.query(query) as Array<{ results?: Array<Record<string, any>> }>;

  const distribution: Record<number, number> = {};
  const lowScoreKeywords: Array<{
    keyword: string;
    score: number;
    expectedCtr: string;
    adRelevance: string;
    landingPage: string;
    cost: number;
  }> = [];

  let totalScore = 0;
  let count = 0;

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      const score = Number(row.adGroupCriterion?.qualityInfo?.qualityScore ?? 0);
      const keyword = String(row.adGroupCriterion?.keyword?.text ?? "");
      const cost = Number(row.metrics?.costMicros ?? 0) / 1_000_000;

      distribution[score] = (distribution[score] ?? 0) + 1;
      totalScore += score;
      count++;

      if (score <= 5) {
        lowScoreKeywords.push({
          keyword,
          score,
          expectedCtr: String(row.adGroupCriterion?.qualityInfo?.searchPredictedCtr ?? "UNSPECIFIED"),
          adRelevance: String(row.adGroupCriterion?.qualityInfo?.creativeQualityScore ?? "UNSPECIFIED"),
          landingPage: String(row.adGroupCriterion?.qualityInfo?.postClickQualityScore ?? "UNSPECIFIED"),
          cost,
        });
      }
    }
  }

  return {
    average: count > 0 ? totalScore / count : 0,
    distribution,
    lowScoreKeywords: lowScoreKeywords.sort((a, b) => b.cost - a.cost).slice(0, 20),
  };
}
