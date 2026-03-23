/**
 * Fetch upcoming/active events and brands from admin.shoppingeventvip.be (Directus).
 * Provides rich context for the campaign wizard.
 */

const DIRECTUS_URL = process.env.WEBSITE_COLLAB_DIRECTUS_URL ?? "https://admin.shoppingeventvip.be";
const DIRECTUS_TOKEN = process.env.WEBSITE_COLLAB_DIRECTUS_TOKEN ?? "";

interface EventDate {
  date: string;
  startTime: string;
  endTime: string;
  capacity: number;
  capacityUsed: number;
  type: string;
}

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
  dates: EventDate[];
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
  const fields = [
    "id", "type", "status", "url", "start_date", "expiration_date",
    "event_translations.title", "event_translations.languages_id",
    "event_translations.date", "event_translations.slug",
    "brands.brand_id.id", "brands.brand_id.name",
    "dates.date", "dates.start_time", "dates.end_time",
    "dates.capacity", "dates.capacity_used", "dates.type",
  ].join(",");

  const events = await directusFetch<Array<Record<string, any>>>(
    `/items/event?filter=${filter}&sort=-start_date&limit=20&fields=${fields}`,
  );

  return events.map((e) => {
    const translations = (e.event_translations ?? []) as Array<Record<string, string>>;
    const nl = translations.find((t) => t.languages_id?.startsWith("nl")) ?? {};
    const fr = translations.find((t) => t.languages_id?.startsWith("fr")) ?? {};

    // Extract brand names from deep relation
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
    const typeIcon = e.type === "online" ? "online" : "physical";

    // Show specific dates if available
    let dateDetail = "";
    if (e.dates.length > 0) {
      const uniqueDates = [...new Set(e.dates.map((d) => d.date))];
      dateDetail = ` (${uniqueDates.length} days, ${e.dates.length} slots)`;
    }

    lines.push(`  [${typeIcon}] *${e.titleNl}*${e.titleFr && e.titleFr !== e.titleNl ? ` / ${e.titleFr}` : ""}`);
    lines.push(`    ${brands} | ${dates}${dateDetail}${e.url ? ` | ${e.url}` : ""}`);
  }

  lines.push("", 'Pick one: `event [name]` to use it as campaign source');

  return lines.join("\n");
}

/**
 * Build AI context from event data — used by the wizard's AI recommendations.
 */
export function eventToAiContext(event: EventData): string {
  // Format specific dates
  let datesInfo = "";
  if (event.dates.length > 0) {
    const uniqueDates = [...new Set(event.dates.map((d) => d.date))];
    const formattedDates = uniqueDates.map((d) => {
      const slots = event.dates.filter((s) => s.date === d);
      const times = slots.map((s) => `${s.startTime.slice(0, 5)}-${s.endTime.slice(0, 5)}`).join(", ");
      const totalCapacity = slots.reduce((s, sl) => s + sl.capacity, 0);
      const totalUsed = slots.reduce((s, sl) => s + sl.capacityUsed, 0);
      return `  ${d}: ${times} (capacity: ${totalUsed}/${totalCapacity})`;
    });
    datesInfo = `\nSpecific event dates and time slots:\n${formattedDates.join("\n")}`;
    datesInfo += `\nTotal capacity remaining: ${event.dates.reduce((s, d) => s + (d.capacity - d.capacityUsed), 0)}`;
  }

  return `
Event: "${event.titleNl}" (FR: "${event.titleFr}")
Type: ${event.type}
Brands: ${event.brands.join(", ") || "not specified"}
Overall period: ${event.startDate?.split("T")[0] ?? "?"} to ${event.endDate?.split("T")[0] ?? "?"}
Date text (NL): ${event.dateTextNl ?? "not set"}
Date text (FR): ${event.dateTextFr ?? "not set"}${datesInfo}
Landing page: ${event.url ?? "https://www.shoppingeventvip.be"}
Slug (NL): ${event.slugNl ?? "not set"}
Slug (FR): ${event.slugFr ?? "not set"}

This is a ${event.type === "online" ? "online sale" : "physical sale event"} for Shopping Event VIP, a Belgian fashion outlet platform.
The campaign should promote this specific event/brand sale.
${event.type === "physical" ? "For physical events: include dates, location hints, and urgency (limited capacity/time slots) in ad copy." : "For online sales: include the sale end date and urgency in ad copy."}
${event.dates.length > 0 ? `IMPORTANT: Use the specific event dates in headlines and descriptions. The dates are crucial for urgency.` : ""}
`.trim();
}

/**
 * Check if event source is configured (token available).
 */
export function isEventSourceConfigured(): boolean {
  return DIRECTUS_TOKEN.length > 0;
}
