/**
 * Fetch upcoming/active events and brands from admin.shoppingeventvip.be (Directus).
 * Provides rich context for the campaign wizard.
 */

const DIRECTUS_URL = process.env.WEBSITE_COLLAB_DIRECTUS_URL ?? "https://admin.shoppingeventvip.be";
const DIRECTUS_TOKEN = process.env.WEBSITE_COLLAB_DIRECTUS_TOKEN ?? "";

const EVENT_FIELDS = [
  "id", "type", "status", "url", "start_date", "expiration_date",
  "event_translations.title", "event_translations.languages_id",
  "event_translations.date", "event_translations.slug",
  "brands.brand_id.id", "brands.brand_id.name",
  "dates.date", "dates.start_time", "dates.end_time",
  "dates.capacity", "dates.capacity_used", "dates.type",
].join(",");

interface EventDate {
  date: string;
  startTime: string;
  endTime: string;
  capacity: number;
  capacityUsed: number;
  type: string;
}

export interface EventData {
  id: string;
  type: "online" | "physical";
  status: string;
  url: string | null;
  startDate: string | null;
  endDate: string | null;
  titleNl: string;
  titleFr: string;
  slugNl: string | null;
  slugFr: string | null;
  dateTextNl: string | null;
  dateTextFr: string | null;
  brands: string[];
  dates: EventDate[];
}

/** Strip accents for fuzzy matching: "Méro" → "Mero" */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Case-insensitive, accent-insensitive includes */
function fuzzyIncludes(haystack: string, needle: string): boolean {
  return stripAccents(haystack.toLowerCase()).includes(stripAccents(needle.toLowerCase()));
}

async function directusFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${DIRECTUS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Directus ${path}: ${res.status}`);
  const body = await res.json() as { data: T };
  return body.data;
}

function parseEvent(e: Record<string, any>): EventData {
  const translations = (e.event_translations ?? []) as Array<Record<string, string>>;
  const nl = translations.find((t) => t.languages_id?.startsWith("nl")) ?? {};
  const fr = translations.find((t) => t.languages_id?.startsWith("fr")) ?? {};

  const brandNames: string[] = [];
  for (const b of e.brands ?? []) {
    const name = b?.brand_id?.name;
    if (name) brandNames.push(String(name));
  }

  return {
    id: String(e.id),
    type: e.type ?? "online",
    status: e.status ?? "published",
    url: e.url ?? null,
    startDate: e.start_date ?? null,
    endDate: e.expiration_date ?? null,
    titleNl: nl.title ?? "",
    titleFr: fr.title ?? "",
    slugNl: nl.slug ?? null,
    slugFr: fr.slug ?? null,
    dateTextNl: nl.date ?? null,
    dateTextFr: fr.date ?? null,
    brands: brandNames,
    dates: ((e.dates ?? []) as Array<Record<string, any>>)
      .map((d) => ({
        date: String(d.date ?? ""),
        startTime: String(d.start_time ?? ""),
        endTime: String(d.end_time ?? ""),
        capacity: Number(d.capacity ?? 0),
        capacityUsed: Number(d.capacity_used ?? 0),
        type: String(d.type ?? "free"),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Fetch active and upcoming events.
 * Includes events where start_date or expiration_date is in the future.
 */
export async function getActiveEvents(): Promise<EventData[]> {
  const today = new Date().toISOString().split("T")[0];

  // Use _or to catch events with future start OR future expiration
  const filter = encodeURIComponent(JSON.stringify({
    status: { _eq: "published" },
    _or: [
      { start_date: { _gte: today } },
      { expiration_date: { _gte: today } },
    ],
  }));

  const events = await directusFetch<Array<Record<string, any>>>(
    `/items/event?filter=${filter}&sort=-start_date&limit=30&fields=${EVENT_FIELDS}`,
  );

  return events.map(parseEvent);
}

/**
 * Find the latest event matching a brand name or title.
 * Uses Directus search first, then falls back to fetching active events.
 */
export async function findEvent(query: string): Promise<EventData | null> {
  const lower = query.toLowerCase().trim();

  // Strategy 1: Direct search via Directus (searches across all text fields)
  try {
    const searchResults = await directusFetch<Array<Record<string, any>>>(
      `/items/event?search=${encodeURIComponent(query)}&sort=-start_date&limit=10&fields=${EVENT_FIELDS}`,
    );

    if (searchResults.length > 0) {
      const parsed = searchResults.map(parseEvent);
      // Prefer the latest published event
      const match = parsed.find((e) => e.status === "published") ?? parsed[0];
      if (match) return match;
    }
  } catch {
    // Search may fail on some Directus configs, fall through
  }

  // Strategy 2: Fetch active events and filter client-side
  const events = await getActiveEvents();
  const match = events.find(
    (e) =>
      fuzzyIncludes(e.titleNl, lower) ||
      fuzzyIncludes(e.titleFr, lower) ||
      e.brands.some((b) => fuzzyIncludes(b, lower)),
  );
  if (match) return match;

  // Strategy 3: Fetch ALL physical events (no date filter) and match by title/brand
  // This catches events that may not have start_date set yet
  try {
    const allPhysical = await directusFetch<Array<Record<string, any>>>(
      `/items/event?filter=${encodeURIComponent(JSON.stringify({
        type: { _eq: "physical" },
      }))}&sort=-start_date&limit=50&fields=${EVENT_FIELDS}`,
    );

    const parsed = allPhysical.map(parseEvent);
    return parsed.find(
      (e) =>
        e.titleNl.toLowerCase().includes(lower) ||
        e.titleFr.toLowerCase().includes(lower) ||
        e.brands.some((b) => b.toLowerCase().includes(lower)),
    ) ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract a brand name from a Google Ads campaign name.
 * Campaign naming convention: YYMMDD_BrandName_Lang or BrandName_Campaign
 * Examples:
 *   "230428_MarieMero_NL" → "MarieMero"
 *   "260309_RiverWoods_NL" → "RiverWoods"
 *   "Xandres Summer Sale" → "Xandres"
 */
export function extractBrandFromCampaignName(campaignName: string): string | null {
  // Pattern: YYMMDD_BrandName_Lang
  const datePattern = /^\d{6}_([^_]+)/;
  const dateMatch = campaignName.match(datePattern);
  if (dateMatch) return dateMatch[1];

  // Pattern: BrandName_anything
  const underscoreMatch = campaignName.match(/^([A-Z][a-zA-ZÀ-ÿ]+)/);
  if (underscoreMatch) return underscoreMatch[1];

  return null;
}

/**
 * Find the latest event for a brand, auto-matching from a campaign name.
 * Normalizes brand names (MarieMero → marie mero, RiverWoods → river woods).
 */
export async function findEventForBrand(brandOrCampaignName: string): Promise<EventData | null> {
  // Try extracting brand from campaign name format
  const brand = extractBrandFromCampaignName(brandOrCampaignName) ?? brandOrCampaignName;

  // Normalize: "MarieMero" → "marie mero", "RiverWoods" → "river woods"
  const normalized = brand
    .replace(/([a-z])([A-Z])/g, "$1 $2")  // camelCase → spaces
    .replace(/[_-]/g, " ")                  // underscores/hyphens → spaces
    .trim();

  return findEvent(normalized);
}

/**
 * Format active events as a Slack list for the wizard.
 */
export function formatEventList(events: EventData[]): string {
  if (events.length === 0) {
    return "No active events found.";
  }

  const lines: string[] = [
    `*Active & Upcoming Events (${events.length}):*`,
    "",
  ];

  for (const e of events) {
    const brands = e.brands.length > 0 ? e.brands.join(", ") : "no brand";
    const dates = e.dateTextNl ?? `${e.startDate?.split("T")[0] ?? "?"} → ${e.endDate?.split("T")[0] ?? "?"}`;
    const typeIcon = e.type === "online" ? "online" : "physical";

    let dateDetail = "";
    if (e.dates.length > 0) {
      const uniqueDates = [...new Set(e.dates.map((d) => d.date))];
      dateDetail = ` (${uniqueDates.length} days)`;
    }

    lines.push(`  [${typeIcon}] *${e.titleNl}*${e.titleFr && e.titleFr !== e.titleNl ? ` / ${e.titleFr}` : ""}`);
    lines.push(`    ${brands} | ${dates}${dateDetail}${e.url ? ` | ${e.url}` : ""}`);
  }

  lines.push("", 'Pick one: `event [name]` to use it as campaign source');

  return lines.join("\n");
}

/**
 * Build concise AI context from event data.
 * Optimized for token efficiency — only includes what Claude needs for ad copy.
 */
export function eventToAiContext(event: EventData): string {
  // Format dates concisely: "27 & 28 maart" or "17 mei t/m 20 mei"
  let dateStr = event.dateTextNl ?? "";
  if (!dateStr && event.dates.length > 0) {
    const uniqueDates = [...new Set(event.dates.map((d) => d.date))].sort();
    dateStr = uniqueDates.join(", ");
  }
  if (!dateStr && event.startDate) {
    dateStr = `${event.startDate.split("T")[0]} → ${event.endDate?.split("T")[0] ?? "?"}`;
  }

  // Opening hours summary (not individual slots)
  let hoursStr = "";
  if (event.dates.length > 0) {
    const times = event.dates.map((d) => d.startTime.slice(0, 5));
    const endTimes = event.dates.map((d) => d.endTime.slice(0, 5));
    const earliest = times.sort()[0];
    const latest = endTimes.sort().reverse()[0];
    hoursStr = `${earliest}-${latest}`;
  }

  const lines = [
    `Event: "${event.titleNl}"`,
    `Type: ${event.type === "physical" ? "physical sale event in Aalter" : "online sale"}`,
    `Brands: ${event.brands.join(", ") || event.titleNl}`,
    `Dates: ${dateStr}${hoursStr ? ` (${hoursStr})` : ""}`,
    `Landing page: ${event.url ?? "https://www.shoppingeventvip.be"}`,
  ];

  if (event.dateTextFr) {
    lines.push(`Dates (FR): ${event.dateTextFr}`);
  }

  // Add urgency cues based on type
  if (event.type === "physical") {
    lines.push(
      "",
      "IMPORTANT: Use the exact dates in headlines. Include location (Aalter) and urgency (beperkte plaatsen / places limitées). Registration required.",
    );
  } else {
    lines.push("", "Include sale end date and urgency in ad copy.");
  }

  return lines.join("\n");
}

/**
 * Check if event source is configured (token available).
 */
export function isEventSourceConfigured(): boolean {
  return DIRECTUS_TOKEN.length > 0;
}

/**
 * Extract event ID from an admin.shoppingeventvip.be URL.
 * Supports: /items/event/123, /admin/content/event/123, or just a numeric ID.
 */
export function extractEventIdFromUrl(input: string): string | null {
  // Direct numeric ID
  if (/^\d+$/.test(input.trim())) return input.trim();

  // URL patterns: /items/event/123 or /admin/content/event/123
  const match = input.match(/\/event\/(\d+)/);
  if (match) return match[1];

  return null;
}

/**
 * Fetch a single event by its numeric ID from Directus.
 */
export async function getEventById(id: string): Promise<EventData | null> {
  try {
    const event = await directusFetch<Record<string, any>>(
      `/items/event/${id}?fields=${EVENT_FIELDS}`,
    );
    return parseEvent(event);
  } catch {
    return null;
  }
}
