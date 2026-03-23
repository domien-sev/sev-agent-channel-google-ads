/**
 * Typed campaign builder for all 5 Google Ads campaign types.
 * Uses the GoogleAdsClient from @domien-sev/ads-sdk for mutations.
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

/** Map our campaign type to Google's advertisingChannelType */
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
    return { targetRoas: { targetRoas: config.targetRoas } };
  }
  if (config.targetCpa) {
    return { targetCpa: { targetCpaMicros: String(Math.round(config.targetCpa * 1_000_000)) } };
  }
  return { maximizeConversions: {} };
}

async function createBudget(client: GoogleAdsClient, name: string, amountMicros: number): Promise<string> {
  const result = await client.mutateResource("campaignBudgets", [{
    create: {
      name: `${name} Budget`,
      amountMicros: String(amountMicros),
      deliveryMethod: "STANDARD",
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
  const result = await client.mutateResource("campaigns", [{
    create: {
      name: config.name,
      advertisingChannelType: channelType(config.type),
      status: "PAUSED",
      campaignBudget: budgetResourceName,
      startDate: config.startDate.replace(/-/g, ""),
      ...(config.endDate && { endDate: config.endDate.replace(/-/g, "") }),
      ...biddingStrategy(config),
      geoTargetTypeSetting: {
        positiveGeoTargetType: "PRESENCE_OR_INTEREST",
        negativeGeoTargetType: "PRESENCE_OR_INTEREST",
      },
      ...extraFields,
    },
  }]);
  return result.results[0].resourceName;
}

async function buildSearchCampaign(client: GoogleAdsClient, config: CampaignConfig): Promise<BuildResult> {
  const budgetRn = await createBudget(client, config.name, config.dailyBudgetMicros);
  const campaignRn = await createBaseCampaign(client, config, budgetRn, {
    networkSettings: {
      targetGoogleSearch: true,
      targetSearchNetwork: false,
      targetContentNetwork: false,
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
        adGroup: adGroupRn,
        status: "ENABLED",
        keyword: {
          text: kw.text,
          matchType: kw.matchType,
        },
      },
    }));
    await client.mutateResource("adGroupCriteria", keywordOps);
  }

  // Create responsive search ad if provided
  if (config.responsiveSearchAd) {
    const rsa = config.responsiveSearchAd;
    await client.mutateResource("adGroupAds", [{
      create: {
        adGroup: adGroupRn,
        status: "PAUSED",
        ad: {
          responsiveSearchAd: {
            headlines: rsa.headlines.map((h) => ({ text: h })),
            descriptions: rsa.descriptions.map((d) => ({ text: d })),
            path1: rsa.path1,
            path2: rsa.path2,
          },
          finalUrls: [rsa.finalUrl],
        },
      },
    }]);
  }

  return { campaignResourceName: campaignRn, adGroupResourceName: adGroupRn };
}

async function buildShoppingCampaign(client: GoogleAdsClient, config: CampaignConfig): Promise<BuildResult> {
  const budgetRn = await createBudget(client, config.name, config.dailyBudgetMicros);
  const campaignRn = await createBaseCampaign(client, config, budgetRn, {
    shoppingSetting: {
      merchantId: config.merchantId ? String(config.merchantId) : undefined,
      feedLabel: config.feedLabel,
      salesCountry: config.locations[0] ?? "BE",
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
        finalUrls: ag.finalUrls,
      },
    }]);
    assetGroupRn = assetGroupResult.results[0].resourceName;

    // Create text assets for headlines and descriptions
    const textAssetOps = [
      ...ag.headlines.map((h) => ({
        create: { name: `${ag.name} headline`, type: "TEXT", textAsset: { text: h } },
      })),
      ...ag.descriptions.map((d) => ({
        create: { name: `${ag.name} desc`, type: "TEXT", textAsset: { text: d } },
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
    advertisingChannelSubType: "DISPLAY_STANDARD",
    networkSettings: {
      targetGoogleSearch: false,
      targetSearchNetwork: false,
      targetContentNetwork: true,
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
    advertisingChannelSubType: "VIDEO_ACTION",
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
