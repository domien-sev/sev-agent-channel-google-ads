/**
 * Weekly sync: calculate performance_score for ad_copy_library entries
 * based on actual Google Ads metrics (last 30 days).
 *
 * Matching: ad_copy_library entries → Google Ads RSA ads via headline overlap.
 * Score: composite of ROAS, CTR, conversion rate, and statistical confidence.
 */

import type { GoogleAdsClient } from "@domien-sev/ads-sdk";

const DIRECTUS_URL = process.env.DIRECTUS_URL ?? "https://ops.shoppingeventvip.be";
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN ?? "";

interface AdCopyRecord {
  id: string;
  campaign_name: string;
  headlines: string[];
  performance_score: number | null;
}

interface AdMetrics {
  campaignName: string;
  headlines: string[];
  impressions: number;
  clicks: number;
  conversions: number;
  costMicros: number;
  conversionsValue: number;
}

/**
 * Fetch ad-level performance from Google Ads (last 30 days).
 */
async function fetchAdPerformance(googleAds: GoogleAdsClient): Promise<AdMetrics[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const startDate = start.toISOString().split("T")[0];
  const endDate = end.toISOString().split("T")[0];

  const query = `
    SELECT
      campaign.name,
      ad_group_ad.ad.responsive_search_ad.headlines,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.cost_micros,
      metrics.conversions_value
    FROM ad_group_ad
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
      AND ad_group_ad.status != 'REMOVED'
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.impressions DESC
  `.trim();

  const results = await googleAds.query(query) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  const ads: AdMetrics[] = [];
  for (const batch of results) {
    if (!batch.results) continue;
    for (const row of batch.results) {
      const headlineAssets = row.adGroupAd?.ad?.responsiveSearchAd?.headlines ?? [];
      const headlines = headlineAssets.map((h: any) => h.text ?? h.asset_text ?? "").filter(Boolean);

      ads.push({
        campaignName: row.campaign?.name ?? "",
        headlines,
        impressions: Number(row.metrics?.impressions ?? 0),
        clicks: Number(row.metrics?.clicks ?? 0),
        conversions: Number(row.metrics?.conversions ?? 0),
        costMicros: Number(row.metrics?.costMicros ?? 0),
        conversionsValue: Number(row.metrics?.conversionsValue ?? 0),
      });
    }
  }

  return ads;
}

/**
 * Fetch all ad_copy_library entries from Directus.
 */
async function fetchAdCopyLibrary(): Promise<AdCopyRecord[]> {
  const res = await fetch(
    `${DIRECTUS_URL}/items/ad_copy_library?fields=id,campaign_name,headlines,performance_score&filter[status][_eq]=active&limit=-1`,
    { headers: { Authorization: `Bearer ${DIRECTUS_TOKEN}` } },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch ad_copy_library: ${res.status}`);
  }

  const data = await res.json() as { data: AdCopyRecord[] };
  return data.data;
}

/**
 * Match an ad_copy_library entry to Google Ads metrics by headline overlap.
 * Returns the best matching ad's metrics, or null if no match.
 */
function matchAdToMetrics(entry: AdCopyRecord, adsMetrics: AdMetrics[]): AdMetrics | null {
  const entryHeadlines = new Set(
    (entry.headlines ?? []).map((h: string) => h.toLowerCase().trim()),
  );

  if (entryHeadlines.size === 0) return null;

  let bestMatch: AdMetrics | null = null;
  let bestOverlap = 0;

  for (const ad of adsMetrics) {
    const adHeadlines = new Set(ad.headlines.map(h => h.toLowerCase().trim()));
    let overlap = 0;
    for (const h of entryHeadlines) {
      if (adHeadlines.has(h)) overlap++;
    }

    // Require at least 2 matching headlines or 50% overlap
    const overlapRatio = entryHeadlines.size > 0 ? overlap / entryHeadlines.size : 0;
    if (overlap >= 2 || overlapRatio >= 0.5) {
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestMatch = ad;
      }
    }
  }

  return bestMatch;
}

/**
 * Calculate a composite performance score (0-100) from ad metrics.
 *
 * Components:
 * - ROAS score (35%): relative to target ROAS of 2.0
 * - CTR score (25%): relative to 2% benchmark
 * - Conversion rate score (20%): relative to 3% benchmark
 * - Confidence score (20%): based on impressions volume
 */
function calculateScore(metrics: AdMetrics): number {
  const spend = metrics.costMicros / 1_000_000;
  const roas = spend > 0 ? metrics.conversionsValue / spend : 0;
  const ctr = metrics.impressions > 0 ? (metrics.clicks / metrics.impressions) * 100 : 0;
  const convRate = metrics.clicks > 0 ? (metrics.conversions / metrics.clicks) * 100 : 0;

  // ROAS score: 0 at 0, 50 at target (2.0), 100 at 2x target, capped at 100
  const roasScore = Math.min(100, (roas / 2.0) * 50);

  // CTR score: benchmark 2% = 50 points, 4% = 100, capped
  const ctrScore = Math.min(100, (ctr / 2.0) * 50);

  // Conversion rate score: benchmark 3% = 50 points
  const convScore = Math.min(100, (convRate / 3.0) * 50);

  // Confidence: <500 impressions = low confidence, 5000+ = full confidence
  const confidence = Math.min(100, (metrics.impressions / 5000) * 100);

  const score = roasScore * 0.35 + ctrScore * 0.25 + convScore * 0.20 + confidence * 0.20;
  return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Update performance_score for a single ad_copy_library entry.
 */
async function updateScore(id: string, score: number): Promise<boolean> {
  const res = await fetch(`${DIRECTUS_URL}/items/ad_copy_library/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${DIRECTUS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ performance_score: score }),
  });
  return res.ok;
}

/**
 * Main sync: fetch Google Ads performance, match to ad_copy_library, update scores.
 * Returns count of updated entries.
 */
export async function syncPerformanceScores(googleAds: GoogleAdsClient): Promise<{
  total: number;
  matched: number;
  updated: number;
  errors: number;
}> {
  console.log("[perf-sync] Fetching Google Ads performance data (last 30 days)...");
  const adsMetrics = await fetchAdPerformance(googleAds);
  console.log(`[perf-sync] Found ${adsMetrics.length} ad entries from Google Ads`);

  console.log("[perf-sync] Fetching ad_copy_library...");
  const library = await fetchAdCopyLibrary();
  console.log(`[perf-sync] Found ${library.length} entries in ad_copy_library`);

  let matched = 0;
  let updated = 0;
  let errors = 0;

  for (const entry of library) {
    const metrics = matchAdToMetrics(entry, adsMetrics);
    if (!metrics) continue;

    matched++;
    const score = calculateScore(metrics);

    // Only update if score changed
    if (entry.performance_score === score) continue;

    const ok = await updateScore(entry.id, score);
    if (ok) {
      updated++;
      console.log(`[perf-sync] ${entry.campaign_name}: ${entry.performance_score ?? "null"} → ${score}`);
    } else {
      errors++;
    }
  }

  console.log(`[perf-sync] Done: ${matched} matched, ${updated} updated, ${errors} errors`);
  return { total: library.length, matched, updated, errors };
}
