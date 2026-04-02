/**
 * Batch campaign creation handler.
 * Creates multiple Google Ads Search campaigns for all brands at an event.
 * Separate campaigns per language (NL + FR) for proper audience targeting.
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
import { buildCampaign } from "../tools/campaign-builder.js";
import { createCampaignAssets, generateEventSitelinks, generateEventCallouts } from "../tools/asset-builder.js";
import { storeAdCopy } from "../tools/ad-memory.js";
import { createRedTrackCampaign, isRedTrackConfigured } from "../tools/redtrack.js";
import { searchBrandContext } from "../tools/brand-knowledge.js";
import type { CampaignConfig, GoogleCampaignType } from "../types.js";
import { sanitizeGaqlString } from "../tools/gaql.js";

export interface BatchRequest {
  eventId: string;
  brands?: string[];
  budget?: number;      // total per brand (split across NL + FR)
  radius?: number;
  execute?: boolean;
  eventShortName?: string;
}

interface CampaignPlan {
  brand: string;
  lang: "nl" | "fr";
  campaignName: string;
  keywords: Array<{ text: string; matchType: string; volume?: number; competition?: string }>;
  totalVolume: number;
  estimatedBudget: number;
  sampleHeadlines: string[];
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
  campaigns: CampaignPlan[];
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
  created: Array<{ brand: string; lang: string; campaignName: string; resourceName: string }>;
  skipped: Array<{ brand: string; lang: string; reason: string }>;
  failed: Array<{ brand: string; lang: string; error: string }>;
}

type BatchResponse = BatchPreviewResponse | BatchExecuteResponse | { ok: false; error: string };

import { languageConstant, LANGUAGE_CONSTANTS } from "../types.js";

// Google Ads language targeting constants
const LANG_CONSTANTS: Record<string, string> = {
  nl: languageConstant("nl"),
  fr: languageConstant("fr"),
};

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

  const totalBudgetPerBrand = request.budget ?? 20;
  const budgetPerLang = Math.round(totalBudgetPerBrand / 2);
  const radius = request.radius ?? 50;
  const shortName = request.eventShortName ?? deriveShortName(event);
  const datePrefix = deriveDatePrefix(event);

  // Check existing campaigns
  const existingMap = await findExistingCampaigns(agent, datePrefix, shortName);

  console.log(`[batch] Planning ${brands.length} brands x 2 languages = ${brands.length * 2} campaigns for "${event.titleNl ?? event.titleFr}"`);

  const plans: CampaignPlan[] = [];

  for (const brand of brands) {
    // Keyword research once per brand (shared across NL + FR)
    const keywords = await researchBrandKeywords(agent, brand, shortName, event);
    const totalVolume = keywords.reduce((s, k) => s + (k.volume ?? 0), 0);

    for (const lang of ["nl", "fr"] as const) {
      const campaignName = `${datePrefix}_${normalizeBrandName(brand)}_${shortName}_${lang.toUpperCase()}`;

      if (existingMap.has(campaignName.toLowerCase())) {
        plans.push({
          brand,
          lang,
          campaignName,
          keywords: [],
          totalVolume: 0,
          estimatedBudget: budgetPerLang,
          sampleHeadlines: [],
          status: "EXISTS",
          existingCampaignId: existingMap.get(campaignName.toLowerCase()),
        });
        continue;
      }

      // Filter keywords by language relevance
      const langKeywords = filterKeywordsByLang(keywords, lang);

      plans.push({
        brand,
        lang,
        campaignName,
        keywords: langKeywords,
        totalVolume,
        estimatedBudget: budgetPerLang,
        sampleHeadlines: generateSampleHeadlines(brand, event, lang),
        status: "NEW",
      });
    }
  }

  // Preview mode
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
        totalDailyBudget: newPlans.length * budgetPerLang,
        totalKeywords: newPlans.reduce((s, p) => s + p.keywords.length, 0),
      },
    };
  }

  // Execute mode
  console.log(`[batch] Executing: creating ${plans.filter((p) => p.status === "NEW").length} campaigns`);

  const created: BatchExecuteResponse["created"] = [];
  const skipped: BatchExecuteResponse["skipped"] = [];
  const failed: BatchExecuteResponse["failed"] = [];

  // Generate AI copy once per brand (reused for both NL and FR campaigns)
  const copyCache = new Map<string, Awaited<ReturnType<typeof generateRecommendations>>>();

  for (const plan of plans) {
    if (plan.status === "EXISTS") {
      skipped.push({ brand: plan.brand, lang: plan.lang, reason: `Campaign ${plan.campaignName} already exists` });
      continue;
    }

    try {
      // Get or generate ad copy for this brand
      let rec = copyCache.get(plan.brand);
      if (!rec) {
        let ragContext = "";
        try {
          const brandCtx = await searchBrandContext(plan.brand, "physical", "search");
          if (brandCtx) ragContext = brandCtx;
        } catch { /* non-fatal */ }

        rec = await generateRecommendations({
          brandOrProduct: buildBrandContext(plan.brand, event),
          campaignType: "search",
          ragContext,
        });
        copyCache.set(plan.brand, rec);
      }

      const result = await createLangCampaign(agent, plan, event, rec, budgetPerLang, radius);
      created.push(result);
      console.log(`[batch] Created: ${plan.campaignName} (${result.resourceName})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ brand: plan.brand, lang: plan.lang, error: msg });
      console.error(`[batch] Failed: ${plan.campaignName} — ${msg}`);
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
): Promise<Array<{ text: string; matchType: string; volume?: number; competition?: string; lang?: "nl" | "fr" | "both" }>> {
  const city = extractCity(event);

  // Base keywords — shared across both languages
  const baseKeywords: Array<{ text: string; matchType: string; lang?: "nl" | "fr" | "both" }> = [
    { text: `${brand} outlet`, matchType: "EXACT", lang: "both" },
    { text: `${brand} private sale`, matchType: "EXACT", lang: "both" },
    { text: `${brand} outlet ${city}`, matchType: "PHRASE", lang: "both" },
    { text: `${eventShortName} ${brand}`, matchType: "PHRASE", lang: "both" },
    { text: brand, matchType: "BROAD", lang: "both" },
    // NL-specific
    { text: `${brand} solden`, matchType: "PHRASE", lang: "nl" },
    { text: `${brand} korting`, matchType: "PHRASE", lang: "nl" },
    { text: `${brand} uitverkoop`, matchType: "PHRASE", lang: "nl" },
    // FR-specific
    { text: `${brand} soldes`, matchType: "PHRASE", lang: "fr" },
    { text: `${brand} vente privée`, matchType: "PHRASE", lang: "fr" },
    { text: `${brand} réduction`, matchType: "PHRASE", lang: "fr" },
  ];

  // Enrich with Keyword Planner data
  try {
    const seedsNl = [`${brand} outlet`, `${brand} private sale`, `${brand} solden`, `${brand} korting`];
    const seedsFr = [`${brand} outlet`, `${brand} vente privée`, `${brand} soldes`];

    const [nlIdeas, frIdeas] = await Promise.allSettled([
      researchKeywords(agent.googleAds, { seedKeywords: seedsNl, language: LANGUAGE_CONSTANTS.nl, limit: 20 }),
      researchKeywords(agent.googleAds, { seedKeywords: seedsFr, language: LANGUAGE_CONSTANTS.fr, limit: 15 }),
    ]);

    const volumeMap = new Map<string, KeywordIdea>();
    for (const result of [nlIdeas, frIdeas]) {
      if (result.status === "fulfilled") {
        for (const idea of result.value) {
          volumeMap.set(idea.keyword.toLowerCase(), idea);
        }
      }
    }

    // Enrich base keywords
    for (const kw of baseKeywords) {
      const idea = volumeMap.get(kw.text.toLowerCase());
      if (idea) {
        (kw as any).volume = idea.avgMonthlySearches;
        (kw as any).competition = idea.competition === "UNSPECIFIED" ? undefined : idea.competition;
      }
    }

    // Add top planner suggestions
    const existingTexts = new Set(baseKeywords.map((k) => k.text.toLowerCase()));
    const extras: typeof baseKeywords = [];
    const brandFirst = brand.toLowerCase().split(" ")[0];

    for (const [, idea] of volumeMap) {
      if (existingTexts.has(idea.keyword.toLowerCase())) continue;
      if (idea.avgMonthlySearches < 10) continue;
      if (!idea.keyword.toLowerCase().includes(brandFirst)) continue;

      extras.push({
        text: idea.keyword,
        matchType: idea.competition === "HIGH" ? "EXACT" : "PHRASE",
        lang: "both",
      });
      if (extras.length >= 6) break;
    }

    return [...baseKeywords, ...extras] as any;
  } catch (err) {
    console.warn(`[batch] Keyword Planner failed for ${brand}: ${err instanceof Error ? err.message : String(err)}`);
    return baseKeywords as any;
  }
}

/**
 * Filter keywords relevant to a specific language.
 */
function filterKeywordsByLang(
  keywords: Array<{ text: string; matchType: string; volume?: number; competition?: string; lang?: string }>,
  lang: "nl" | "fr",
): CampaignPlan["keywords"] {
  return keywords
    .filter((k) => !k.lang || k.lang === "both" || k.lang === lang)
    .map(({ text, matchType, volume, competition }) => ({ text, matchType, volume, competition }));
}

// ── Campaign Creation ───────────────────────────────────────────────

async function createLangCampaign(
  agent: GoogleAdsAgent,
  plan: CampaignPlan,
  event: EventData,
  rec: Awaited<ReturnType<typeof generateRecommendations>>,
  budget: number,
  radius: number,
): Promise<{ brand: string; lang: string; campaignName: string; resourceName: string }> {
  const lang = plan.lang;
  const slug = (event as any).slug ?? "le-salon-vip";
  const eventUrl = lang === "fr"
    ? `https://www.shoppingeventvip.be/fr/event/${slug}`
    : `https://www.shoppingeventvip.be/nl/event/${slug}`;

  const rawAdCopy = rec.adCopy?.[lang] ?? rec.adCopy?.nl;
  const adCopy = (rawAdCopy?.headlines?.length >= 3 && rawAdCopy?.descriptions?.length >= 2)
    ? rawAdCopy
    : fallbackAdCopy(plan.brand, lang as "nl" | "fr");
  const endDate = event.suggestedCampaignEnd ?? event.endDate?.split("T")[0];

  // RedTrack (one per brand+lang)
  let trackingTemplate: string | undefined;
  if (isRedTrackConfigured()) {
    try {
      const rt = await createRedTrackCampaign({ brand: plan.brand, eventType: "physical", landingPageUrl: eventUrl });
      if (rt) trackingTemplate = rt.trackingTemplate;
    } catch { /* non-fatal */ }
  }

  const config: CampaignConfig = {
    type: "search" as GoogleCampaignType,
    name: plan.campaignName,
    dailyBudgetMicros: Math.round(budget * 1_000_000),
    locations: ["BE"],
    languages: [lang],  // Single language targeting
    startDate: new Date().toISOString().split("T")[0],
    ...(endDate && { endDate }),
    targetCountry: "BE",
    proximityRadius: radius,
    proximityAddress: event.locationText ?? "Schrijberg 189/193, Sint-Niklaas",
    proximityPostalCode: event.postalCode ?? "9111",
    keywords: plan.keywords.map((k) => ({ text: k.text, matchType: k.matchType as any })),
    adGroupName: `${plan.campaignName}`,
    responsiveSearchAd: {
      headlines: adCopy.headlines,
      descriptions: adCopy.descriptions,
      finalUrl: eventUrl,
      path1: rec.path1,
      path2: rec.path2,
    },
    ...(trackingTemplate && { trackingUrlTemplate: trackingTemplate }),
  };

  // Build campaign
  const result = await buildCampaign(agent.googleAds, config);

  // Set language targeting via campaign criterion
  try {
    const langConstant = LANG_CONSTANTS[lang];
    if (langConstant) {
      await agent.googleAds.mutateResource("campaignCriteria", [{
        create: {
          campaign: result.campaignResourceName,
          language: { language_constant: langConstant },
        },
      }]);
    }
  } catch (err) {
    console.warn(`[batch] Language targeting failed for ${plan.campaignName}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Campaign assets
  try {
    await createCampaignAssets(agent.googleAds, result.campaignResourceName, {
      sitelinks: generateEventSitelinks(eventUrl, lang as any),
      callouts: rec.callouts ?? generateEventCallouts(lang as any, true),
      brands: event.brands,
      promotionText: rec.promotionText ?? `Private Sale ${plan.brand}`,
      discountPercent: 70,
      finalUrl: eventUrl,
      eventStartDate: event.startDate?.split("T")[0],
      eventEndDate: endDate,
      language: lang as any,
      eventType: "physical",
    });
  } catch { /* non-fatal */ }

  // Store ad copy for RAG
  try {
    await storeAdCopy({
      brand: plan.brand,
      eventType: "physical",
      campaignType: "search",
      language: lang,
      headlines: adCopy.headlines,
      descriptions: adCopy.descriptions,
      finalUrl: eventUrl,
      path1: rec.path1,
      path2: rec.path2,
      keywords: plan.keywords.map((k) => ({ text: k.text, matchType: k.matchType as any })),
      campaignName: plan.campaignName,
      eventDates: (lang === "fr" ? event.dateTextFr : event.dateTextNl) ?? undefined,
    });
  } catch { /* non-fatal */ }

  return {
    brand: plan.brand,
    lang,
    campaignName: plan.campaignName,
    resourceName: result.campaignResourceName,
  };
}

/** Fallback ad copy when AI generation fails or returns incomplete data */
function fallbackAdCopy(brand: string, lang: "nl" | "fr"): { headlines: string[]; descriptions: string[] } {
  const b = brand.length > 20 ? brand.substring(0, 20) : brand;
  if (lang === "fr") {
    return {
      headlines: [
        `${b} Outlet en Ligne`,
        `Jusqu'à -70% de Remise`,
        `${b} Vente Privée`,
        `Shopping Event VIP`,
        `Offres Exclusives`,
        `${b} Soldes en Ligne`,
        `Grandes Marques Petit Prix`,
        `Achetez Maintenant`,
      ],
      descriptions: [
        `Découvrez ${b} avec des remises jusqu'à 70%. Exclusif chez Shopping Event VIP.`,
        `Marques premium à prix réduit. Achetez maintenant en ligne.`,
        `${b} outlet: stock limité, offres exclusives. Ne manquez pas!`,
      ],
    };
  }
  return {
    headlines: [
      `${b} Online Outlet`,
      `Tot -70% Korting`,
      `${b} Private Sale`,
      `Shopping Event VIP`,
      `Exclusieve Aanbiedingen`,
      `${b} Sale Online`,
      `Topmerken Lage Prijzen`,
      `Nu Online Shoppen`,
    ],
    descriptions: [
      `Ontdek ${b} met kortingen tot 70%. Exclusief bij Shopping Event VIP.`,
      `Premium merken voor een fractie van de prijs. Shop nu online.`,
      `${b} outlet: beperkte voorraad, exclusieve deals. Mis het niet!`,
    ],
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractCity(event: EventData): string {
  const loc = event.locationText ?? "";
  const cityMatch = loc.match(/\d{4}\s+([A-Za-zÀ-ÿ-]+)/);
  if (cityMatch) return cityMatch[1];
  if (event.postalCode) return event.postalCode;
  return "Sint-Niklaas";
}

function buildBrandContext(brand: string, event: EventData): string {
  const city = extractCity(event);
  const location = event.locationText ?? "Sint-Niklaas";
  const dates = event.dateTextNl ?? event.dateTextFr ?? "";
  return (
    `Create a Google Ads Search campaign for the brand "${brand}" at a private sale event.\n` +
    `Event: "${event.titleNl ?? event.titleFr}" — a physical outlet/private sale event.\n` +
    `Location: ${location}\n` +
    `City: ${city}\n` +
    `Dates: ${dates}\n` +
    `Landing page NL: https://www.shoppingeventvip.be/nl/event/${(event as any).slug ?? ""}\n` +
    `Landing page FR: https://www.shoppingeventvip.be/fr/event/${(event as any).slug ?? ""}\n\n` +
    `MANDATORY in headlines:\n` +
    `- Brand name "${brand}"\n` +
    `- "Private Sale" or "Outlet"\n` +
    `- "Le Salon VIP"\n` +
    `- City name: "${city}" (NOT the venue name)\n` +
    `- Dates (abbreviated)\n` +
    `- Urgency: "Beperkte plaatsen" (NL) / "Places limitées" (FR)\n\n` +
    `This is an exclusive outlet event with discounts up to -70% on premium brands.\n` +
    `Free parking. Registration required. Multiple time slots available.`
  );
}

function generateSampleHeadlines(brand: string, event: EventData, lang: "nl" | "fr"): string[] {
  const city = extractCity(event);
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
      WHERE campaign.name LIKE '%${sanitizeGaqlString(datePrefix)}%${sanitizeGaqlString(shortName)}%'
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
