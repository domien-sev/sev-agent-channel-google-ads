/**
 * Batch campaign creation handler.
 * Creates multiple Google Ads Search campaigns for all brands at an event.
 *
 * POST /batch-campaigns
 * Body: { eventId, brands?, budget?, radius?, execute?, eventShortName? }
 *
 * Two modes:
 * - Preview (execute=false): returns plan with keywords, sample copy, budgets
 * - Execute (execute=true): creates campaigns PAUSED, returns resource names
 */

import type { GoogleAdsAgent } from "../agent.js";
import { getEventById, isEventSourceConfigured } from "../tools/event-source.js";
import type { EventData } from "../tools/event-source.js";
import { researchKeywords } from "../tools/keyword-planner.js";
import type { KeywordIdea } from "../tools/keyword-planner.js";
import { generateRecommendations } from "../tools/ai-recommendations.js";
import type { WizardRecommendations } from "../tools/ai-recommendations.js";
import { buildCampaign } from "../tools/campaign-builder.js";
import { createCampaignAssets, generateEventSitelinks, generateEventCallouts } from "../tools/asset-builder.js";
import { storeAdCopy, extractBrand } from "../tools/ad-memory.js";
import { createRedTrackCampaign, isRedTrackConfigured } from "../tools/redtrack.js";
import { searchBrandContext } from "../tools/brand-knowledge.js";
import type { CampaignConfig, GoogleCampaignType } from "../types.js";

export interface BatchRequest {
  eventId: string;
  brands?: string[];
  budget?: number;
  radius?: number;
  execute?: boolean;
  eventShortName?: string;
}

interface BrandPlan {
  brand: string;
  campaignName: string;
  keywords: Array<{ text: string; matchType: string; volume?: number; competition?: string }>;
  totalVolume: number;
  estimatedBudget: number;
  sampleHeadlinesNl: string[];
  sampleHeadlinesFr: string[];
  status: "NEW" | "EXISTS";
  existingCampaignId?: string;
}

interface BatchPreviewResponse {
  ok: true;
  mode: "preview";
  event: {
    name: string;
    dates: string;
    location: string;
    brandCount: number;
    slug: string;
  };
  campaigns: BrandPlan[];
  totals: {
    newCampaigns: number;
    existingCampaigns: number;
    totalDailyBudget: number;
    totalKeywords: number;
  };
}

interface BatchExecuteResponse {
  ok: true;
  mode: "execute";
  created: Array<{ brand: string; campaignName: string; resourceName: string; adGroups: number }>;
  skipped: Array<{ brand: string; reason: string }>;
  failed: Array<{ brand: string; error: string }>;
}

type BatchResponse = BatchPreviewResponse | BatchExecuteResponse | { ok: false; error: string };

/**
 * Main batch handler — called from HTTP endpoint.
 */
export async function handleBatchCampaigns(
  agent: GoogleAdsAgent,
  request: BatchRequest,
): Promise<BatchResponse> {
  if (!agent.googleAds) {
    return { ok: false, error: "Google Ads client not configured" };
  }

  // 1. Fetch event data
  if (!isEventSourceConfigured()) {
    return { ok: false, error: "Event source not configured (WEBSITE_COLLAB_DIRECTUS_URL)" };
  }

  const event = await getEventById(request.eventId);
  if (!event) {
    return { ok: false, error: `Event not found: ${request.eventId}` };
  }

  const brands = request.brands ?? event.brands ?? [];
  if (brands.length === 0) {
    return { ok: false, error: "No brands found for this event" };
  }

  const budget = request.budget ?? 5;
  const radius = request.radius ?? 50;
  const shortName = request.eventShortName ?? deriveShortName(event);
  const datePrefix = deriveDatePrefix(event);

  // 2. Check existing campaigns
  const existingMap = await findExistingCampaigns(agent, datePrefix, shortName);

  // 3. Build plans for each brand
  console.log(`[batch] Planning ${brands.length} campaigns for "${event.titleNl ?? event.titleFr}"`);

  const plans: BrandPlan[] = [];
  for (const brand of brands) {
    const campaignName = `${datePrefix}_${normalizeBrandName(brand)}_${shortName}`;

    if (existingMap.has(campaignName.toLowerCase())) {
      plans.push({
        brand,
        campaignName,
        keywords: [],
        totalVolume: 0,
        estimatedBudget: budget,
        sampleHeadlinesNl: [],
        sampleHeadlinesFr: [],
        status: "EXISTS",
        existingCampaignId: existingMap.get(campaignName.toLowerCase()),
      });
      continue;
    }

    // Keyword research for this brand
    const keywords = await researchBrandKeywords(agent, brand, shortName, event);
    const totalVolume = keywords.reduce((s, k) => s + (k.volume ?? 0), 0);

    plans.push({
      brand,
      campaignName,
      keywords,
      totalVolume,
      estimatedBudget: budget,
      sampleHeadlinesNl: generateSampleHeadlines(brand, event, "nl"),
      sampleHeadlinesFr: generateSampleHeadlines(brand, event, "fr"),
      status: "NEW",
    });
  }

  // Preview mode — return plan
  if (!request.execute) {
    const newPlans = plans.filter((p) => p.status === "NEW");
    return {
      ok: true,
      mode: "preview",
      event: {
        name: event.titleNl ?? event.titleFr ?? "",
        dates: event.dateTextNl ?? `${event.startDate} — ${event.endDate}`,
        location: event.locationText ?? "",
        brandCount: brands.length,
        slug: (event as any).slug ?? "",
      },
      campaigns: plans,
      totals: {
        newCampaigns: newPlans.length,
        existingCampaigns: plans.length - newPlans.length,
        totalDailyBudget: newPlans.length * budget,
        totalKeywords: newPlans.reduce((s, p) => s + p.keywords.length, 0),
      },
    };
  }

  // Execute mode — create campaigns
  console.log(`[batch] Executing: creating ${plans.filter((p) => p.status === "NEW").length} campaigns`);

  const created: BatchExecuteResponse["created"] = [];
  const skipped: BatchExecuteResponse["skipped"] = [];
  const failed: BatchExecuteResponse["failed"] = [];

  for (const plan of plans) {
    if (plan.status === "EXISTS") {
      skipped.push({ brand: plan.brand, reason: `Campaign ${plan.campaignName} already exists` });
      continue;
    }

    try {
      const result = await createBrandCampaign(agent, plan, event, budget, radius);
      created.push(result);
      console.log(`[batch] Created: ${plan.campaignName} (${result.resourceName})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ brand: plan.brand, error: msg });
      console.error(`[batch] Failed: ${plan.brand} — ${msg}`);
    }
  }

  return { ok: true, mode: "execute", created, skipped, failed };
}

// ── Keyword Research ────────────────────────────────────────────────

async function researchBrandKeywords(
  agent: GoogleAdsAgent,
  brand: string,
  eventShortName: string,
  event: EventData,
): Promise<BrandPlan["keywords"]> {
  // Build seed keywords
  const seedsNl = [
    `${brand} outlet`,
    `${brand} private sale`,
    `${brand} solden`,
    `${brand} korting`,
    `${eventShortName} ${brand}`,
  ];

  const seedsFr = [
    `${brand} outlet`,
    `${brand} vente privée`,
    `${brand} soldes`,
    `${brand} réduction`,
  ];

  // Base keywords we always include (manually crafted, high intent)
  const baseKeywords: BrandPlan["keywords"] = [
    { text: `${brand} outlet`, matchType: "EXACT" },
    { text: `${brand} private sale`, matchType: "EXACT" },
    { text: `${brand} solden`, matchType: "PHRASE" },
    { text: `${brand} korting`, matchType: "PHRASE" },
    { text: `${brand} soldes`, matchType: "PHRASE" },
    { text: `${brand} vente privée`, matchType: "PHRASE" },
    { text: `${brand} outlet ${event.locationText?.split(",")[0] ?? "Sint-Niklaas"}`, matchType: "PHRASE" },
    { text: `${eventShortName} ${brand}`, matchType: "PHRASE" },
    { text: brand, matchType: "BROAD" },
  ];

  // Enrich with Keyword Planner data
  try {
    const [nlIdeas, frIdeas] = await Promise.allSettled([
      researchKeywords(agent.googleAds, { seedKeywords: seedsNl, language: "1043", limit: 20 }),
      researchKeywords(agent.googleAds, { seedKeywords: seedsFr, language: "1001", limit: 15 }),
    ]);

    // Build volume lookup from planner results
    const volumeMap = new Map<string, KeywordIdea>();
    for (const result of [nlIdeas, frIdeas]) {
      if (result.status === "fulfilled") {
        for (const idea of result.value) {
          volumeMap.set(idea.keyword.toLowerCase(), idea);
        }
      }
    }

    // Enrich base keywords with volume data
    for (const kw of baseKeywords) {
      const idea = volumeMap.get(kw.text.toLowerCase());
      if (idea) {
        kw.volume = idea.avgMonthlySearches;
        kw.competition = idea.competition === "UNSPECIFIED" ? undefined : idea.competition;
      }
    }

    // Add top planner suggestions not already in base
    const existingTexts = new Set(baseKeywords.map((k) => k.text.toLowerCase()));
    const extras: BrandPlan["keywords"] = [];

    for (const [, idea] of volumeMap) {
      if (existingTexts.has(idea.keyword.toLowerCase())) continue;
      if (idea.avgMonthlySearches < 10) continue;
      // Only include brand-related keywords
      if (!idea.keyword.toLowerCase().includes(brand.toLowerCase().split(" ")[0])) continue;

      extras.push({
        text: idea.keyword,
        matchType: idea.competition === "HIGH" ? "EXACT" : "PHRASE",
        volume: idea.avgMonthlySearches,
        competition: idea.competition === "UNSPECIFIED" ? undefined : idea.competition,
      });

      if (extras.length >= 6) break;
    }

    return [...baseKeywords, ...extras];
  } catch (err) {
    console.warn(`[batch] Keyword Planner failed for ${brand}: ${err instanceof Error ? err.message : String(err)}`);
    return baseKeywords;
  }
}

// ── Campaign Creation ───────────────────────────────────────────────

async function createBrandCampaign(
  agent: GoogleAdsAgent,
  plan: BrandPlan,
  event: EventData,
  budget: number,
  radius: number,
): Promise<{ brand: string; campaignName: string; resourceName: string; adGroups: number }> {
  const brand = plan.brand;
  const eventUrl = `https://www.shoppingeventvip.be/nl/event/${(event as any).slug ?? "le-salon-vip"}`;
  const eventUrlFr = eventUrl.replace("/nl/", "/fr/");

  // Gather RAG context for better ad copy
  let ragContext = "";
  try {
    const brandCtx = await searchBrandContext(brand, "physical", "search");
    if (brandCtx) ragContext = brandCtx;
  } catch { /* non-fatal */ }

  // Generate bilingual ad copy via AI
  const rec = await generateRecommendations({
    brandOrProduct: buildBrandContext(brand, event),
    campaignType: "search",
    ragContext,
  });

  // Override AI recommendations with our plan data
  rec.campaignName = plan.campaignName;
  rec.keywords = plan.keywords.map((k) => ({ text: k.text, matchType: k.matchType as any, group: "batch" }));
  rec.budget = { dailyEuros: budget, reasoning: "Batch event campaign" };
  rec.finalUrl = eventUrl;
  rec.endDate = event.suggestedCampaignEnd ?? event.endDate?.split("T")[0];

  // Build campaign config
  const endDate = rec.endDate;
  const languages = ["nl", "fr"];
  const primaryLang = "nl";

  // RedTrack
  let trackingTemplate: string | undefined;
  if (isRedTrackConfigured()) {
    try {
      const rt = await createRedTrackCampaign({ brand, eventType: "physical", landingPageUrl: eventUrl });
      if (rt) trackingTemplate = rt.trackingTemplate;
    } catch { /* non-fatal */ }
  }

  const config: CampaignConfig = {
    type: "search" as GoogleCampaignType,
    name: plan.campaignName,
    dailyBudgetMicros: Math.round(budget * 1_000_000),
    locations: ["BE"],
    languages,
    startDate: new Date().toISOString().split("T")[0],
    ...(endDate && { endDate }),
    targetCountry: "BE",
    proximityRadius: radius,
    proximityAddress: event.locationText ?? "Schrijberg 189/193, Sint-Niklaas",
    proximityPostalCode: event.postalCode ?? "9111",
    keywords: rec.keywords.map((k) => ({ text: k.text, matchType: k.matchType as any })),
    adGroupName: `${plan.campaignName} - NL`,
    responsiveSearchAd: {
      headlines: rec.adCopy.nl.headlines,
      descriptions: rec.adCopy.nl.descriptions,
      finalUrl: eventUrl,
      path1: rec.path1,
      path2: rec.path2,
    },
    ...(trackingTemplate && { trackingUrlTemplate: trackingTemplate }),
  };

  // Build primary campaign + NL ad group
  const result = await buildCampaign(agent.googleAds, config);
  let adGroupCount = 1;

  // Create FR ad group
  if (result.campaignResourceName && rec.adCopy.fr) {
    try {
      const frAdGroupResult = await agent.googleAds.mutateResource("adGroups", [{
        create: {
          name: `${plan.campaignName} - FR`,
          campaign: result.campaignResourceName,
          type: "SEARCH_STANDARD",
          status: "ENABLED",
        },
      }]);
      const frAdGroupRn = frAdGroupResult.results[0].resourceName;

      // Add keywords to FR ad group
      if (rec.keywords.length > 0) {
        await agent.googleAds.mutateResource("adGroupCriteria",
          rec.keywords.map((k) => ({
            create: {
              ad_group: frAdGroupRn,
              status: "ENABLED",
              keyword: { text: k.text, match_type: k.matchType },
            },
          })),
        );
      }

      // Create FR RSA
      if (rec.adCopy.fr.headlines.length > 0) {
        await agent.googleAds.mutateResource("adGroupAds", [{
          create: {
            ad_group: frAdGroupRn,
            status: "ENABLED",
            ad: {
              responsive_search_ad: {
                headlines: rec.adCopy.fr.headlines.slice(0, 15).map((h) => ({ text: h })),
                descriptions: rec.adCopy.fr.descriptions.slice(0, 4).map((d) => ({ text: d })),
                path1: rec.path1,
                path2: rec.path2,
              },
              final_urls: [eventUrlFr],
            },
          },
        }]);
      }

      adGroupCount = 2;
    } catch (err) {
      console.warn(`[batch] FR ad group failed for ${brand}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Create campaign assets
  try {
    await createCampaignAssets(agent.googleAds, result.campaignResourceName, {
      sitelinks: generateEventSitelinks(eventUrl, primaryLang as any),
      callouts: rec.callouts ?? generateEventCallouts(primaryLang as any, true),
      brands: event.brands,
      promotionText: rec.promotionText ?? `Private Sale ${brand}`,
      discountPercent: 70,
      finalUrl: eventUrl,
      eventStartDate: event.startDate?.split("T")[0],
      eventEndDate: endDate,
      language: primaryLang as any,
      eventType: "physical",
    });
  } catch { /* non-fatal */ }

  // Store ad copy for future RAG
  try {
    await storeAdCopy({
      brand,
      eventType: "physical",
      campaignType: "search",
      language: "nl",
      headlines: rec.adCopy.nl.headlines,
      descriptions: rec.adCopy.nl.descriptions,
      finalUrl: eventUrl,
      path1: rec.path1,
      path2: rec.path2,
      keywords: rec.keywords,
      campaignName: plan.campaignName,
      eventDates: event.dateTextNl ?? undefined,
    });
  } catch { /* non-fatal */ }

  return {
    brand,
    campaignName: plan.campaignName,
    resourceName: result.campaignResourceName,
    adGroups: adGroupCount,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildBrandContext(brand: string, event: EventData): string {
  const location = event.locationText ?? "Sint-Niklaas";
  const dates = event.dateTextNl ?? event.dateTextFr ?? "";
  return (
    `Create a Google Ads Search campaign for the brand "${brand}" at a private sale event.\n` +
    `Event: "${event.titleNl ?? event.titleFr}" — a physical outlet/private sale event.\n` +
    `Location: ${location}\n` +
    `Dates: ${dates}\n` +
    `Landing page NL: https://www.shoppingeventvip.be/nl/event/${(event as any).slug ?? ""}\n` +
    `Landing page FR: https://www.shoppingeventvip.be/fr/event/${(event as any).slug ?? ""}\n\n` +
    `MANDATORY in headlines:\n` +
    `- Brand name "${brand}"\n` +
    `- "Private Sale" or "Outlet"\n` +
    `- "Le Salon VIP"\n` +
    `- Location: "${location.split(",")[0]}"\n` +
    `- Dates (abbreviated)\n` +
    `- Urgency: "Beperkte plaatsen" (NL) / "Places limitées" (FR)\n\n` +
    `This is an exclusive outlet event with discounts up to -70% on premium brands.\n` +
    `Free parking. Registration required. Multiple time slots available.`
  );
}

function generateSampleHeadlines(brand: string, event: EventData, lang: "nl" | "fr"): string[] {
  const city = (event.locationText ?? "Sint-Niklaas").split(",")[0].trim();
  if (lang === "nl") {
    return [
      `${brand} Private Sale`,
      `Le Salon VIP ${city}`,
      `${brand} Outlet tot -70%`,
      `11-26 April ${city}`,
      `Beperkte Plaatsen`,
    ].filter((h) => h.length <= 30);
  }
  return [
    `${brand} Vente Privée`,
    `Le Salon VIP ${city}`,
    `${brand} Outlet -70%`,
    `11-26 Avril ${city}`,
    `Places Limitées`,
  ].filter((h) => h.length <= 30);
}

async function findExistingCampaigns(
  agent: GoogleAdsAgent,
  datePrefix: string,
  shortName: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  try {
    const query = `
      SELECT campaign.name, campaign.id
      FROM campaign
      WHERE campaign.name LIKE '%${datePrefix}%${shortName}%'
        AND campaign.status != 'REMOVED'
    `.trim();

    const results = await agent.googleAds.query(query) as Array<{
      results?: Array<Record<string, any>>;
    }>;

    for (const batch of results) {
      for (const row of batch.results ?? []) {
        const name = String(row.campaign?.name ?? "");
        const id = String(row.campaign?.id ?? "");
        if (name) map.set(name.toLowerCase(), id);
      }
    }
  } catch (err) {
    console.warn(`[batch] Existing campaign check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

function deriveDatePrefix(event: EventData): string {
  const start = event.startDate ?? new Date().toISOString();
  const d = new Date(start);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function deriveShortName(event: EventData): string {
  const name = event.titleNl ?? event.titleFr ?? "Event";
  return name
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("")
    .slice(0, 20);
}

function normalizeBrandName(brand: string): string {
  return brand
    .replace(/&/g, "")
    .replace(/\s+/g, "")
    .replace(/[^a-zA-Z0-9]/g, "");
}
