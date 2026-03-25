/**
 * AI-powered campaign recommendations using Claude.
 * Generates bilingual ad copy, keyword suggestions, budget & targeting advice.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { CampaignStructure } from "./campaign-analyzer.js";

const anthropic = new Anthropic();

export interface WizardRecommendations {
  campaignName: string;
  budget: {
    dailyEuros: number;
    reasoning: string;
  };
  adCopy: {
    nl: { headlines: string[]; descriptions: string[] };
    fr: { headlines: string[]; descriptions: string[] };
  };
  keywords: Array<{
    text: string;
    matchType: "EXACT" | "PHRASE" | "BROAD";
    group: string;
  }>;
  targeting: {
    locations: string[];
    reasoning: string;
  };
  finalUrl: string;
  path1: string;
  path2: string;
  endDate?: string;
}

/**
 * Generate campaign recommendations based on source campaign or user context.
 */
export async function generateRecommendations(opts: {
  source?: CampaignStructure;
  brandOrProduct?: string;
  campaignType?: string;
  userNotes?: string;
}): Promise<WizardRecommendations> {
  const { source, brandOrProduct, userNotes } = opts;

  let context = "";
  if (source) {
    const keywords = source.adGroups
      .flatMap((ag) => ag.keywords)
      .filter((k) => k.status === "ENABLED")
      .map((k) => `"${k.text}" [${k.matchType}]${k.qualityScore ? ` QS:${k.qualityScore}` : ""}`)
      .slice(0, 30);

    const existingHeadlines = source.adGroups
      .flatMap((ag) => ag.ads)
      .flatMap((ad) => ad.headlines)
      .slice(0, 15);

    const existingDescriptions = source.adGroups
      .flatMap((ag) => ag.ads)
      .flatMap((ad) => ad.descriptions)
      .slice(0, 4);

    const existingUrls = source.adGroups
      .flatMap((ag) => ag.ads)
      .flatMap((ad) => ad.finalUrls)
      .filter(Boolean);

    const existingPaths = source.adGroups
      .flatMap((ag) => ag.ads)
      .map((ad) => [ad.path1, ad.path2].filter(Boolean).join("/"))
      .filter(Boolean);

    context = `
Source campaign: "${source.name}"
Type: ${source.type}
Budget: €${source.budget.daily.toFixed(2)}/day
Bidding: ${source.bidding.strategy}
Locations: ${source.locations.join(", ")}
Existing keywords (${keywords.length}): ${keywords.join(", ")}
Existing headlines: ${existingHeadlines.map((h) => `"${h}"`).join(", ")}
Existing descriptions: ${existingDescriptions.map((d) => `"${d}"`).join(", ")}
Existing landing pages: ${existingUrls.map((u) => `"${u}"`).join(", ") || "none found"}
Existing URL paths: ${existingPaths.join(", ") || "none"}
`;
  } else if (brandOrProduct) {
    context = `Brand/Product: ${brandOrProduct}`;
  }

  if (userNotes) {
    context += `\nUser notes: ${userNotes}`;
  }

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `You are a Google Ads specialist. Your job is to create campaign recommendations based on the context provided below. Analyze the source data carefully and create relevant, high-quality campaigns.

${context}

Generate a complete campaign recommendation as JSON. Requirements:
- campaignName: descriptive name with date prefix (YYMMDD format, today is ${new Date().toISOString().split("T")[0]}). Derive the brand/product name from the context.
- budget: daily budget in euros with reasoning (consider the source if cloning, or recommend based on industry/product)
- adCopy: bilingual (NL + FR) responsive search ads tailored to the brand/product
  - 15 headlines each language (max 30 chars STRICT — count carefully, this is critical)
  - 4 descriptions each language (max 90 chars STRICT)
  - Headlines should include: brand/product name, USPs, CTAs, seasonal hooks
  - ${source ? "IMPORTANT: Adapt and improve the existing headlines/descriptions from the source campaign. Keep what works well, update dates and seasonal references, fix any issues. Do NOT discard them and start from scratch." : "Derive the brand voice and USPs from the user context."}
  - Mix pinnable brand headlines with dynamic benefit headlines
  - If event dates are provided, include them in headlines (e.g. "27 & 28 maart" or "17-20 mei")
- keywords: 15-25 keywords with match types and thematic groups (branded, generic, competitor, long-tail). ${source ? "Keep the best-performing source keywords and add new relevant ones." : "Research relevant keywords."}
- targeting: location codes (e.g. "BE", "NL") and reasoning based on context
- finalUrl: landing page URL (derive from source ads or event URL if available)
- path1, path2: display URL paths (max 15 chars each, relevant to brand/product)
- endDate: campaign end date in YYYY-MM-DD format. If event dates are provided, set this to the day after the last event day. Otherwise omit.

Respond with ONLY valid JSON matching this structure:
{
  "campaignName": "string",
  "budget": { "dailyEuros": number, "reasoning": "string" },
  "adCopy": {
    "nl": { "headlines": ["string"], "descriptions": ["string"] },
    "fr": { "headlines": ["string"], "descriptions": ["string"] }
  },
  "keywords": [{ "text": "string", "matchType": "EXACT|PHRASE|BROAD", "group": "string" }],
  "targeting": { "locations": ["BE"], "reasoning": "string" },
  "finalUrl": "string",
  "path1": "string",
  "path2": "string",
  "endDate": "string or null"
}`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Failed to parse AI recommendations — no JSON found in response");
  }

  const parsed = JSON.parse(jsonMatch[0]) as WizardRecommendations;

  // Validate headline/description lengths
  for (const lang of ["nl", "fr"] as const) {
    parsed.adCopy[lang].headlines = parsed.adCopy[lang].headlines
      .filter((h) => h.length <= 30)
      .slice(0, 15);
    parsed.adCopy[lang].descriptions = parsed.adCopy[lang].descriptions
      .filter((d) => d.length <= 90)
      .slice(0, 4);
  }

  return parsed;
}

/** Format recommendations as a Slack message */
export function formatRecommendations(rec: WizardRecommendations): string {
  const lines: string[] = [
    `*Campaign Recommendation: "${rec.campaignName}"*`,
    "",
    `*Budget:* €${rec.budget.dailyEuros}/day — ${rec.budget.reasoning}`,
    `*Landing Page:* ${rec.finalUrl}`,
    `*Targeting:* ${rec.targeting.locations.join(", ")} — ${rec.targeting.reasoning}`,
    ...(rec.endDate ? [`*End Date:* ${rec.endDate}`] : []),
    "",
    "*Ad Copy (Dutch):*",
    `  Headlines (${rec.adCopy.nl.headlines.length}):`,
  ];

  for (const h of rec.adCopy.nl.headlines) {
    lines.push(`    "${h}" (${h.length}/30)`);
  }

  lines.push(`  Descriptions (${rec.adCopy.nl.descriptions.length}):`);
  for (const d of rec.adCopy.nl.descriptions) {
    lines.push(`    "${d}" (${d.length}/90)`);
  }

  lines.push("", "*Ad Copy (French):*", `  Headlines (${rec.adCopy.fr.headlines.length}):`);
  for (const h of rec.adCopy.fr.headlines) {
    lines.push(`    "${h}" (${h.length}/30)`);
  }

  lines.push(`  Descriptions (${rec.adCopy.fr.descriptions.length}):`);
  for (const d of rec.adCopy.fr.descriptions) {
    lines.push(`    "${d}" (${d.length}/90)`);
  }

  // Keywords grouped
  const groups = new Map<string, typeof rec.keywords>();
  for (const kw of rec.keywords) {
    const existing = groups.get(kw.group) ?? [];
    existing.push(kw);
    groups.set(kw.group, existing);
  }

  lines.push("", `*Keywords (${rec.keywords.length}):*`);
  for (const [group, kws] of groups) {
    lines.push(`  _${group}:_`);
    for (const kw of kws) {
      lines.push(`    \`${kw.text}\` [${kw.matchType}]`);
    }
  }

  lines.push(
    "",
    "_You can modify:_ `adjust budget to €X` | `end date YYYY-MM-DD` | `url https://...` | `path shop/sale` | `target BE, NL` | `rename to ...` | `add/remove keyword ...` | `regenerate copy`",
    "_Actions:_ `confirm` (API) | `export csv` (Google Ads Editor) | `show` | `cancel`",
  );

  return lines.join("\n");
}
