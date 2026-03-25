/**
 * RedTrack integration for Google Ads campaign tracking.
 * Creates RedTrack offer + campaign when a Google Ads campaign is confirmed.
 * Returns tracking URL to use as final_url in ads.
 */

const REDTRACK_API_URL = process.env.REDTRACK_API_URL ?? "https://api.redtrack.io";
const REDTRACK_API_KEY = process.env.REDTRACK_API_KEY ?? "";

/** Google Ads tracking preset for Shopping Event VIP */
const GOOGLE_ADS_PRESET = {
  sourceId: "650ead3c8d33bd00010d71c5",
  domainId: "650431d161f1c40001ae2b24",
  trackingParams: "utm_campaign={replace}&sub2={keyword}&sub3={matchtype}&sub4={adgroupid}&sub5={creative}&sub6={campaignid}&sub7={device}&sub8={adposition}&sub9={network}&sub10={placement}&utm_source=Google&wbraid={wbraid}&gbraid={gbraid}&ref_id={gclid}",
};

const OFFER_TRACKING_PARAMS = "rtkcid={clickid}&clickid={clickid}&cmpid={campaignid}";

export function isRedTrackConfigured(): boolean {
  return REDTRACK_API_KEY.length > 0;
}

/**
 * Create a full RedTrack campaign for a physical event Google Ads campaign.
 * Returns the tracking URL to use as final_url in ads.
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
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
    const brandClean = params.brand.replace(/\s+/g, "");
    const eventLabel = params.eventType === "physical" ? "physical" : "online";
    const campaignTitle = `${yearMonth}-${brandClean}-${eventLabel}-GoogleAdstracking`;

    // Create campaign without streams — source template auto-applies tracking params.
    // The actual landing page is set as final_url in Google Ads; RedTrack's tracking
    // template wraps it with {lpurl}?cmpid=CAMPAIGN_ID&...
    const campaignRes = await fetch(`${REDTRACK_API_URL}/campaigns?api_key=${REDTRACK_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: campaignTitle,
        source_id: GOOGLE_ADS_PRESET.sourceId,
        domain_id: GOOGLE_ADS_PRESET.domainId,
        status: 1,
      }),
    });

    if (!campaignRes.ok) {
      console.error(`[redtrack] Create campaign failed: ${campaignRes.status} ${await campaignRes.text()}`);
      return null;
    }

    const campaign = await campaignRes.json() as { id: string; trackback_url: string };

    // Add Offline Sales offer stream to the campaign (prevents "funnel deleted" warning)
    try {
      await fetch(`${REDTRACK_API_URL}/streams?api_key=${REDTRACK_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_id: campaign.id,
          weight: 0,
          offers: [{ id: "65b4ae865141de0001dfa8e1", weight: 100 }],
        }),
      });
    } catch { /* non-critical */ }

    // Build tracking template: {lpurl}?cmpid=CAMPAIGN_ID&utm_campaign=...
    const trackingTemplate = `{lpurl}?cmpid=${campaign.id}&${GOOGLE_ADS_PRESET.trackingParams}`;

    console.log(`[redtrack] Created campaign "${campaignTitle}" (${campaign.id})`);
    console.log(`[redtrack] Tracking template: ${trackingTemplate}`);

    return {
      trackingUrl: campaign.trackback_url,
      campaignId: campaign.id,
      trackingTemplate,
    };
  } catch (err) {
    console.error(`[redtrack] Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
