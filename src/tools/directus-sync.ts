/**
 * Bidirectional sync between Google Ads data and Directus collections.
 * Syncs keywords, search terms, audiences, and asset groups.
 */
import type { GoogleAdsClient } from "@domien-sev/ads-sdk";
import type { DirectusClientManager } from "@domien-sev/directus-sdk";
import { createItem, readItems, updateItem } from "@directus/sdk";
import type {
  GoogleAdsKeyword,
  GoogleAdsSearchTerm,
  GoogleAdsAudience,
  GoogleAdsAssetGroup,
  KeywordMatchType,
  QualityComponent,
} from "../types.js";

/**
 * Sync keyword data from Google Ads to Directus.
 * Pulls keyword performance + quality scores and upserts into google_ads_keywords.
 */
export async function syncKeywords(
  googleAds: GoogleAdsClient,
  directus: DirectusClientManager,
): Promise<number> {
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0];

  const query = `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.effective_cpc_bid_micros,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.quality_info.search_predicted_ctr,
      ad_group_criterion.quality_info.creative_quality_score,
      ad_group_criterion.quality_info.post_click_quality_score,
      ad_group_criterion.status,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.cost_micros
    FROM keyword_view
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND ad_group_criterion.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 500
  `;

  const results = await googleAds.query(query) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  const client = directus.getClient("sev-ai");
  let synced = 0;

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      const keywordText = String(row.adGroupCriterion?.keyword?.text ?? "");
      const campaignId = String(row.campaign?.id ?? "");
      const adGroupId = String(row.adGroup?.id ?? "");

      if (!keywordText || !campaignId) continue;

      const keywordData: Omit<GoogleAdsKeyword, "id" | "date_created" | "date_updated"> = {
        campaign_id: campaignId,
        ad_group_id: adGroupId,
        keyword_text: keywordText,
        match_type: String(row.adGroupCriterion?.keyword?.matchType ?? "BROAD") as KeywordMatchType,
        max_cpc_micros: Number(row.adGroupCriterion?.effectiveCpcBidMicros ?? 0),
        quality_score: row.adGroupCriterion?.qualityInfo?.qualityScore != null
          ? Number(row.adGroupCriterion.qualityInfo.qualityScore)
          : null,
        expected_ctr: (row.adGroupCriterion?.qualityInfo?.searchPredictedCtr as QualityComponent) ?? null,
        ad_relevance: (row.adGroupCriterion?.qualityInfo?.creativeQualityScore as QualityComponent) ?? null,
        landing_page_exp: (row.adGroupCriterion?.qualityInfo?.postClickQualityScore as QualityComponent) ?? null,
        impressions_30d: Number(row.metrics?.impressions ?? 0),
        clicks_30d: Number(row.metrics?.clicks ?? 0),
        conversions_30d: Number(row.metrics?.conversions ?? 0),
        cost_30d: Number(row.metrics?.costMicros ?? 0) / 1_000_000,
        status: String(row.adGroupCriterion?.status ?? "ENABLED") as GoogleAdsKeyword["status"],
        last_synced: new Date().toISOString(),
      };

      // Check if keyword already exists
      try {
        // @ts-ignore — collection not in typed schema
        const existing = await (client as any).request(
          readItems("google_ads_keywords", {
            filter: {
              keyword_text: { _eq: keywordText },
              campaign_id: { _eq: campaignId },
              ad_group_id: { _eq: adGroupId },
            },
            limit: 1,
          }),
        ) as Array<{ id?: string }>;

        if (existing[0]?.id) {
          // @ts-ignore — collection not in typed schema
          await (client as any).request(updateItem("google_ads_keywords", existing[0].id, keywordData));
        } else {
          // @ts-ignore — collection not in typed schema
          await (client as any).request(createItem("google_ads_keywords", keywordData));
        }
        synced++;
      } catch {
        // Collection may not exist yet, skip silently
      }
    }
  }

  return synced;
}

/**
 * Sync search term data from Google Ads to Directus.
 */
export async function syncSearchTerms(
  googleAds: GoogleAdsClient,
  directus: DirectusClientManager,
  days: number = 7,
): Promise<number> {
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];

  const query = `
    SELECT
      campaign.id,
      search_term_view.search_term,
      segments.keyword.info.text,
      segments.keyword.info.match_type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions
    FROM search_term_view
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
    ORDER BY metrics.impressions DESC
    LIMIT 300
  `;

  const results = await googleAds.query(query) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  const client = directus.getClient("sev-ai");
  let synced = 0;

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      const searchTermData: Omit<GoogleAdsSearchTerm, "id" | "date_created"> = {
        campaign_id: String(row.campaign?.id ?? ""),
        search_term: String(row.searchTermView?.searchTerm ?? ""),
        keyword_text: String(row.segments?.keyword?.info?.text ?? ""),
        match_type: String(row.segments?.keyword?.info?.matchType ?? "BROAD") as KeywordMatchType,
        impressions: Number(row.metrics?.impressions ?? 0),
        clicks: Number(row.metrics?.clicks ?? 0),
        cost: Number(row.metrics?.costMicros ?? 0) / 1_000_000,
        conversions: Number(row.metrics?.conversions ?? 0),
        date: endDate,
        action_taken: "none",
      };

      try {
        // @ts-ignore — collection not in typed schema
        await (client as any).request(createItem("google_ads_search_terms", searchTermData));
        synced++;
      } catch {
        // Skip duplicates or missing collection
      }
    }
  }

  return synced;
}

/**
 * Sync PMax asset group data to Directus.
 */
export async function syncAssetGroups(
  googleAds: GoogleAdsClient,
  directus: DirectusClientManager,
): Promise<number> {
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0];

  const query = `
    SELECT
      campaign.id,
      asset_group.id,
      asset_group.name,
      asset_group.status,
      asset_group.primary_status,
      asset_group.final_urls
    FROM asset_group
    WHERE asset_group.status != 'REMOVED'
  `;

  const results = await googleAds.query(query) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  const client = directus.getClient("sev-ai");
  let synced = 0;

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      const assetGroupData: Partial<GoogleAdsAssetGroup> = {
        campaign_id: String(row.campaign?.id ?? ""),
        resource_name: String(row.assetGroup?.id ?? ""),
        name: String(row.assetGroup?.name ?? ""),
        final_urls: Array.isArray(row.assetGroup?.finalUrls) ? row.assetGroup.finalUrls as string[] : [],
        headlines: [],
        descriptions: [],
        image_asset_ids: [],
        video_asset_ids: [],
        listing_group_filters: {},
        performance_label: "UNSPECIFIED",
        status: String(row.assetGroup?.status ?? "ENABLED") as GoogleAdsAssetGroup["status"],
      };

      try {
        // @ts-ignore — collection not in typed schema
        const existing = await (client as any).request(
          readItems("google_ads_asset_groups", {
            filter: {
              resource_name: { _eq: assetGroupData.resource_name },
            },
            limit: 1,
          }),
        ) as Array<{ id?: string }>;

        if (existing[0]?.id) {
          // @ts-ignore — collection not in typed schema
          await (client as any).request(updateItem("google_ads_asset_groups", existing[0].id, assetGroupData));
        } else {
          // @ts-ignore — collection not in typed schema
          await (client as any).request(createItem("google_ads_asset_groups", assetGroupData));
        }
        synced++;
      } catch {
        // Skip if collection doesn't exist
      }
    }
  }

  return synced;
}
