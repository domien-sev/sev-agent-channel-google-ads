/**
 * Campaign analyzer — extracts full campaign structure via GAQL.
 * Used by the wizard to clone existing campaigns.
 */
import type { GoogleAdsClient } from "@domien-sev/ads-sdk";
import * as gaql from "./gaql.js";

/** Structured representation of a campaign for cloning */
export interface CampaignStructure {
  id: string;
  name: string;
  type: string;
  subType: string | null;
  status: string;
  budget: {
    dailyMicros: number;
    daily: number;
    deliveryMethod: string;
  };
  bidding: {
    strategy: string;
    targetCpaMicros: number | null;
    targetRoas: number | null;
  };
  adGroups: AdGroupStructure[];
  locations: string[];
}

export interface AdGroupStructure {
  id: string;
  name: string;
  keywords: KeywordStructure[];
  ads: AdStructure[];
}

export interface KeywordStructure {
  text: string;
  matchType: string;
  qualityScore: number | null;
  cpcBidMicros: number;
  status: string;
}

export interface AdStructure {
  id: string;
  finalUrls: string[];
  headlines: string[];
  descriptions: string[];
  path1: string | null;
  path2: string | null;
  status: string;
}

/**
 * Extract full campaign structure from Google Ads.
 * Runs multiple GAQL queries in parallel.
 */
export async function analyzeCampaign(
  client: GoogleAdsClient,
  campaignId: string,
): Promise<CampaignStructure | null> {
  // Run queries in parallel
  const [detailsResult, keywordsResult, adsResult, locationsResult] = await Promise.all([
    client.query(gaql.campaignDetails(campaignId)),
    client.query(gaql.campaignKeywords(campaignId)),
    client.query(gaql.campaignAds(campaignId)),
    client.query(gaql.campaignLocations(campaignId)),
  ]) as [
    Array<{ results?: Array<Record<string, any>> }>,
    Array<{ results?: Array<Record<string, any>> }>,
    Array<{ results?: Array<Record<string, any>> }>,
    Array<{ results?: Array<Record<string, any>> }>,
  ];

  // Parse campaign details
  const detailRow = detailsResult[0]?.results?.[0];
  if (!detailRow) return null;

  const budgetMicros = Number(detailRow.campaignBudget?.amountMicros ?? 0);

  // Parse keywords grouped by ad group
  const adGroupMap = new Map<string, AdGroupStructure>();

  for (const batch of keywordsResult) {
    for (const row of batch.results ?? []) {
      const agId = String(row.adGroup?.id ?? "");
      const agName = String(row.adGroup?.name ?? "");

      if (!adGroupMap.has(agId)) {
        adGroupMap.set(agId, { id: agId, name: agName, keywords: [], ads: [] });
      }

      const ag = adGroupMap.get(agId)!;
      ag.keywords.push({
        text: String(row.adGroupCriterion?.keyword?.text ?? ""),
        matchType: String(row.adGroupCriterion?.keyword?.matchType ?? "BROAD"),
        qualityScore: row.adGroupCriterion?.qualityInfo?.qualityScore != null
          ? Number(row.adGroupCriterion.qualityInfo.qualityScore)
          : null,
        cpcBidMicros: Number(row.adGroupCriterion?.effectiveCpcBidMicros ?? 0),
        status: String(row.adGroupCriterion?.status ?? "ENABLED"),
      });
    }
  }

  // Parse RSA ads
  for (const batch of adsResult) {
    for (const row of batch.results ?? []) {
      const agId = String(row.adGroup?.id ?? "");

      if (!adGroupMap.has(agId)) {
        adGroupMap.set(agId, {
          id: agId,
          name: String(row.adGroup?.name ?? ""),
          keywords: [],
          ads: [],
        });
      }

      const rsa = row.adGroupAd?.ad?.responsiveSearchAd;
      const headlines: string[] = [];
      const descriptions: string[] = [];

      if (Array.isArray(rsa?.headlines)) {
        for (const h of rsa.headlines) {
          headlines.push(String(h.text ?? h));
        }
      }
      if (Array.isArray(rsa?.descriptions)) {
        for (const d of rsa.descriptions) {
          descriptions.push(String(d.text ?? d));
        }
      }

      const finalUrls = Array.isArray(row.adGroupAd?.ad?.finalUrls)
        ? row.adGroupAd.ad.finalUrls.map(String)
        : [];

      adGroupMap.get(agId)!.ads.push({
        id: String(row.adGroupAd?.ad?.id ?? ""),
        finalUrls,
        headlines,
        descriptions,
        path1: rsa?.path1 ? String(rsa.path1) : null,
        path2: rsa?.path2 ? String(rsa.path2) : null,
        status: String(row.adGroupAd?.status ?? "ENABLED"),
      });
    }
  }

  // Parse locations
  const locations: string[] = [];
  for (const batch of locationsResult) {
    for (const row of batch.results ?? []) {
      if (!row.campaignCriterion?.negative) {
        const geoConstant = String(row.campaignCriterion?.location?.geoTargetConstant ?? "");
        if (geoConstant) locations.push(geoConstant);
      }
    }
  }

  return {
    id: String(detailRow.campaign?.id ?? campaignId),
    name: String(detailRow.campaign?.name ?? "Unknown"),
    type: String(detailRow.campaign?.advertisingChannelType ?? "UNKNOWN"),
    subType: detailRow.campaign?.advertisingChannelSubType
      ? String(detailRow.campaign.advertisingChannelSubType)
      : null,
    status: String(detailRow.campaign?.status ?? "UNKNOWN"),
    budget: {
      dailyMicros: budgetMicros,
      daily: budgetMicros / 1_000_000,
      deliveryMethod: String(detailRow.campaignBudget?.deliveryMethod ?? "STANDARD"),
    },
    bidding: {
      strategy: String(detailRow.campaign?.biddingStrategyType ?? "MAXIMIZE_CONVERSIONS"),
      targetCpaMicros: detailRow.campaign?.targetCpa?.targetCpaMicros
        ? Number(detailRow.campaign.targetCpa.targetCpaMicros)
        : null,
      targetRoas: detailRow.campaign?.targetRoas?.targetRoas
        ? Number(detailRow.campaign.targetRoas.targetRoas)
        : null,
    },
    adGroups: Array.from(adGroupMap.values()),
    locations: locations.length > 0 ? locations : ["BE"],
  };
}

/** Format a campaign structure into a readable Slack summary */
export function formatCampaignSummary(structure: CampaignStructure): string {
  const lines: string[] = [
    `*Source Campaign: "${structure.name}"*`,
    "",
    `*Type:* ${structure.type} | *Status:* ${structure.status}`,
    `*Budget:* €${structure.budget.daily.toFixed(2)}/day`,
    `*Bidding:* ${structure.bidding.strategy}${structure.bidding.targetCpaMicros ? ` (Target CPA: €${(structure.bidding.targetCpaMicros / 1_000_000).toFixed(2)})` : ""}${structure.bidding.targetRoas ? ` (Target ROAS: ${structure.bidding.targetRoas.toFixed(2)}x)` : ""}`,
    "",
  ];

  for (const ag of structure.adGroups) {
    lines.push(`*Ad Group: ${ag.name}*`);

    if (ag.keywords.length > 0) {
      const activeKws = ag.keywords.filter((k) => k.status === "ENABLED");
      lines.push(`  Keywords (${activeKws.length}):`);
      for (const kw of activeKws.slice(0, 10)) {
        const qs = kw.qualityScore ? ` QS:${kw.qualityScore}` : "";
        lines.push(`    \`${kw.text}\` [${kw.matchType}]${qs}`);
      }
      if (activeKws.length > 10) {
        lines.push(`    _...and ${activeKws.length - 10} more_`);
      }
    }

    if (ag.ads.length > 0) {
      lines.push(`  Ads (${ag.ads.length}):`);
      for (const ad of ag.ads.slice(0, 2)) {
        lines.push(`    Headlines: ${ad.headlines.slice(0, 5).map((h) => `"${h}"`).join(", ")}${ad.headlines.length > 5 ? "..." : ""}`);
        lines.push(`    Descriptions: ${ad.descriptions.slice(0, 2).map((d) => `"${d}"`).join(", ")}${ad.descriptions.length > 2 ? "..." : ""}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}
