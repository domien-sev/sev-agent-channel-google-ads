/**
 * GAQL (Google Ads Query Language) builder helpers.
 * Constructs common queries for campaigns, keywords, audiences, etc.
 */

/** Date range for queries */
export interface DateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;
}

/** Sanitize a campaign/resource ID — must be numeric only */
function sanitizeId(id: string): string {
  const clean = id.replace(/[^0-9]/g, "");
  if (!clean) throw new Error(`Invalid GAQL ID: ${id}`);
  return clean;
}

/** Sanitize a date string — must match YYYY-MM-DD */
function sanitizeDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date format (expected YYYY-MM-DD): ${date}`);
  }
  return date;
}

/** Sanitize a string for use in GAQL LIKE clauses — escape single quotes */
export function sanitizeGaqlString(value: string): string {
  // Escape backslashes first, then single quotes (order matters to avoid double-escaping)
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function last30Days(): DateRange {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  return {
    startDate: start.toISOString().split("T")[0],
    endDate: end.toISOString().split("T")[0],
  };
}

function formatDate(date: string): string {
  return date.replace(/-/g, "");
}

/** List all campaigns with performance metrics */
export function campaignOverview(range?: DateRange): string {
  const { startDate, endDate } = range ?? last30Days();
  return `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      campaign_budget.amount_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date BETWEEN '${sanitizeDate(startDate)}' AND '${sanitizeDate(endDate)}'
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
  `.trim();
}

/** Get campaign performance by date */
export function campaignPerformanceByDate(campaignId: string, range?: DateRange): string {
  const { startDate, endDate } = range ?? last30Days();
  return `
    SELECT
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.video_views,
      metrics.average_cpc
    FROM campaign
    WHERE campaign.id = ${sanitizeId(campaignId)}
      AND segments.date BETWEEN '${sanitizeDate(startDate)}' AND '${sanitizeDate(endDate)}'
    ORDER BY segments.date
  `.trim();
}

/** Get all ad groups for a campaign */
export function adGroupsForCampaign(campaignId: string, range?: DateRange): string {
  const { startDate, endDate } = range ?? last30Days();
  return `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM ad_group
    WHERE campaign.id = ${sanitizeId(campaignId)}
      AND segments.date BETWEEN '${sanitizeDate(startDate)}' AND '${sanitizeDate(endDate)}'
      AND ad_group.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
  `.trim();
}

/** Keyword performance with quality score components */
export function keywordPerformance(campaignId?: string, range?: DateRange): string {
  const { startDate, endDate } = range ?? last30Days();
  const campaignFilter = campaignId ? `AND campaign.id = ${sanitizeId(campaignId)}` : "";
  return `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.quality_info.creative_quality_score,
      ad_group_criterion.quality_info.search_predicted_ctr,
      ad_group_criterion.quality_info.post_click_quality_score,
      ad_group_criterion.effective_cpc_bid_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.average_cpc
    FROM keyword_view
    WHERE segments.date BETWEEN '${sanitizeDate(startDate)}' AND '${sanitizeDate(endDate)}'
      ${campaignFilter}
      AND ad_group_criterion.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
  `.trim();
}

/** Search term report */
export function searchTermReport(campaignId?: string, range?: DateRange): string {
  const { startDate, endDate } = range ?? last30Days();
  const campaignFilter = campaignId ? `AND campaign.id = ${sanitizeId(campaignId)}` : "";
  return `
    SELECT
      campaign.id,
      campaign.name,
      search_term_view.search_term,
      search_term_view.status,
      segments.keyword.info.text,
      segments.keyword.info.match_type,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM search_term_view
    WHERE segments.date BETWEEN '${sanitizeDate(startDate)}' AND '${sanitizeDate(endDate)}'
      ${campaignFilter}
    ORDER BY metrics.impressions DESC
    LIMIT 200
  `.trim();
}

/** Quality score distribution */
export function qualityScoreDistribution(): string {
  return `
    SELECT
      ad_group_criterion.quality_info.quality_score,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions
    FROM keyword_view
    WHERE ad_group_criterion.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
      AND ad_group_criterion.quality_info.quality_score IS NOT NULL
    ORDER BY ad_group_criterion.quality_info.quality_score
  `.trim();
}

/** PMax asset group performance */
export function assetGroupPerformance(campaignId?: string, range?: DateRange): string {
  const { startDate, endDate } = range ?? last30Days();
  const campaignFilter = campaignId ? `AND campaign.id = ${sanitizeId(campaignId)}` : "";
  return `
    SELECT
      campaign.id,
      campaign.name,
      asset_group.id,
      asset_group.name,
      asset_group.status,
      asset_group.primary_status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM asset_group
    WHERE segments.date BETWEEN '${sanitizeDate(startDate)}' AND '${sanitizeDate(endDate)}'
      ${campaignFilter}
      AND asset_group.status != 'REMOVED'
    ORDER BY metrics.conversions_value DESC
  `.trim();
}

/** Shopping product performance */
export function shoppingProductPerformance(campaignId?: string, range?: DateRange): string {
  const { startDate, endDate } = range ?? last30Days();
  const campaignFilter = campaignId ? `AND campaign.id = ${sanitizeId(campaignId)}` : "";
  return `
    SELECT
      segments.product_item_id,
      segments.product_title,
      segments.product_brand,
      segments.product_category_level1,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM shopping_performance_view
    WHERE segments.date BETWEEN '${sanitizeDate(startDate)}' AND '${sanitizeDate(endDate)}'
      ${campaignFilter}
    ORDER BY metrics.conversions_value DESC
    LIMIT 100
  `.trim();
}

/** Account-level conversion tracking status */
export function conversionActions(): string {
  return `
    SELECT
      conversion_action.id,
      conversion_action.name,
      conversion_action.type,
      conversion_action.status,
      conversion_action.category,
      metrics.all_conversions,
      metrics.all_conversions_value
    FROM conversion_action
    WHERE conversion_action.status = 'ENABLED'
    ORDER BY metrics.all_conversions DESC
  `.trim();
}

/** Audience performance */
export function audiencePerformance(range?: DateRange): string {
  const { startDate, endDate } = range ?? last30Days();
  return `
    SELECT
      campaign.id,
      campaign.name,
      ad_group_criterion.user_list.user_list,
      ad_group_criterion.custom_audience.custom_audience,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM ad_group_audience_view
    WHERE segments.date BETWEEN '${sanitizeDate(startDate)}' AND '${sanitizeDate(endDate)}'
    ORDER BY metrics.conversions_value DESC
  `.trim();
}

/** Campaign details (settings, budget, bidding — no date range needed) */
export function campaignDetails(campaignId: string): string {
  return `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.advertising_channel_sub_type,
      campaign.bidding_strategy_type,
      campaign.target_cpa.target_cpa_micros,
      campaign.target_roas.target_roas,
      campaign.geo_target_type_setting.positive_geo_target_type,
      campaign_budget.amount_micros,
      campaign_budget.delivery_method
    FROM campaign
    WHERE campaign.id = ${sanitizeId(campaignId)}
  `.trim();
}

/** All keywords for a campaign with match types and quality scores */
export function campaignKeywords(campaignId: string): string {
  return `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.effective_cpc_bid_micros
    FROM keyword_view
    WHERE campaign.id = ${sanitizeId(campaignId)}
      AND ad_group_criterion.status != 'REMOVED'
    ORDER BY ad_group_criterion.keyword.text
  `.trim();
}

/** All RSA ads for a campaign */
export function campaignAds(campaignId: string): string {
  return `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group_ad.ad.id,
      ad_group_ad.ad.final_urls,
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.ad.responsive_search_ad.path1,
      ad_group_ad.ad.responsive_search_ad.path2,
      ad_group_ad.status
    FROM ad_group_ad
    WHERE campaign.id = ${sanitizeId(campaignId)}
      AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
      AND ad_group_ad.status != 'REMOVED'
  `.trim();
}

/** Location targeting for a campaign */
export function campaignLocations(campaignId: string): string {
  return `
    SELECT
      campaign_criterion.location.geo_target_constant,
      campaign_criterion.negative
    FROM campaign_criterion
    WHERE campaign.id = ${sanitizeId(campaignId)}
      AND campaign_criterion.type = 'LOCATION'
  `.trim();
}

/** Responsive search ad asset performance */
export function rsaAssetPerformance(campaignId?: string): string {
  const campaignFilter = campaignId ? `AND campaign.id = ${sanitizeId(campaignId)}` : "";
  return `
    SELECT
      campaign.name,
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.ad.final_urls,
      ad_group_ad_asset_view.performance_label,
      ad_group_ad_asset_view.field_type,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions
    FROM ad_group_ad_asset_view
    WHERE ad_group_ad.status = 'ENABLED'
      ${campaignFilter}
    ORDER BY metrics.impressions DESC
  `.trim();
}
