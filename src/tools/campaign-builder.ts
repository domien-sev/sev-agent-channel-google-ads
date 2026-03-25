/**
 * Typed campaign builder for all 5 Google Ads campaign types.
 * Uses the GoogleAdsClient from @domien-sev/ads-sdk for mutations.
 *
 * IMPORTANT: The Google Ads REST API requires snake_case field names.
 * All mutation payloads must use snake_case (e.g. campaign_budget, not campaignBudget).
 */
import type { GoogleAdsClient } from "@domien-sev/ads-sdk";
import type { CampaignConfig, GoogleCampaignType } from "../types.js";

interface MutateOperation {
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
  updateMask?: string;
}

interface BuildResult {
  campaignResourceName: string;
  adGroupResourceName?: string;
  assetGroupResourceName?: string;
  adWarning?: string;
}

/**
 * Build and create a campaign of any type.
 * Returns the resource names of created entities.
 */
export async function buildCampaign(
  client: GoogleAdsClient,
  config: CampaignConfig,
): Promise<BuildResult> {
  switch (config.type) {
    case "search":
      return buildSearchCampaign(client, config);
    case "shopping":
      return buildShoppingCampaign(client, config);
    case "pmax":
      return buildPMaxCampaign(client, config);
    case "display":
      return buildDisplayCampaign(client, config);
    case "youtube":
      return buildYouTubeCampaign(client, config);
  }
}

/** Map our campaign type to Google's advertising_channel_type */
function channelType(type: GoogleCampaignType): string {
  const map: Record<GoogleCampaignType, string> = {
    search: "SEARCH",
    shopping: "SHOPPING",
    pmax: "PERFORMANCE_MAX",
    display: "DISPLAY",
    youtube: "VIDEO",
  };
  return map[type];
}

/** Map campaign type to a sensible default bidding strategy */
function biddingStrategy(config: CampaignConfig): Record<string, unknown> {
  if (config.targetRoas) {
    return { target_roas: { target_roas: config.targetRoas } };
  }
  if (config.targetCpa) {
    return { target_cpa: { target_cpa_micros: String(Math.round(config.targetCpa * 1_000_000)) } };
  }
  return { maximize_conversions: {} };
}

async function createBudget(client: GoogleAdsClient, name: string, amountMicros: number): Promise<string> {
  // Add timestamp suffix to avoid DUPLICATE_NAME errors from orphaned budgets
  const suffix = Date.now().toString(36);
  const result = await client.mutateResource("campaignBudgets", [{
    create: {
      name: `${name} Budget ${suffix}`,
      amount_micros: String(amountMicros),
      delivery_method: "STANDARD",
      explicitly_shared: false,
    },
  }]);
  return result.results[0].resourceName;
}

async function createBaseCampaign(
  client: GoogleAdsClient,
  config: CampaignConfig,
  budgetResourceName: string,
  extraFields: Record<string, unknown> = {},
): Promise<string> {
  // Create campaign without dates — Google defaults to starting today.
  // End date is set via a separate update call if needed.
  const result = await client.mutateResource("campaigns", [{
    create: {
      name: config.name,
      advertising_channel_type: channelType(config.type),
      status: "PAUSED",
      campaign_budget: budgetResourceName,
      ...biddingStrategy(config),
      geo_target_type_setting: {
        positive_geo_target_type: "PRESENCE_OR_INTEREST",
        negative_geo_target_type: "PRESENCE",
      },
      contains_eu_political_advertising: 2,
      ...extraFields,
    },
  }]);
  const campaignRn = result.results[0].resourceName;

  // Set end date via update if provided
  if (config.endDate) {
    try {
      await client.mutateResource("campaigns", [{
        update: { resourceName: campaignRn, endDate: config.endDate.replace(/-/g, "") },
        updateMask: "end_date",
      }]);
    } catch (err) {
      // Non-critical — campaign is created, end date just wasn't set
      console.warn(`Failed to set end date: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return campaignRn;
}

async function buildSearchCampaign(client: GoogleAdsClient, config: CampaignConfig): Promise<BuildResult> {
  const budgetRn = await createBudget(client, config.name, config.dailyBudgetMicros);
  const campaignRn = await createBaseCampaign(client, config, budgetRn, {
    network_settings: {
      target_google_search: true,
      target_search_network: false,
      target_content_network: false,
    },
  });

  // Create ad group
  const adGroupResult = await client.mutateResource("adGroups", [{
    create: {
      name: config.adGroupName ?? `${config.name} - Ad Group 1`,
      campaign: campaignRn,
      type: "SEARCH_STANDARD",
      status: "ENABLED",
    },
  }]);
  const adGroupRn = adGroupResult.results[0].resourceName;

  // Add keywords if provided
  if (config.keywords?.length) {
    const keywordOps = config.keywords.map((kw) => ({
      create: {
        ad_group: adGroupRn,
        status: "ENABLED",
        keyword: {
          text: kw.text,
          match_type: kw.matchType,
        },
      },
    }));
    await client.mutateResource("adGroupCriteria", keywordOps);
  }

  // Create responsive search ad if provided (non-fatal — campaign still usable without ad)
  let adWarning: string | undefined;
  if (config.responsiveSearchAd) {
    const rsa = config.responsiveSearchAd;
    try {
      await client.mutateResource("adGroupAds", [{
        create: {
          ad_group: adGroupRn,
          status: "PAUSED",
          ad: {
            responsive_search_ad: {
              headlines: rsa.headlines.map((h) => ({ text: h })),
              descriptions: rsa.descriptions.map((d) => ({ text: d })),
              path1: rsa.path1,
              path2: rsa.path2,
            },
            final_urls: [rsa.finalUrl],
          },
        },
      }]);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Extract policy topic if present
      const policyMatch = errMsg.match(/"topic":\s*"([^"]+)"/);
      const policyTopic = policyMatch ? policyMatch[1] : null;
      adWarning = policyTopic === "DESTINATION_NOT_WORKING"
        ? `Ad rejected: landing page ${rsa.finalUrl} is not reachable. Add a working URL in Google Ads.`
        : `Ad creation failed: ${policyTopic ?? errMsg.slice(0, 200)}. Add ads manually in Google Ads.`;
      console.warn(`[campaign-builder] Ad creation failed (non-fatal): ${errMsg}`);
    }
  }

  return { campaignResourceName: campaignRn, adGroupResourceName: adGroupRn, adWarning };
}

async function buildShoppingCampaign(client: GoogleAdsClient, config: CampaignConfig): Promise<BuildResult> {
  const budgetRn = await createBudget(client, config.name, config.dailyBudgetMicros);
  const campaignRn = await createBaseCampaign(client, config, budgetRn, {
    shopping_setting: {
      merchant_id: config.merchantId ? String(config.merchantId) : undefined,
      feed_label: config.feedLabel,
      sales_country: config.locations[0] ?? "BE",
    },
  });

  // Create ad group (Shopping doesn't need keywords)
  const adGroupResult = await client.mutateResource("adGroups", [{
    create: {
      name: config.adGroupName ?? `${config.name} - Products`,
      campaign: campaignRn,
      type: "SHOPPING_PRODUCT_ADS",
      status: "ENABLED",
    },
  }]);

  return {
    campaignResourceName: campaignRn,
    adGroupResourceName: adGroupResult.results[0].resourceName,
  };
}

async function buildPMaxCampaign(client: GoogleAdsClient, config: CampaignConfig): Promise<BuildResult> {
  const budgetRn = await createBudget(client, config.name, config.dailyBudgetMicros);
  const campaignRn = await createBaseCampaign(client, config, budgetRn);

  let assetGroupRn: string | undefined;

  if (config.assetGroup) {
    const ag = config.assetGroup;
    const assetGroupResult = await client.mutateResource("assetGroups", [{
      create: {
        name: ag.name,
        campaign: campaignRn,
        status: "ENABLED",
        final_urls: ag.finalUrls,
      },
    }]);
    assetGroupRn = assetGroupResult.results[0].resourceName;

    // Create text assets for headlines and descriptions
    const textAssetOps = [
      ...ag.headlines.map((h) => ({
        create: { name: `${ag.name} headline`, type: "TEXT", text_asset: { text: h } },
      })),
      ...ag.descriptions.map((d) => ({
        create: { name: `${ag.name} desc`, type: "TEXT", text_asset: { text: d } },
      })),
    ];

    if (textAssetOps.length > 0) {
      await client.mutateResource("assets", textAssetOps);
    }
  }

  return { campaignResourceName: campaignRn, assetGroupResourceName: assetGroupRn };
}

async function buildDisplayCampaign(client: GoogleAdsClient, config: CampaignConfig): Promise<BuildResult> {
  const budgetRn = await createBudget(client, config.name, config.dailyBudgetMicros);
  const campaignRn = await createBaseCampaign(client, config, budgetRn, {
    advertising_channel_sub_type: "DISPLAY_STANDARD",
    network_settings: {
      target_google_search: false,
      target_search_network: false,
      target_content_network: true,
    },
  });

  const adGroupResult = await client.mutateResource("adGroups", [{
    create: {
      name: config.adGroupName ?? `${config.name} - Display Group`,
      campaign: campaignRn,
      type: "DISPLAY_STANDARD",
      status: "ENABLED",
    },
  }]);

  return {
    campaignResourceName: campaignRn,
    adGroupResourceName: adGroupResult.results[0].resourceName,
  };
}

async function buildYouTubeCampaign(client: GoogleAdsClient, config: CampaignConfig): Promise<BuildResult> {
  const budgetRn = await createBudget(client, config.name, config.dailyBudgetMicros);
  const campaignRn = await createBaseCampaign(client, config, budgetRn, {
    advertising_channel_sub_type: "VIDEO_ACTION",
  });

  const adGroupResult = await client.mutateResource("adGroups", [{
    create: {
      name: config.adGroupName ?? `${config.name} - Video Group`,
      campaign: campaignRn,
      type: "VIDEO_TRUE_VIEW_IN_STREAM",
      status: "ENABLED",
    },
  }]);

  return {
    campaignResourceName: campaignRn,
    adGroupResourceName: adGroupResult.results[0].resourceName,
  };
}
