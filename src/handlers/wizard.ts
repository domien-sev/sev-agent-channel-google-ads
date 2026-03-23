/**
 * Campaign creation wizard — multi-step conversational flow in Slack.
 *
 * Flow:
 *   1. "wizard" → ask type or clone source
 *   2. User picks type or "clone [campaign]" → analyze source / set type
 *   3. AI generates recommendations → present to user
 *   4. User can modify → "adjust budget", "regenerate copy", "add/remove keyword"
 *   5. "confirm" → create campaign (PAUSED)
 *   6. "cancel" → abort
 */
import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import type { GoogleCampaignType } from "../types.js";
import { analyzeCampaign, formatCampaignSummary } from "../tools/campaign-analyzer.js";
import type { CampaignStructure } from "../tools/campaign-analyzer.js";
import {
  generateRecommendations,
  formatRecommendations,
} from "../tools/ai-recommendations.js";
import type { WizardRecommendations } from "../tools/ai-recommendations.js";
import { buildCampaign } from "../tools/campaign-builder.js";
import { generateEditorCsv, formatCsvForSlack } from "../tools/csv-export.js";
import {
  getActiveEvents,
  findEvent,
  formatEventList,
  eventToAiContext,
  isEventSourceConfigured,
} from "../tools/event-source.js";
import type { CampaignConfig } from "../types.js";
import * as gaql from "../tools/gaql.js";

/** Wizard states */
type WizardStep = "awaiting_type" | "awaiting_context" | "analyzing" | "reviewing" | "confirmed";

interface WizardState {
  step: WizardStep;
  threadTs: string;
  channelId: string;
  userId: string;
  campaignType?: GoogleCampaignType;
  sourceStructure?: CampaignStructure;
  recommendations?: WizardRecommendations;
  createdAt: number;
}

/** TTL for wizard sessions (2 hours) */
const WIZARD_TTL_MS = 2 * 60 * 60 * 1000;

/** Active wizard sessions keyed by "channel:user" */
const sessions = new Map<string, WizardState>();

function sessionKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`;
}

function getSession(channelId: string, userId: string): WizardState | null {
  const key = sessionKey(channelId, userId);
  const session = sessions.get(key);
  if (!session) return null;
  if (Date.now() - session.createdAt > WIZARD_TTL_MS) {
    sessions.delete(key);
    return null;
  }
  return session;
}

/** Check if a message should be handled by the wizard */
export function isWizardMessage(text: string, channelId: string, userId: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower === "wizard" || lower.startsWith("campaign wizard")) return true;
  return getSession(channelId, userId) !== null;
}

/** Main wizard handler */
export async function handleWizard(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<AgentResponse> {
  const text = message.text.trim();
  const lower = text.toLowerCase();
  const key = sessionKey(message.channel_id, message.user_id);

  // Cancel
  if (lower === "cancel" || lower === "abort") {
    sessions.delete(key);
    return reply(message, "Wizard cancelled.");
  }

  // New wizard or existing session
  const existing = getSession(message.channel_id, message.user_id);

  if (!existing) {
    return startWizard(agent, message, key);
  }

  switch (existing.step) {
    case "awaiting_type":
      return handleTypeSelection(agent, message, existing, key);
    case "awaiting_context":
      return handleContext(agent, message, existing, key);
    case "reviewing":
      return handleReview(agent, message, existing, key);
    default:
      return reply(message, "Wizard is in an unexpected state. Type `cancel` to start over.");
  }
}

/** Step 1: Start the wizard */
async function startWizard(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  key: string,
): Promise<AgentResponse> {
  const threadTs = message.thread_ts ?? message.ts;

  sessions.set(key, {
    step: "awaiting_type",
    threadTs,
    channelId: message.channel_id,
    userId: message.user_id,
    createdAt: Date.now(),
  });

  const lines = [
    "*Campaign Creation Wizard*",
    "",
    "What would you like to create?",
    "",
    "*From event:*",
    "  `events` — Browse active events from shoppingeventvip.be",
    "  `event [brand/name]` — Create campaign for a specific event",
    "",
    "*New campaign:*",
    "  `search` — Search ads on Google",
    "  `shopping` — Product ads from Merchant Center",
    "  `pmax` — Performance Max (all channels)",
    "  `display` — Banner ads on Display Network",
    "  `youtube` — Video ads on YouTube",
    "",
    "*Clone existing:*",
    '  `clone [campaign name or ID]` — Copy structure from an existing campaign',
    "",
    "Or type `cancel` to abort.",
  ];

  if (!isEventSourceConfigured()) {
    lines.splice(4, 3); // Remove event options if not configured
  }

  return reply(message, lines.join("\n"));
}

/** Step 2: Handle type selection or clone request */
async function handleTypeSelection(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<AgentResponse> {
  const lower = message.text.trim().toLowerCase();

  // Browse events
  if (lower === "events" || lower === "browse events") {
    try {
      const events = await getActiveEvents();
      return reply(message, formatEventList(events));
    } catch (err) {
      return reply(message, `Could not fetch events: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Create from event
  if (lower.startsWith("event ")) {
    const eventQuery = message.text.trim().replace(/^event\s+/i, "").trim();
    try {
      const event = await findEvent(eventQuery);
      if (!event) {
        return reply(message, `Event "${eventQuery}" not found. Try \`events\` to browse active events.`);
      }

      session.step = "analyzing";
      sessions.set(key, session);

      // Default to search campaign for events
      session.campaignType = "search";

      const recommendations = await generateRecommendations({
        campaignType: "search",
        brandOrProduct: eventToAiContext(event),
      });

      // Override URL with event URL if available
      if (event.url) {
        recommendations.finalUrl = event.url;
      }

      session.recommendations = recommendations;
      session.step = "reviewing";
      sessions.set(key, session);

      return reply(message, [
        `*Event found: "${event.titleNl}"*`,
        `Brands: ${event.brands.join(", ") || "—"}`,
        `Dates: ${event.startDate?.split("T")[0] ?? "?"} → ${event.endDate?.split("T")[0] ?? "?"}`,
        `URL: ${event.url ?? "—"}`,
        "",
        "---",
        "",
        formatRecommendations(recommendations),
      ].join("\n"));
    } catch (err) {
      session.step = "awaiting_type";
      sessions.set(key, session);
      return reply(message, `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Clone flow
  if (lower.startsWith("clone")) {
    const target = message.text.trim().replace(/^clone\s+/i, "").replace(/^["']|["']$/g, "").trim();
    if (!target) {
      return reply(message, 'Usage: `clone [campaign name or ID]`\nExample: `clone 260309_RiverWoods_NL`');
    }

    session.step = "analyzing";
    sessions.set(key, session);

    // Find campaign by name or ID
    const campaignId = await findCampaignId(agent, target);
    if (!campaignId) {
      session.step = "awaiting_type";
      sessions.set(key, session);
      return reply(message, `Campaign "${target}" not found. Try the exact name or numeric ID.`);
    }

    // Analyze the source campaign
    const structure = await analyzeCampaign(agent.googleAds, campaignId);
    if (!structure) {
      session.step = "awaiting_type";
      sessions.set(key, session);
      return reply(message, `Could not analyze campaign ${campaignId}. Try a different campaign.`);
    }

    session.sourceStructure = structure;
    session.campaignType = mapChannelType(structure.type);

    // Generate AI recommendations based on source
    const recommendations = await generateRecommendations({
      source: structure,
      campaignType: structure.type,
    });

    session.recommendations = recommendations;
    session.step = "reviewing";
    sessions.set(key, session);

    return reply(message, [
      formatCampaignSummary(structure),
      "---",
      "",
      formatRecommendations(recommendations),
    ].join("\n"));
  }

  // Direct type selection
  const typeMap: Record<string, GoogleCampaignType> = {
    search: "search",
    shopping: "shopping",
    pmax: "pmax",
    display: "display",
    youtube: "youtube",
  };

  const selectedType = typeMap[lower];
  if (!selectedType) {
    return reply(message, [
      "Please pick a campaign type: `search`, `shopping`, `pmax`, `display`, `youtube`",
      'Or clone an existing campaign: `clone [name or ID]`',
    ].join("\n"));
  }

  session.campaignType = selectedType;
  session.step = "analyzing";
  sessions.set(key, session);

  // Ask for context before generating
  session.campaignType = selectedType;
  session.step = "awaiting_context";
  sessions.set(key, session);

  return reply(message, [
    `Got it — *${selectedType}* campaign.`,
    "",
    "Tell me about the campaign. What brand/product, landing page, and goal?",
    "",
    'Example: `RiverWoods winter sale, shoppingeventvip.be/river-woods, drive registrations`',
    'Or: `Xandres outlet, 70% off designer fashion, target Belgium`',
  ].join("\n"));
}

/** Step 2b: Handle user context for fresh campaign creation */
async function handleContext(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<AgentResponse> {
  const userContext = message.text.trim();

  session.step = "analyzing";
  sessions.set(key, session);

  const recommendations = await generateRecommendations({
    campaignType: session.campaignType,
    brandOrProduct: userContext,
  });

  session.recommendations = recommendations;
  session.step = "reviewing";
  sessions.set(key, session);

  return reply(message, formatRecommendations(recommendations));
}

/** Step 3+: Handle review modifications */
async function handleReview(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<AgentResponse> {
  const lower = message.text.trim().toLowerCase();
  const rec = session.recommendations!;

  // Confirm → create campaign via API
  if (lower === "confirm" || lower === "yes" || lower === "go") {
    return confirmAndBuild(agent, message, session, key);
  }

  // Export CSV for Google Ads Editor
  if (lower.includes("export") || lower.includes("csv") || lower.includes("editor")) {
    return exportCsv(message, session, key);
  }

  // Adjust budget
  const budgetMatch = lower.match(/(?:adjust|change|set)\s+budget\s+(?:to\s+)?€?(\d+)/);
  if (budgetMatch) {
    rec.budget.dailyEuros = Number(budgetMatch[1]);
    rec.budget.reasoning = "Manually adjusted";
    sessions.set(key, session);
    return reply(message, `Budget updated to €${rec.budget.dailyEuros}/day. Type \`confirm\` to create or keep adjusting.`);
  }

  // Regenerate copy
  if (lower.includes("regenerate") && lower.includes("copy")) {
    const newRec = await generateRecommendations({
      source: session.sourceStructure,
      campaignType: session.campaignType,
      brandOrProduct: "Shopping Event VIP — Belgian fashion outlet",
      userNotes: "Generate completely different ad copy from the previous suggestions.",
    });

    // Keep user's budget adjustment
    newRec.budget.dailyEuros = rec.budget.dailyEuros;
    // Keep user's keyword edits
    newRec.keywords = rec.keywords;

    session.recommendations = newRec;
    sessions.set(key, session);
    return reply(message, formatRecommendations(newRec));
  }

  // Add keyword
  const addKwMatch = message.text.trim().match(/add\s+keyword\s+["']?(.+?)["']?\s*$/i);
  if (addKwMatch) {
    rec.keywords.push({ text: addKwMatch[1], matchType: "BROAD", group: "custom" });
    sessions.set(key, session);
    return reply(message, `Added keyword \`${addKwMatch[1]}\`. Now ${rec.keywords.length} keywords total. Type \`confirm\` when ready.`);
  }

  // Remove keyword
  const rmKwMatch = message.text.trim().match(/remove\s+keyword\s+["']?(.+?)["']?\s*$/i);
  if (rmKwMatch) {
    const before = rec.keywords.length;
    rec.keywords = rec.keywords.filter(
      (k) => k.text.toLowerCase() !== rmKwMatch[1].toLowerCase(),
    );
    if (rec.keywords.length < before) {
      sessions.set(key, session);
      return reply(message, `Removed keyword \`${rmKwMatch[1]}\`. ${rec.keywords.length} keywords remaining.`);
    }
    return reply(message, `Keyword \`${rmKwMatch[1]}\` not found.`);
  }

  // Change campaign name
  const nameMatch = message.text.trim().match(/(?:rename|name|set name)\s+(?:to\s+)?["']?(.+?)["']?\s*$/i);
  if (nameMatch) {
    rec.campaignName = nameMatch[1];
    sessions.set(key, session);
    return reply(message, `Campaign name set to "${rec.campaignName}". Type \`confirm\` to create.`);
  }

  // Change landing page / final URL
  const urlMatch = message.text.trim().match(/(?:url|link|landing\s*page|final\s*url)\s+(?:to\s+)?(https?:\/\/\S+)/i);
  if (urlMatch) {
    rec.finalUrl = urlMatch[1];
    sessions.set(key, session);
    return reply(message, `Landing page set to \`${rec.finalUrl}\`. Type \`confirm\` or \`export csv\` when ready.`);
  }

  // Change path1/path2
  const pathMatch = message.text.trim().match(/(?:path|paths?)\s+(?:to\s+)?(\S+?)(?:\s*\/\s*(\S+))?\s*$/i);
  if (pathMatch) {
    rec.path1 = pathMatch[1].slice(0, 15);
    rec.path2 = pathMatch[2] ? pathMatch[2].slice(0, 15) : rec.path2;
    sessions.set(key, session);
    return reply(message, `URL paths set to \`${rec.path1}\`${rec.path2 ? ` / \`${rec.path2}\`` : ""}. Type \`confirm\` or \`export csv\` when ready.`);
  }

  // Change locations
  const locMatch = message.text.trim().match(/(?:target|location|locations?)\s+(?:to\s+)?(.+)/i);
  if (locMatch) {
    rec.targeting.locations = locMatch[1].split(/[,\s]+/).map((l) => l.trim().toUpperCase()).filter(Boolean);
    rec.targeting.reasoning = "Manually set";
    sessions.set(key, session);
    return reply(message, `Targeting set to ${rec.targeting.locations.join(", ")}. Type \`confirm\` or \`export csv\` when ready.`);
  }

  // Show current state
  if (lower === "show" || lower === "status" || lower === "summary") {
    return reply(message, formatRecommendations(rec));
  }

  // Unknown command in review mode
  return reply(message, [
    "I didn't understand that. While reviewing, you can:",
    "",
    "*Modify:*",
    "  `adjust budget to €X` — change daily budget",
    "  `url https://...` — change landing page",
    "  `path outlet/sale` — change URL display paths",
    "  `target BE, NL` — change location targeting",
    "  `rename to [name]` — change campaign name",
    "  `add keyword [text]` — add a keyword",
    "  `remove keyword [text]` — remove a keyword",
    "  `regenerate copy` — get new ad copy suggestions",
    "",
    "*Actions:*",
    "  `show` — show current recommendation",
    "  `confirm` — create via API (PAUSED)",
    "  `export csv` — Google Ads Editor CSV",
    "  `cancel` — abort wizard",
  ].join("\n"));
}

/** Final step: create the campaign */
async function confirmAndBuild(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<AgentResponse> {
  const rec = session.recommendations!;
  const type = session.campaignType ?? "search";

  const config: CampaignConfig = {
    type,
    name: rec.campaignName,
    dailyBudgetMicros: Math.round(rec.budget.dailyEuros * 1_000_000),
    locations: rec.targeting.locations,
    languages: ["nl", "fr"],
    startDate: new Date().toISOString().split("T")[0],
  };

  // Add type-specific config
  if (type === "search") {
    config.adGroupName = `${rec.campaignName} - NL`;
    config.keywords = rec.keywords.map((k) => ({
      text: k.text,
      matchType: k.matchType as "EXACT" | "PHRASE" | "BROAD",
    }));
    config.responsiveSearchAd = {
      headlines: rec.adCopy.nl.headlines.slice(0, 15),
      descriptions: rec.adCopy.nl.descriptions.slice(0, 4),
      finalUrl: rec.finalUrl,
      path1: rec.path1,
      path2: rec.path2,
    };
  } else if (type === "pmax") {
    config.assetGroup = {
      name: `${rec.campaignName} - Asset Group`,
      finalUrls: [rec.finalUrl],
      headlines: rec.adCopy.nl.headlines.slice(0, 5),
      descriptions: rec.adCopy.nl.descriptions.slice(0, 2),
    };
  } else if (type === "shopping") {
    config.merchantId = process.env.GOOGLE_MERCHANT_ID;
    config.feedLabel = "online";
  }

  // Set bidding from source
  if (session.sourceStructure?.bidding.targetRoas) {
    config.targetRoas = session.sourceStructure.bidding.targetRoas;
  }
  if (session.sourceStructure?.bidding.targetCpaMicros) {
    config.targetCpa = session.sourceStructure.bidding.targetCpaMicros / 1_000_000;
  }

  try {
    const result = await buildCampaign(agent.googleAds, config);

    // Clean up session
    sessions.delete(key);

    const lines: string[] = [
      `*Campaign Created: "${rec.campaignName}"*`,
      "",
      `*Type:* ${type.toUpperCase()}`,
      `*Budget:* €${rec.budget.dailyEuros}/day`,
      `*Status:* PAUSED (awaiting approval)`,
      `*Keywords:* ${rec.keywords.length}`,
      `*Headlines:* ${rec.adCopy.nl.headlines.length} NL + ${rec.adCopy.fr.headlines.length} FR`,
      "",
      `*Resource:* \`${result.campaignResourceName}\``,
    ];

    if (result.adGroupResourceName) {
      lines.push(`*Ad Group:* \`${result.adGroupResourceName}\``);
    }
    if (result.assetGroupResourceName) {
      lines.push(`*Asset Group:* \`${result.assetGroupResourceName}\``);
    }

    lines.push(
      "",
      "_Campaign is PAUSED. Review in Google Ads and enable when ready._",
      `_French ad group not yet created — run the wizard again or add manually._`,
    );

    return reply(message, lines.join("\n"));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    agent.log.error(`Wizard campaign creation failed: ${errMsg}`);

    // Don't clear session on failure — user can retry
    return reply(message, `Failed to create campaign: ${errMsg}\n\nType \`confirm\` to retry or \`cancel\` to abort.`);
  }
}

/** Export campaign as Google Ads Editor CSV */
async function exportCsv(
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<AgentResponse> {
  const rec = session.recommendations!;

  const csv = generateEditorCsv(rec, {
    campaignType: session.campaignType,
    targetCpa: session.sourceStructure?.bidding.targetCpaMicros
      ? session.sourceStructure.bidding.targetCpaMicros / 1_000_000
      : undefined,
    targetRoas: session.sourceStructure?.bidding.targetRoas ?? undefined,
  });

  // Clean up session
  sessions.delete(key);

  return reply(message, formatCsvForSlack(csv, rec.campaignName));
}

/** Find a campaign ID by name or numeric ID */
async function findCampaignId(agent: GoogleAdsAgent, nameOrId: string): Promise<string | null> {
  // If it's already a numeric ID
  if (/^\d+$/.test(nameOrId)) {
    return nameOrId;
  }

  // Search by name
  const query = `
    SELECT campaign.id, campaign.name
    FROM campaign
    WHERE campaign.name LIKE '%${nameOrId.replace(/'/g, "\\'")}%'
      AND campaign.status != 'REMOVED'
    LIMIT 5
  `;

  const results = await agent.googleAds.query(query) as Array<{
    results?: Array<Record<string, any>>;
  }>;

  for (const batch of results) {
    for (const row of batch.results ?? []) {
      return String(row.campaign?.id ?? "");
    }
  }

  return null;
}

/** Map Google Ads channel type to our campaign type */
function mapChannelType(type: string): GoogleCampaignType {
  const map: Record<string, GoogleCampaignType> = {
    SEARCH: "search",
    SHOPPING: "shopping",
    PERFORMANCE_MAX: "pmax",
    DISPLAY: "display",
    VIDEO: "youtube",
  };
  return map[type] ?? "search";
}

/** Helper to build a reply */
function reply(message: RoutedMessage, text: string): AgentResponse {
  return {
    channel_id: message.channel_id,
    thread_ts: message.thread_ts ?? message.ts,
    text,
  };
}
