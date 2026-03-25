/** Google Ads campaign types */
export type GoogleCampaignType = "search" | "shopping" | "pmax" | "display" | "youtube";

/** Keyword match types */
export type KeywordMatchType = "EXACT" | "PHRASE" | "BROAD";

/** Quality score components */
export type QualityComponent = "ABOVE_AVERAGE" | "AVERAGE" | "BELOW_AVERAGE" | "UNSPECIFIED";

/** PMax asset group performance labels */
export type AssetGroupPerformance = "BEST" | "GOOD" | "LOW" | "LEARNING" | "UNSPECIFIED";

/** Audience segment types */
export type AudienceType =
  | "custom_intent"
  | "custom_affinity"
  | "remarketing"
  | "similar"
  | "in_market";

/** Search term action */
export type SearchTermAction = "none" | "added_as_keyword" | "added_as_negative";

/** Google Ads keyword record (for ops Directus) */
export interface GoogleAdsKeyword {
  id?: string;
  campaign_id: string;
  ad_group_id: string;
  keyword_text: string;
  match_type: KeywordMatchType;
  max_cpc_micros: number;
  quality_score: number | null;
  expected_ctr: QualityComponent | null;
  ad_relevance: QualityComponent | null;
  landing_page_exp: QualityComponent | null;
  impressions_30d: number;
  clicks_30d: number;
  conversions_30d: number;
  cost_30d: number;
  status: "ENABLED" | "PAUSED" | "REMOVED";
  last_synced: string;
  date_created?: string;
  date_updated?: string;
}

/** Search term report record (for ops Directus) */
export interface GoogleAdsSearchTerm {
  id?: string;
  campaign_id: string;
  search_term: string;
  keyword_text: string;
  match_type: KeywordMatchType;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  date: string;
  action_taken: SearchTermAction;
  date_created?: string;
}

/** Audience segment record (for ops Directus) */
export interface GoogleAdsAudience {
  id?: string;
  name: string;
  resource_name: string;
  type: AudienceType;
  criteria: AudienceCriteria;
  size_estimate: number | null;
  campaigns: string[];
  status: "ENABLED" | "PAUSED" | "REMOVED";
  date_created?: string;
  date_updated?: string;
}

export interface AudienceCriteria {
  urls?: string[];
  keywords?: string[];
  apps?: string[];
}

/** PMax asset group record (for ops Directus) */
export interface GoogleAdsAssetGroup {
  id?: string;
  campaign_id: string;
  resource_name: string;
  name: string;
  final_urls: string[];
  headlines: AssetWithLabel[];
  descriptions: AssetWithLabel[];
  image_asset_ids: string[];
  video_asset_ids: string[];
  listing_group_filters: Record<string, unknown>;
  performance_label: AssetGroupPerformance;
  status: "ENABLED" | "PAUSED" | "REMOVED";
  date_created?: string;
  date_updated?: string;
}

export interface AssetWithLabel {
  text: string;
  performance_label?: AssetGroupPerformance;
}

/** Campaign audit result */
export interface CampaignAudit {
  campaignId: string;
  campaignName: string;
  type: string;
  status: string;
  budgetMicros: number;
  impressions30d: number;
  clicks30d: number;
  cost30d: number;
  conversions30d: number;
  roas30d: number;
  issues: string[];
  recommendations: string[];
}

/** Account health score */
export interface AccountHealthScore {
  overall: number;
  categories: {
    budgetUtilization: number;
    qualityScore: number;
    conversionTracking: number;
    adCoverage: number;
    negativeKeywords: number;
  };
  campaigns: CampaignAudit[];
  topIssues: string[];
}

/** GAQL query result row (generic — permissive because GAQL results are dynamic) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GaqlRow = Record<string, any>;

/** Campaign builder config for all 5 types */
export interface CampaignConfig {
  type: GoogleCampaignType;
  name: string;
  dailyBudgetMicros: number;
  targetRoas?: number;
  targetCpa?: number;
  locations: string[];
  languages: string[];
  startDate: string;
  endDate?: string;
  // Search-specific
  keywords?: Array<{ text: string; matchType: KeywordMatchType }>;
  adGroupName?: string;
  responsiveSearchAd?: {
    headlines: string[];
    descriptions: string[];
    finalUrl: string;
    path1?: string;
    path2?: string;
  };
  // Shopping-specific
  merchantId?: string;
  feedLabel?: string;
  // PMax-specific
  assetGroup?: {
    name: string;
    finalUrls: string[];
    headlines: string[];
    longHeadlines?: string[];
    descriptions: string[];
    imageUrls?: string[];
    videoIds?: string[];
  };
  // Display-specific
  displayNetwork?: boolean;
  // YouTube-specific
  videoId?: string;
  companionBannerUrl?: string;
  // Geo targeting
  targetCountry?: string;
  proximityRadius?: number;
  proximityAddress?: string;
  proximityPostalCode?: string;
  // URL tracking
  trackingUrlTemplate?: string;
}
