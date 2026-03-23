/**
 * Fetch upcoming/active events and brands from admin.shoppingeventvip.be (Directus).
 * Provides rich context for the campaign wizard.
 */

const DIRECTUS_URL = process.env.WEBSITE_COLLAB_DIRECTUS_URL ?? "https://admin.shoppingeventvip.be";
const DIRECTUS_TOKEN = process.env.WEBSITE_COLLAB_DIRECTUS_TOKEN ?? "";

interface EventData {
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
}

interface BrandData {
  id: string;
  name: string;
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

/**
 * Fetch active and upcoming events with brand info.
 */
export async function getActiveEvents(): Promise<EventData[]> {
  const now = new Date().toISOString();

  const filter = encodeURIComponent(JSON.stringify({
    status: { _eq: "published" },
    expiration_date: { _gte: now },
  }));
  const fields = "id,type,status,url,start_date,expiration_date,event_translations.title,event_translations.languages_id,event_translations.date,event_translations.slug,brands";

  const events = await directusFetch<Array<Record<string, any>>>(
    `/items/event?filter=${filter}&sort=-start_date&limit=20&fields=${fields}`,
  );

  // Fetch all brand names — use JSON filter to avoid URL length issues
  const brandIds = [...new Set(events.flatMap((e) => e.brands ?? []))].map(String);
  const brandMap = new Map<string, string>();

  if (brandIds.length > 0) {
    try {
      const filter = encodeURIComponent(JSON.stringify({ id: { _in: brandIds } }));
      const brands = await directusFetch<Array<{ id: string; name: string }>>(
        `/items/brand?filter=${filter}&fields=id,name&limit=100`,
      );
      for (const b of brands) {
        brandMap.set(String(b.id), b.name);
      }
    } catch {
      // Brand lookup failed — continue without brand names
    }
  }

  return events.map((e) => {
    const translations = (e.event_translations ?? []) as Array<Record<string, string>>;
    const nl = translations.find((t) => t.languages_id?.startsWith("nl")) ?? {};
    const fr = translations.find((t) => t.languages_id?.startsWith("fr")) ?? {};

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
      brands: (e.brands ?? []).map((id: string | number) => brandMap.get(String(id)) ?? String(id)),
    };
  });
}

/**
 * Search for a specific event by brand name or event title.
 */
export async function findEvent(query: string): Promise<EventData | null> {
  const events = await getActiveEvents();
  const lower = query.toLowerCase();

  // Try exact match on brand or title
  const match = events.find(
    (e) =>
      e.titleNl.toLowerCase().includes(lower) ||
      e.titleFr.toLowerCase().includes(lower) ||
      e.brands.some((b) => b.toLowerCase().includes(lower)),
  );

  return match ?? null;
}

/**
 * Format active events as a Slack list for the wizard.
 */
export function formatEventList(events: EventData[]): string {
  if (events.length === 0) {
    return "No active events found.";
  }

  const lines: string[] = [
    `*Active Events (${events.length}):*`,
    "",
  ];

  for (const e of events) {
    const brands = e.brands.length > 0 ? e.brands.join(", ") : "no brand";
    const dates = e.dateTextNl ?? `${e.startDate?.split("T")[0] ?? "?"} → ${e.endDate?.split("T")[0] ?? "?"}`;
    const typeIcon = e.type === "online" ? "🌐" : "📍";

    lines.push(`  ${typeIcon} *${e.titleNl}*${e.titleFr && e.titleFr !== e.titleNl ? ` / ${e.titleFr}` : ""}`);
    lines.push(`    ${brands} | ${dates}${e.url ? ` | ${e.url}` : ""}`);
  }

  lines.push("", 'Pick one: `event [name]` to use it as campaign source');

  return lines.join("\n");
}

/**
 * Build AI context from event data — used by the wizard's AI recommendations.
 */
export function eventToAiContext(event: EventData): string {
  return `
Event: "${event.titleNl}" (FR: "${event.titleFr}")
Type: ${event.type}
Brands: ${event.brands.join(", ") || "not specified"}
Dates: ${event.startDate?.split("T")[0] ?? "?"} to ${event.endDate?.split("T")[0] ?? "?"}
Date text (NL): ${event.dateTextNl ?? "not set"}
Date text (FR): ${event.dateTextFr ?? "not set"}
Landing page: ${event.url ?? "https://www.shoppingeventvip.be"}
Slug (NL): ${event.slugNl ?? "not set"}
Slug (FR): ${event.slugFr ?? "not set"}

This is a ${event.type === "online" ? "online sale" : "physical sale event"} for Shopping Event VIP, a Belgian fashion outlet platform.
The campaign should promote this specific event/brand sale with its dates and landing page.
`.trim();
}

/**
 * Check if event source is configured (token available).
 */
export function isEventSourceConfigured(): boolean {
  return DIRECTUS_TOKEN.length > 0;
}
