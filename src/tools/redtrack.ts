/**
 * RedTrack integration for Google Ads campaign tracking.
 * Uses @domien-sev/redtrack-sdk for the three-step campaign creation
 * (offer → stream → campaign PUT) that properly binds funnels.
 */

import { RedTrackClient } from "@domien-sev/redtrack-sdk";

const REDTRACK_API_URL = process.env.REDTRACK_API_URL ?? "https://api.redtrack.io";
const REDTRACK_API_KEY = process.env.REDTRACK_API_KEY ?? "";

/** Google Ads tracking params appended to the tracking URL by RedTrack */
const GOOGLE_ADS_TRACKING_PARAMS =
  "utm_campaign={replace}&sub2={keyword}&sub3={matchtype}&sub4={adgroupid}" +
  "&sub5={creative}&sub6={campaignid}&sub7={device}&sub8={adposition}" +
  "&sub9={network}&sub10={placement}&utm_source=Google&wbraid={wbraid}" +
  "&gbraid={gbraid}&ref_id={gclid}";

let client: RedTrackClient | null = null;

function getClient(): RedTrackClient {
  if (!client) {
    client = new RedTrackClient({ apiKey: REDTRACK_API_KEY, apiUrl: REDTRACK_API_URL });
  }
  return client;
}

export function isRedTrackConfigured(): boolean {
  return REDTRACK_API_KEY.length > 0;
}

/**
 * Create a full RedTrack campaign for an event Google Ads campaign.
 * Returns the tracking template to use in Google Ads campaign settings.
 */
export async function createRedTrackCampaign(params: {
  brand: string;
  eventType: "physical" | "online";
  landingPageUrl: string;
}): Promise<{ trackingUrl: string; campaignId: string; trackingTemplate: string } | null> {
  if (!isRedTrackConfigured()) {
    console.warn("[redtrack] Not configured — skipping");
    return null;
  }

  try {
    const result = await getClient().createEventCampaign({
      brand: params.brand,
      eventType: params.eventType,
      channel: "google-ads",
      landingPageUrl: params.landingPageUrl,
    });

    const trackingTemplate = `{lpurl}?cmpid=${result.campaignId}&${GOOGLE_ADS_TRACKING_PARAMS}`;

    console.log(`[redtrack] Created campaign ${result.campaignId}`);
    console.log(`[redtrack] Tracking URL: ${result.trackingUrl}`);
    console.log(`[redtrack] Tracking template: ${trackingTemplate}`);

    return {
      trackingUrl: result.trackingUrl,
      campaignId: result.campaignId,
      trackingTemplate,
    };
  } catch (err) {
    console.error(`[redtrack] Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
