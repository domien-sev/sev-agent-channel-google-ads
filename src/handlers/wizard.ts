/**
 * Campaign creation wizard — multi-step conversational flow in Slack.
 * Posts rich Block Kit messages directly to Slack for buttons, fields, and sections.
 * Falls back to text-only replies when SLACK_BOT_TOKEN is not configured.
 *
 * Flow:
 *   1. "wizard" → buttons for type selection
 *   2. User picks type (button/text) or "clone [campaign]" → analyze source
 *   3. AI generates recommendations → rich review with action buttons
 *   4. User can modify → text commands or button clicks
 *   5. "confirm" → create campaign (PAUSED)
 *   6. "cancel" → abort
 */
import type { RoutedMessage, AgentResponse } from "@domien-sev/shared-types";
import type { GoogleAdsAgent } from "../agent.js";
import type { GoogleCampaignType } from "../types.js";
import { analyzeCampaign } from "../tools/campaign-analyzer.js";
import type { CampaignStructure } from "../tools/campaign-analyzer.js";
import { generateRecommendations } from "../tools/ai-recommendations.js";
import type { WizardRecommendations } from "../tools/ai-recommendations.js";
import { buildCampaign } from "../tools/campaign-builder.js";
import { generateEditorCsv } from "../tools/csv-export.js";
import {
  getActiveEvents,
  findEvent,
  findEventForBrand,
  eventToAiContext,
  isEventSourceConfigured,
  extractEventIdFromUrl,
  getEventById,
} from "../tools/event-source.js";
import type { CampaignConfig } from "../types.js";
import { reply, postBlocks } from "../tools/reply.js";
import type { DirectPostResponse } from "../tools/reply.js";
import { isSlackConfigured, slackPost } from "../tools/slack.js";
import { storeAdCopy, retrieveSimilarAds, formatAdsForPrompt, extractBrand } from "../tools/ad-memory.js";
import { searchBrandContext, searchEventContext } from "../tools/brand-knowledge.js";
import {
  wizardStartBlocks,
  eventListBlocks,
  eventConfirmationBlocks,
  sourceCampaignBlocks,
  recommendationBlocks,
  confirmationBlocks,
  contextPromptBlocks,
  csvExportBlocks,
  errorBlock,
  thinkingBlocks,
} from "../tools/wizard-blocks.js";
import type { EventData } from "../tools/event-source.js";

/** Wizard response: either text-based (for OpenClaw) or direct-posted (Block Kit) */
type WizardResponse = AgentResponse | DirectPostResponse;

/** Wizard states */
type WizardStep = "awaiting_type" | "awaiting_event" | "confirming_event" | "awaiting_context" | "analyzing" | "reviewing" | "confirmed" | "created";

interface CreatedCampaign {
  campaignResourceName: string;
  adGroupResourceName?: string;
  assetGroupResourceName?: string;
}

interface PendingAd {
  finalUrl: string;
  headlines: string[];
  descriptions: string[];
  path1: string;
  path2: string;
  feedbackHistory: string[];
}

interface EventConfig {
  event: import("../tools/event-source.js").EventData;
  campaignEndDate: string;
  targetingRadius: number;
  targetingLocation: string;
  landingPageUrl: string;
  landingPageUrlFr?: string;
  languages: ("nl" | "fr")[];
}

interface WizardState {
  step: WizardStep;
  threadTs: string;
  channelId: string;
  userId: string;
  campaignType?: GoogleCampaignType;
  sourceStructure?: CampaignStructure;
  recommendations?: WizardRecommendations;
  eventConfig?: EventConfig;
  created?: CreatedCampaign;
  pendingAd?: PendingAd;
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

/** Post blocks if Slack is configured, otherwise fall back to text */
async function postBlocksOrText(
  message: RoutedMessage,
  blocks: ReturnType<typeof wizardStartBlocks>,
  fallbackText: string,
): Promise<WizardResponse> {
  if (isSlackConfigured()) {
    return postBlocks(message, blocks, fallbackText);
  }
  return reply(message, fallbackText);
}

/**
 * Gather RAG context from both Onyx (brand knowledge) and pgvector (past ads).
 * Non-fatal — returns empty string if either source fails.
 */
async function gatherRagContext(
  brand: string,
  eventType = "generic",
  campaignType = "search",
): Promise<string> {
  const parts: string[] = [];

  try {
    // Parallel retrieval from both sources
    const [brandCtx, eventCtx, similarAds] = await Promise.all([
      searchBrandContext(brand, eventType, campaignType).catch(() => ""),
      searchEventContext(eventType, brand).catch(() => ""),
      retrieveSimilarAds(brand, eventType, campaignType).catch(() => [] as any[]),
    ]);

    if (brandCtx) parts.push(brandCtx);
    if (eventCtx) parts.push(eventCtx);
    if (similarAds.length > 0) parts.push(formatAdsForPrompt(similarAds));
  } catch (err) {
    console.warn("[wizard] RAG context gathering failed:", err instanceof Error ? err.message : String(err));
  }

  return parts.join("\n\n");
}

/** Check if a message should be handled by the wizard */
export function isWizardMessage(text: string, channelId: string, userId: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower === "wizard" || lower.startsWith("campaign wizard")) return true;
  if (lower.startsWith("clone ") || lower.startsWith("event ") || lower === "events") return true;
  if (lower.startsWith("manage ")) return true;
  return getSession(channelId, userId) !== null;
}

/** Main wizard handler */
export async function handleWizard(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
): Promise<WizardResponse> {
  const text = message.text.trim();
  const lower = text.toLowerCase();
  const key = sessionKey(message.channel_id, message.user_id);

  // Cancel
  if (lower === "cancel" || lower === "abort") {
    sessions.delete(key);
    return reply(message, "Wizard cancelled.");
  }

  // "wizard" always starts fresh (clears stale sessions)
  if (lower === "wizard" || lower.startsWith("campaign wizard")) {
    sessions.delete(key);
    return startWizard(agent, message, key);
  }

  // New wizard or existing session
  const existing = getSession(message.channel_id, message.user_id);

  if (!existing) {
    if (lower.startsWith("manage ")) {
      return handleManage(agent, message, key);
    }
    if (lower.startsWith("clone ") || lower.startsWith("event ") || lower === "events") {
      const session: WizardState = {
        step: "awaiting_type",
        threadTs: message.thread_ts ?? message.ts,
        channelId: message.channel_id,
        userId: message.user_id,
        createdAt: Date.now(),
      };
      sessions.set(key, session);
      return handleTypeSelection(agent, message, session, key);
    }
    return startWizard(agent, message, key);
  }

  switch (existing.step) {
    case "awaiting_type":
      return handleTypeSelection(agent, message, existing, key);
    case "awaiting_event":
      return handleEventStep(agent, message, existing, key);
    case "confirming_event":
      return handleEventConfirmation(agent, message, existing, key);
    case "awaiting_context":
      return handleContext(agent, message, existing, key);
    case "reviewing":
      return handleReview(agent, message, existing, key);
    case "created":
      return handlePostCreation(agent, message, existing, key);
    default:
      return reply(message, "Wizard is in an unexpected state. Type `cancel` to start over.");
  }
}

/** Step 1: Start the wizard — show buttons for type selection + recent campaigns */
async function startWizard(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  key: string,
): Promise<WizardResponse> {
  const threadTs = message.thread_ts ?? message.ts;

  sessions.set(key, {
    step: "awaiting_type",
    threadTs,
    channelId: message.channel_id,
    userId: message.user_id,
    createdAt: Date.now(),
  });

  // Fetch recent campaigns for "clone" suggestions
  let recentCampaigns: Array<{ name: string; type: string; cost: number }> = [];
  try {
    const results = await agent.googleAds.query(`
      SELECT campaign.name, campaign.advertising_channel_type, metrics.cost_micros
      FROM campaign
      WHERE campaign.status != 'REMOVED'
        AND metrics.impressions > 0
      ORDER BY metrics.cost_micros DESC
      LIMIT 10
    `) as Array<{ results?: Array<Record<string, any>> }>;

    for (const batch of results) {
      for (const row of batch.results ?? []) {
        recentCampaigns.push({
          name: String(row.campaign?.name ?? ""),
          type: String(row.campaign?.advertisingChannelType ?? ""),
          cost: Number(row.metrics?.costMicros ?? 0) / 1_000_000,
        });
      }
    }
  } catch {
    // Non-critical — wizard works without campaign suggestions
  }

  return postBlocksOrText(
    message,
    wizardStartBlocks(isEventSourceConfigured(), recentCampaigns),
    "Campaign Creation Wizard — type `search`, `shopping`, `pmax`, `display`, `youtube`, `events`, or `clone [name]`",
  );
}

/** Step 2: Handle type selection, event browsing, or clone */
async function handleTypeSelection(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<WizardResponse> {
  const lower = message.text.trim().toLowerCase();

  // Browse events
  if (lower === "events" || lower === "browse events") {
    try {
      const events = await getActiveEvents();
      return postBlocksOrText(message, eventListBlocks(events), `Active Events (${events.length})`);
    } catch (err) {
      return reply(message, `Could not fetch events: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Create from event (by name or by ID from button click)
  if (lower.startsWith("event ") || lower.startsWith("event_select:")) {
    const eventQuery = message.text.trim()
      .replace(/^event_select:/i, "")
      .replace(/^event\s+/i, "")
      .trim();

    return handleEventSelection(agent, message, session, key, eventQuery);
  }

  // Clone flow
  if (lower.startsWith("clone")) {
    const target = message.text.trim().replace(/^clone\s+/i, "").replace(/^["']|["']$/g, "").trim();
    if (!target) {
      return reply(message, 'Usage: `clone [campaign name or ID]`\nExample: `clone 260309_RiverWoods_NL`');
    }
    return handleClone(agent, message, session, key, target);
  }

  // Direct type selection
  const typeMap: Record<string, GoogleCampaignType> = {
    search: "search", shopping: "shopping", pmax: "pmax",
    display: "display", youtube: "youtube",
  };

  const selectedType = typeMap[lower];
  if (!selectedType) {
    return reply(message, "Pick a type: `search`, `shopping`, `pmax`, `display`, `youtube`, or `clone [name]`");
  }

  session.campaignType = selectedType;

  // Go to event selection if event source is configured
  if (isEventSourceConfigured()) {
    session.step = "awaiting_event";
    sessions.set(key, session);

    try {
      const events = await getActiveEvents();
      if (events.length > 0) {
        return postBlocksOrText(
          message,
          eventListBlocks(events),
          `*${selectedType}* campaign — select an event, paste an admin URL, or type \`skip\` for a custom campaign:`,
        );
      }
    } catch { /* fall through to context */ }
  }

  session.step = "awaiting_context";
  sessions.set(key, session);

  return postBlocksOrText(
    message,
    contextPromptBlocks(selectedType),
    `Got it — *${selectedType}* campaign. Tell me about the campaign: brand/product, landing page, and goal.`,
  );
}

/** Handle event selection step — user picks or searches for an event */
async function handleEventStep(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<WizardResponse> {
  const lower = message.text.trim().toLowerCase();

  // Skip event selection → go to free-form context
  if (lower === "skip" || lower === "no event" || lower === "custom") {
    session.step = "awaiting_context";
    sessions.set(key, session);
    return postBlocksOrText(
      message,
      contextPromptBlocks(session.campaignType ?? "search"),
      "OK, describe the campaign: brand/product, landing page, and goal.",
    );
  }

  // Browse events
  if (lower === "events" || lower === "browse events") {
    const events = await getActiveEvents();
    return postBlocksOrText(message, eventListBlocks(events), `Active Events (${events.length})`);
  }

  // Event selected by button (event_select:ID) or by name
  let event: EventData | null = null;

  if (lower.startsWith("event_select:")) {
    const eventId = message.text.trim().replace(/^event_select:/i, "").trim();
    event = await getEventById(eventId);
  } else {
    // Try admin URL
    const adminEventId = extractEventIdFromUrl(message.text.trim());
    if (adminEventId) {
      event = await getEventById(adminEventId);
    } else {
      // Try by name
      event = await findEvent(message.text.trim());
    }
  }

  if (!event) {
    return reply(message, `Event not found. Try \`events\` to browse, paste an admin URL, or type \`skip\` for a custom campaign.`);
  }

  // Build event config with defaults
  const landingPageUrl = event.url
    ?? `https://www.shoppingeventvip.be/nl/event/${event.slugNl ?? event.titleNl.toLowerCase().replace(/\s+/g, "-")}`;

  const eventConfig: EventConfig = {
    event,
    campaignEndDate: event.suggestedCampaignEnd ?? event.endDate?.split("T")[0] ?? "",
    targetingRadius: event.type === "physical" ? 30 : 0,
    targetingLocation: event.postalCode
      ? `${event.locationText ?? event.postalCode} (${event.postalCode})`
      : "Belgium",
    landingPageUrl,
  };

  session.eventConfig = eventConfig;
  session.step = "confirming_event";
  sessions.set(key, session);

  return postBlocksOrText(
    message,
    eventConfirmationBlocks({
      event,
      campaignEndDate: eventConfig.campaignEndDate,
      targetingRadius: eventConfig.targetingRadius,
      targetingLocation: eventConfig.targetingLocation,
      landingPageUrl: eventConfig.landingPageUrl,
      languages: eventConfig.languages,
    }),
    `Event: ${event.titleNl}`,
  );
}

/** Handle event confirmation — user confirms or adjusts settings */
async function handleEventConfirmation(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<WizardResponse> {
  const lower = message.text.trim().toLowerCase();
  const ec = session.eventConfig!;

  // Confirm → generate recommendations
  if (lower === "confirm" || lower === "confirm_event" || lower === "yes" || lower === "go") {
    if (isSlackConfigured()) {
      await slackPost(message.channel_id, {
        text: "Generating recommendations...",
        blocks: thinkingBlocks("Generating campaign recommendations from event data"),
        thread_ts: message.thread_ts ?? message.ts,
      });
    }

    session.step = "analyzing";
    sessions.set(key, session);

    const brand = ec.event.brands[0] ?? ec.event.titleNl;
    const ragContext = await gatherRagContext(brand, ec.event.type, session.campaignType ?? "search");

    const recommendations = await generateRecommendations({
      source: session.sourceStructure,
      campaignType: session.campaignType ?? "search",
      brandOrProduct: eventToAiContext(ec.event),
      ragContext,
    });

    // Apply event config
    recommendations.finalUrl = ec.landingPageUrl;
    recommendations.endDate = ec.campaignEndDate;

    session.recommendations = recommendations;
    session.step = "reviewing";
    sessions.set(key, session);

    // If cloning, show source campaign info first
    if (session.sourceStructure && isSlackConfigured()) {
      await postBlocks(message, sourceCampaignBlocks(session.sourceStructure), `Source: ${session.sourceStructure.name}`);
    }

    return postBlocksOrText(message, recommendationBlocks(recommendations), recommendations.campaignName);
  }

  // Change radius
  const radiusMatch = lower.match(/radius\s+(\d+)\s*km?/);
  if (radiusMatch) {
    ec.targetingRadius = Number(radiusMatch[1]);
    sessions.set(key, session);
    return reply(message, `Targeting radius set to ${ec.targetingRadius}km. Type \`confirm\` to generate.`);
  }

  // Change end date
  const endMatch = message.text.trim().match(/end\s*date\s+(\d{4}-\d{2}-\d{2})/i);
  if (endMatch) {
    ec.campaignEndDate = endMatch[1];
    sessions.set(key, session);
    return reply(message, `Campaign end date set to ${ec.campaignEndDate}. Type \`confirm\` to generate.`);
  }

  // Change URL
  const urlInMsg = message.text.match(/(https?:\/\/[^\s>|]+)/i);
  if (urlInMsg && !lower.startsWith("confirm")) {
    ec.landingPageUrl = urlInMsg[1];
    sessions.set(key, session);
    return reply(message, `Landing page set to \`${ec.landingPageUrl}\`. Type \`confirm\` to generate.`);
  }

  // Change location
  const locMatch = lower.match(/location\s+(.+)/);
  if (locMatch) {
    ec.targetingLocation = locMatch[1].trim();
    sessions.set(key, session);
    return reply(message, `Targeting location set to "${ec.targetingLocation}". Type \`confirm\` to generate.`);
  }

  // Change languages
  if (lower.includes("nl only") || lower === "nl") {
    ec.languages = ["nl"];
    sessions.set(key, session);
    return reply(message, "Language set to NL only. Type `confirm` to generate.");
  }
  if (lower.includes("fr only") || lower === "fr") {
    ec.languages = ["fr"];
    sessions.set(key, session);
    return reply(message, "Language set to FR only. Type `confirm` to generate.");
  }
  if (lower.includes("nl+fr") || lower.includes("nl fr") || lower.includes("both")) {
    ec.languages = ["nl", "fr"];
    sessions.set(key, session);
    return reply(message, "Languages set to NL + FR (separate ad groups). Type `confirm` to generate.");
  }

  // Show current config
  return postBlocksOrText(
    message,
    eventConfirmationBlocks({
      event: ec.event,
      campaignEndDate: ec.campaignEndDate,
      targetingRadius: ec.targetingRadius,
      targetingLocation: ec.targetingLocation,
      landingPageUrl: ec.landingPageUrl,
    }),
    `Event: ${ec.event.titleNl}`,
  );
}

/** Handle event selection — find event and generate recommendations */
async function handleEventSelection(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
  eventQuery: string,
): Promise<WizardResponse> {
  try {
    // Try finding by ID first (from button click), then by name
    const event = await findEvent(eventQuery);
    if (!event) {
      return reply(message, `Event "${eventQuery}" not found. Try \`events\` to browse.`);
    }

    // Post a "thinking" indicator
    if (isSlackConfigured()) {
      await slackPost(message.channel_id, {
        text: "Generating recommendations...",
        blocks: thinkingBlocks("Generating campaign recommendations"),
        thread_ts: message.thread_ts ?? message.ts,
      });
    }

    session.step = "analyzing";
    session.campaignType = "search";
    sessions.set(key, session);

    const eventBrand = event.brands[0] ?? event.titleNl;
    const eventRag = await gatherRagContext(eventBrand, event.type, "search");

    const recommendations = await generateRecommendations({
      campaignType: "search",
      brandOrProduct: eventToAiContext(event),
      ragContext: eventRag,
    });

    if (event.url) recommendations.finalUrl = event.url;
    if (event.endDate) recommendations.endDate = event.endDate.split("T")[0];

    session.recommendations = recommendations;
    session.step = "reviewing";
    sessions.set(key, session);

    return postBlocksOrText(message, recommendationBlocks(recommendations), recommendations.campaignName);
  } catch (err) {
    session.step = "awaiting_type";
    sessions.set(key, session);
    return reply(message, `Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Handle clone — analyze source campaign, then go to event selection */
async function handleClone(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
  target: string,
): Promise<WizardResponse> {
  session.step = "analyzing";
  sessions.set(key, session);

  // Post thinking indicator
  if (isSlackConfigured()) {
    await slackPost(message.channel_id, {
      text: "Analyzing campaign...",
      blocks: thinkingBlocks("Analyzing source campaign"),
      thread_ts: message.thread_ts ?? message.ts,
    });
  }

  const campaignId = await findCampaignId(agent, target);
  if (!campaignId) {
    session.step = "awaiting_type";
    sessions.set(key, session);
    return reply(message, `Campaign "${target}" not found. Try the exact name or numeric ID.`);
  }

  const structure = await analyzeCampaign(agent.googleAds, campaignId);
  if (!structure) {
    session.step = "awaiting_type";
    sessions.set(key, session);
    return reply(message, `Could not analyze campaign ${campaignId}. Try a different one.`);
  }

  session.sourceStructure = structure;
  session.campaignType = mapChannelType(structure.type);

  // Show source summary
  if (isSlackConfigured()) {
    await postBlocks(message, sourceCampaignBlocks(structure), `Source: ${structure.name}`);
  }

  // Try to auto-match an event for the brand
  if (isEventSourceConfigured()) {
    try {
      const matchedEvent = await findEventForBrand(structure.name);
      if (matchedEvent) {
        // Auto-fill event config and show confirmation
        const landingPageUrl = matchedEvent.url
          ?? `https://www.shoppingeventvip.be/nl/event/${matchedEvent.slugNl ?? matchedEvent.titleNl.toLowerCase().replace(/\s+/g, "-")}`;

        session.eventConfig = {
          event: matchedEvent,
          campaignEndDate: matchedEvent.suggestedCampaignEnd ?? matchedEvent.endDate?.split("T")[0] ?? "",
          targetingRadius: matchedEvent.type === "physical" ? 30 : 0,
          targetingLocation: matchedEvent.postalCode
            ? `${matchedEvent.locationText ?? matchedEvent.postalCode} (${matchedEvent.postalCode})`
            : "Belgium",
          landingPageUrl,
          languages: ["nl", "fr"],
        };
        session.step = "confirming_event";
        sessions.set(key, session);

        return postBlocksOrText(
          message,
          eventConfirmationBlocks({
            event: matchedEvent,
            campaignEndDate: session.eventConfig.campaignEndDate,
            targetingRadius: session.eventConfig.targetingRadius,
            targetingLocation: session.eventConfig.targetingLocation,
            landingPageUrl: session.eventConfig.landingPageUrl,
          }),
          `Matched event: ${matchedEvent.titleNl}`,
        );
      }
    } catch { /* fall through */ }

    // No auto-match — show event list
    try {
      const events = await getActiveEvents();
      if (events.length > 0) {
        session.step = "awaiting_event";
        sessions.set(key, session);
        return postBlocksOrText(
          message,
          eventListBlocks(events),
          `Source analyzed. Now select the event this campaign is for, or type \`skip\` to continue without event:`,
        );
      }
    } catch { /* fall through */ }
  }

  // No event source — go directly to AI generation
  session.step = "analyzing";
  sessions.set(key, session);

  const cloneBrand = extractBrand(structure.name);
  const cloneRag = await gatherRagContext(cloneBrand, "generic", structure.type);

  const recommendations = await generateRecommendations({
    source: structure,
    campaignType: structure.type,
    ragContext: cloneRag,
  });

  session.recommendations = recommendations;
  session.step = "reviewing";
  sessions.set(key, session);

  return postBlocksOrText(message, recommendationBlocks(recommendations), recommendations.campaignName);
}

/** Step 2b: Handle user context for fresh campaign creation */
async function handleContext(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<WizardResponse> {
  const userContext = message.text.trim();

  // Check if the user pasted an event URL from admin.shoppingeventvip.be
  let enrichedContext = userContext;
  const eventId = extractEventIdFromUrl(userContext);
  if (eventId && isEventSourceConfigured()) {
    const event = await getEventById(eventId);
    if (event) {
      enrichedContext = eventToAiContext(event);
      // Auto-set end date from event
      if (event.endDate) {
        session.recommendations = session.recommendations ?? {} as any;
      }
    }
  }

  if (isSlackConfigured()) {
    await slackPost(message.channel_id, {
      text: "Generating recommendations...",
      blocks: thinkingBlocks("Generating campaign recommendations"),
      thread_ts: message.thread_ts ?? message.ts,
    });
  }

  session.step = "analyzing";
  sessions.set(key, session);

  // Gather RAG context from Onyx + pgvector
  const brand = extractBrand(enrichedContext.split(",")[0].trim());
  const ragContext = await gatherRagContext(brand, "generic", session.campaignType ?? "search");

  const recommendations = await generateRecommendations({
    campaignType: session.campaignType,
    brandOrProduct: enrichedContext,
    ragContext,
  });

  // If event was detected, set end date and URL from event
  if (eventId && isEventSourceConfigured()) {
    const event = await getEventById(eventId);
    if (event) {
      if (event.endDate) recommendations.endDate = event.endDate.split("T")[0];
      if (event.url) recommendations.finalUrl = event.url;
    }
  }

  session.recommendations = recommendations;
  session.step = "reviewing";
  sessions.set(key, session);

  return postBlocksOrText(message, recommendationBlocks(recommendations), recommendations.campaignName);
}

/** Step 3+: Handle review modifications */
async function handleReview(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<WizardResponse> {
  const lower = message.text.trim().toLowerCase();
  const rec = session.recommendations!;

  // Confirm
  if (lower === "confirm" || lower === "yes" || lower === "go") {
    return confirmAndBuild(agent, message, session, key);
  }

  // Export CSV
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

  // Regenerate copy (explicit or conversational feedback)
  if (lower.includes("regenerate") || (lower.includes("new") && lower.includes("copy"))) {
    const direction = message.text.trim()
      .replace(/^(regenerate|new)\s*(copy|ads?|headlines?)?\s*/i, "")
      .trim();
    return regenerateCopy(agent, message, session, key, direction || undefined);
  }

  // Add keyword
  const addKwMatch = message.text.trim().match(/add\s+keyword\s+["']?(.+?)["']?\s*$/i);
  if (addKwMatch) {
    rec.keywords.push({ text: addKwMatch[1], matchType: "BROAD", group: "custom" });
    sessions.set(key, session);
    return reply(message, `Added keyword \`${addKwMatch[1]}\`. Now ${rec.keywords.length} total.`);
  }

  // Remove keyword
  const rmKwMatch = message.text.trim().match(/remove\s+keyword\s+["']?(.+?)["']?\s*$/i);
  if (rmKwMatch) {
    const before = rec.keywords.length;
    rec.keywords = rec.keywords.filter((k) => k.text.toLowerCase() !== rmKwMatch[1].toLowerCase());
    if (rec.keywords.length < before) {
      sessions.set(key, session);
      return reply(message, `Removed \`${rmKwMatch[1]}\`. ${rec.keywords.length} keywords remaining.`);
    }
    return reply(message, `Keyword \`${rmKwMatch[1]}\` not found.`);
  }

  // Rename
  const nameMatch = message.text.trim().match(/(?:rename|name|set name)\s+(?:to\s+)?["']?(.+?)["']?\s*$/i);
  if (nameMatch) {
    rec.campaignName = nameMatch[1];
    sessions.set(key, session);
    return reply(message, `Campaign name set to "${rec.campaignName}".`);
  }

  // Link event from admin URL (enriches context, sets end date and URL)
  const adminUrlMatch = message.text.trim().match(/admin\.shoppingeventvip\.be/i);
  if (adminUrlMatch) {
    const eventId = extractEventIdFromUrl(message.text.trim());
    if (eventId && isEventSourceConfigured()) {
      const event = await getEventById(eventId);
      if (event) {
        if (event.url) rec.finalUrl = event.url;
        if (event.endDate) rec.endDate = event.endDate.split("T")[0];
        sessions.set(key, session);

        const updates: string[] = [];
        if (event.url) updates.push(`Landing page: \`${event.url}\``);
        if (event.endDate) updates.push(`End date: ${rec.endDate}`);
        updates.push(`Event: *${event.titleNl}* (${event.type})`);
        if (event.brands.length) updates.push(`Brands: ${event.brands.join(", ")}`);
        if (event.dateTextNl) updates.push(`Dates: ${event.dateTextNl}`);

        return reply(message, `Event linked:\n${updates.map(u => `  ${u}`).join("\n")}\n\nType \`regenerate copy\` to update ad copy with event context, or \`confirm\` to create.`);
      }
      return reply(message, `Event ID ${eventId} not found on admin.shoppingeventvip.be.`);
    }
  }

  // Change URL
  const urlMatch = message.text.trim().match(/(?:url|link|landing\s*page|final\s*url)\s+(?:to\s+)?(https?:\/\/\S+)/i);
  if (urlMatch) {
    rec.finalUrl = urlMatch[1];
    sessions.set(key, session);
    return reply(message, `Landing page set to \`${rec.finalUrl}\`.`);
  }

  // Change paths
  const pathMatch = message.text.trim().match(/(?:path|paths?)\s+(?:to\s+)?(\S+?)(?:\s*\/\s*(\S+))?\s*$/i);
  if (pathMatch) {
    rec.path1 = pathMatch[1].slice(0, 15);
    rec.path2 = pathMatch[2] ? pathMatch[2].slice(0, 15) : rec.path2;
    sessions.set(key, session);
    return reply(message, `URL paths set to \`${rec.path1}\`${rec.path2 ? ` / \`${rec.path2}\`` : ""}.`);
  }

  // Set end date
  const endDateMatch = message.text.trim().match(/(?:end\s*date|stop\s*date|einddatum)\s+(?:to\s+)?(\d{4}-\d{2}-\d{2})/i);
  if (endDateMatch) {
    rec.endDate = endDateMatch[1];
    sessions.set(key, session);
    return reply(message, `End date set to ${rec.endDate}. Type \`confirm\` to create or keep adjusting.`);
  }

  // Remove end date
  if (lower === "no end date" || lower === "remove end date" || lower === "clear end date") {
    rec.endDate = undefined;
    sessions.set(key, session);
    return reply(message, "End date removed (campaign will run indefinitely). Type `confirm` to create or keep adjusting.");
  }

  // Change locations (requires "to" or starts with "target ")
  const locMatch = message.text.trim().match(/(?:(?:target|location|locations?)\s+to\s+|^target\s+)(.+)/i);
  if (locMatch) {
    rec.targeting.locations = locMatch[1].split(/[,\s]+/).map((l) => l.trim().toUpperCase()).filter(Boolean);
    rec.targeting.reasoning = "Manually set";
    sessions.set(key, session);
    return reply(message, `Targeting set to ${rec.targeting.locations.join(", ")}.`);
  }

  // Show current state
  if (lower === "show" || lower === "status" || lower === "summary") {
    return postBlocksOrText(message, recommendationBlocks(rec), rec.campaignName);
  }

  // Show help
  if (lower === "help" || lower === "?") {
    return reply(message, [
      "While reviewing, you can:",
      "  `adjust budget to €X` · `url https://...` · `path outlet/sale`",
      "  `end date YYYY-MM-DD` · `no end date` · `target to BE, NL`",
      "  `rename to [name]` · `add/remove keyword [text]`",
      "  `show` · `confirm` · `export csv` · `cancel`",
      "  Or just type feedback to improve the ad copy (e.g. 'include dates and location')",
    ].join("\n"));
  }

  // Anything else = ad copy feedback → regenerate with user direction
  return regenerateCopy(agent, message, session, key, message.text.trim());
}

/** Regenerate ad copy with user feedback + event context + RAG */
async function regenerateCopy(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
  direction?: string,
): Promise<WizardResponse> {
  const rec = session.recommendations!;

  if (isSlackConfigured()) {
    await slackPost(message.channel_id, {
      text: "Regenerating copy...",
      blocks: thinkingBlocks("Regenerating ad copy with your feedback"),
      thread_ts: message.thread_ts ?? message.ts,
    });
  }

  // Build rich context from event config
  let eventContext = "";
  if (session.eventConfig) {
    const ec = session.eventConfig;
    const ev = ec.event;
    eventContext = [
      `\nEvent context (from admin.shoppingeventvip.be):`,
      `  Event: ${ev.titleNl}`,
      `  Dates: ${ev.dateTextNl ?? "unknown"}`,
      `  Location: ${ev.locationText ?? "unknown"} (${ev.postalCode ?? ""})`,
      `  Brands: ${ev.brands.join(", ")}`,
      `  Type: ${ev.type}`,
      `  Campaign end: ${ec.campaignEndDate}`,
    ].join("\n");
  }

  const userNotes = [
    direction ? `User feedback: ${direction}.` : "Generate completely different ad copy. Try a different angle.",
    eventContext,
    "IMPORTANT: Use the event dates, location, and brand info in the ad copy. Include specific dates in headlines when possible.",
  ].filter(Boolean).join("\n");

  // Gather RAG context
  const brand = extractBrand(rec.campaignName);
  const ragContext = await gatherRagContext(brand, session.eventConfig?.event.type ?? "generic", session.campaignType ?? "search");

  const newRec = await generateRecommendations({
    source: session.sourceStructure,
    campaignType: session.campaignType,
    brandOrProduct: session.eventConfig ? eventToAiContext(session.eventConfig.event) : undefined,
    userNotes,
    ragContext,
  });

  // Preserve budget, keywords, URL, end date
  newRec.budget.dailyEuros = rec.budget.dailyEuros;
  newRec.keywords = rec.keywords;
  newRec.finalUrl = rec.finalUrl;
  newRec.endDate = rec.endDate;

  session.recommendations = newRec;
  sessions.set(key, session);
  return postBlocksOrText(message, recommendationBlocks(newRec), newRec.campaignName);
}

/** Create campaign via Google Ads API */
async function confirmAndBuild(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<WizardResponse> {
  const rec = session.recommendations!;
  const type = session.campaignType ?? "search";

  // Use event config languages if available, otherwise default to NL+FR
  const languages = session.eventConfig?.languages ?? ["nl", "fr"];
  const endDate = session.eventConfig?.campaignEndDate ?? rec.endDate;

  const config: CampaignConfig = {
    type,
    name: rec.campaignName,
    dailyBudgetMicros: Math.round(rec.budget.dailyEuros * 1_000_000),
    locations: rec.targeting.locations,
    languages,
    startDate: new Date().toISOString().split("T")[0],
    ...(endDate && { endDate }),
  };

  if (type === "search") {
    // First ad group uses the first language
    const primaryLang = languages[0] ?? "nl";
    const primaryCopy = rec.adCopy[primaryLang as "nl" | "fr"] ?? rec.adCopy.nl;
    config.adGroupName = `${rec.campaignName} - ${primaryLang.toUpperCase()}`;
    config.keywords = rec.keywords.map((k) => ({
      text: k.text,
      matchType: k.matchType as "EXACT" | "PHRASE" | "BROAD",
    }));
    config.responsiveSearchAd = {
      headlines: primaryCopy.headlines.slice(0, 15),
      descriptions: primaryCopy.descriptions.slice(0, 4),
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

  if (session.sourceStructure?.bidding.targetRoas) {
    config.targetRoas = session.sourceStructure.bidding.targetRoas;
  }
  if (session.sourceStructure?.bidding.targetCpaMicros) {
    config.targetCpa = session.sourceStructure.bidding.targetCpaMicros / 1_000_000;
  }

  try {
    const result = await buildCampaign(agent.googleAds, config);

    // Create second ad group for second language (if NL+FR and search type)
    let frAdGroupCreated = false;
    if (type === "search" && languages.length > 1 && result.campaignResourceName) {
      const secondLang = languages[1] as "nl" | "fr";
      const secondCopy = rec.adCopy[secondLang] ?? rec.adCopy.fr;
      try {
        // Create FR ad group
        const frAdGroupResult = await agent.googleAds.mutateResource("adGroups", [{
          create: {
            name: `${rec.campaignName} - ${secondLang.toUpperCase()}`,
            campaign: result.campaignResourceName,
            type: "SEARCH_STANDARD",
            status: "ENABLED",
          },
        }]);
        const frAdGroupRn = frAdGroupResult.results[0].resourceName;

        // Add same keywords
        if (rec.keywords.length > 0) {
          const kwOps = rec.keywords.map((k) => ({
            create: {
              ad_group: frAdGroupRn,
              status: "ENABLED",
              keyword: { text: k.text, match_type: k.matchType },
            },
          }));
          await agent.googleAds.mutateResource("adGroupCriteria", kwOps);
        }

        // Create FR responsive search ad (non-fatal)
        if (secondCopy.headlines.length > 0) {
          try {
            await agent.googleAds.mutateResource("adGroupAds", [{
              create: {
                ad_group: frAdGroupRn,
                status: "PAUSED",
                ad: {
                  responsive_search_ad: {
                    headlines: secondCopy.headlines.slice(0, 15).map((h) => ({ text: h })),
                    descriptions: secondCopy.descriptions.slice(0, 4).map((d) => ({ text: d })),
                    path1: rec.path1,
                    path2: rec.path2,
                  },
                  final_urls: [rec.finalUrl],
                },
              },
            }]);
          } catch (adErr) {
            console.warn(`[wizard] FR ad creation failed (non-fatal): ${adErr instanceof Error ? adErr.message : String(adErr)}`);
          }
        }
        frAdGroupCreated = true;
      } catch (err) {
        console.warn(`[wizard] FR ad group creation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Keep session alive for post-creation commands
    session.step = "created";
    session.created = {
      campaignResourceName: result.campaignResourceName,
      adGroupResourceName: result.adGroupResourceName,
      assetGroupResourceName: result.assetGroupResourceName,
    };
    sessions.set(key, session);

    // Store ad copy for future RAG retrieval (non-fatal)
    if (rec.adCopy.nl.headlines.length > 0) {
      storeAdCopy({
        brand: extractBrand(rec.campaignName),
        eventType: rec.endDate ? "physical" : "generic",
        campaignType: type,
        language: "nl",
        headlines: rec.adCopy.nl.headlines,
        descriptions: rec.adCopy.nl.descriptions,
        finalUrl: rec.finalUrl,
        path1: rec.path1,
        path2: rec.path2,
        keywords: rec.keywords,
        campaignName: rec.campaignName,
        eventDates: rec.endDate,
        feedbackApplied: [],
      }).catch((err) => console.warn("[wizard] Ad memory store failed:", err));
    }

    return postBlocksOrText(
      message,
      confirmationBlocks({
        campaignName: rec.campaignName,
        type,
        budget: rec.budget.dailyEuros,
        keywords: rec.keywords.length,
        headlinesNl: rec.adCopy.nl.headlines.length,
        headlinesFr: rec.adCopy.fr.headlines.length,
        campaignResource: result.campaignResourceName,
        adGroupResource: result.adGroupResourceName,
        assetGroupResource: result.assetGroupResourceName,
        warning: result.adWarning,
      }),
      `Campaign Created: ${rec.campaignName}`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    agent.log.error(`Wizard campaign creation failed: ${errMsg}`);
    return postBlocksOrText(
      message,
      errorBlock(`Failed to create campaign: ${errMsg}\n\nType \`confirm\` to retry or \`cancel\` to abort.`),
      `Error: ${errMsg}`,
    );
  }
}

/** Manage an existing campaign by name */
async function handleManage(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  key: string,
): Promise<WizardResponse> {
  const target = message.text.trim().replace(/^manage\s+/i, "").replace(/^["']|["']$/g, "").trim();
  if (!target) {
    return reply(message, "Usage: `manage [campaign name]`\nExample: `manage 260325_MarieMero_BE`");
  }

  // Find campaign
  const campaignId = await findCampaignId(agent, target);
  if (!campaignId) {
    return reply(message, `Campaign "${target}" not found. Use the exact name or numeric ID.`);
  }

  // Fetch campaign details
  const query = `
    SELECT
      campaign.resource_name, campaign.name, campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      metrics.impressions, metrics.clicks, metrics.cost_micros
    FROM campaign
    WHERE campaign.id = ${campaignId}
  `;

  let campaignName = target;
  let campaignRn = "";
  let campaignStatus = "UNKNOWN";
  let campaignType = "UNKNOWN";
  let budgetEuros = 0;
  let impressions = 0;
  let clicks = 0;
  let cost = 0;

  try {
    const results = await agent.googleAds.query(query) as Array<{ results?: Array<Record<string, any>> }>;
    for (const batch of results) {
      for (const row of batch.results ?? []) {
        campaignRn = row.campaign?.resourceName ?? "";
        campaignName = row.campaign?.name ?? target;
        campaignStatus = row.campaign?.status ?? "UNKNOWN";
        campaignType = row.campaign?.advertisingChannelType ?? "UNKNOWN";
        budgetEuros = Number(row.campaignBudget?.amountMicros ?? 0) / 1_000_000;
        impressions = Number(row.metrics?.impressions ?? 0);
        clicks = Number(row.metrics?.clicks ?? 0);
        cost = Number(row.metrics?.costMicros ?? 0) / 1_000_000;
      }
    }
  } catch (err) {
    return reply(message, `Error fetching campaign: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!campaignRn) {
    return reply(message, `Campaign "${target}" not found.`);
  }

  // Count ad groups and ads
  let adGroupCount = 0;
  let adCount = 0;
  let firstAdGroupRn: string | undefined;
  try {
    const agQuery = `
      SELECT ad_group.resource_name, ad_group.name
      FROM ad_group
      WHERE campaign.id = ${campaignId} AND ad_group.status != 'REMOVED'
    `;
    const agResults = await agent.googleAds.query(agQuery) as Array<{ results?: Array<Record<string, any>> }>;
    for (const batch of agResults) {
      for (const row of batch.results ?? []) {
        adGroupCount++;
        if (!firstAdGroupRn) firstAdGroupRn = row.adGroup?.resourceName;
      }
    }

    const adQuery = `
      SELECT ad_group_ad.ad.id
      FROM ad_group_ad
      WHERE campaign.id = ${campaignId} AND ad_group_ad.status != 'REMOVED'
    `;
    const adResults = await agent.googleAds.query(adQuery) as Array<{ results?: Array<Record<string, any>> }>;
    for (const batch of adResults) {
      adCount += (batch.results ?? []).length;
    }
  } catch { /* non-critical */ }

  // Create session in "created" state
  const session: WizardState = {
    step: "created",
    threadTs: message.thread_ts ?? message.ts,
    channelId: message.channel_id,
    userId: message.user_id,
    createdAt: Date.now(),
    recommendations: {
      campaignName,
      budget: { dailyEuros: budgetEuros, reasoning: "" },
      adCopy: { nl: { headlines: [], descriptions: [] }, fr: { headlines: [], descriptions: [] } },
      keywords: [],
      targeting: { locations: [], reasoning: "" },
      finalUrl: "",
      path1: "",
      path2: "",
    },
    created: {
      campaignResourceName: campaignRn,
      adGroupResourceName: firstAdGroupRn,
    },
  };
  sessions.set(key, session);

  const statusEmoji = campaignStatus === "ENABLED" ? ":large_green_circle:" : ":double_vertical_bar:";
  const lines = [
    `*Managing: ${campaignName}* ${statusEmoji}`,
    "",
    `*Status:* ${campaignStatus} · *Type:* ${campaignType}`,
    `*Budget:* €${budgetEuros.toFixed(2)}/day · *Ad Groups:* ${adGroupCount} · *Ads:* ${adCount}`,
    `*Performance:* ${impressions.toLocaleString()} impressions · ${clicks} clicks · €${cost.toFixed(2)} spent`,
    "",
    adCount === 0 ? ":warning: *No ads in this campaign.* Use `add ad https://your-url.com` to create one." : "",
    "",
    "Commands:",
    "  `enable` / `pause` — Change campaign status",
    "  `adjust budget to €X` — Update daily budget",
    "  `end date YYYY-MM-DD` / `no end date` — Set/clear end date",
    "  `rename to [name]` — Rename campaign",
    "  `add ad https://url.com` — Create a responsive search ad",
    "  `done` — Close this session",
  ].filter(Boolean);

  return reply(message, lines.join("\n"));
}

/** Post-creation: modify the live campaign */
async function handlePostCreation(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<WizardResponse> {
  const lower = message.text.trim().toLowerCase();
  const created = session.created!;
  const rec = session.recommendations!;

  // Done — close session
  if (lower === "done" || lower === "finish" || lower === "close") {
    sessions.delete(key);
    return reply(message, `Session closed. Campaign "${rec.campaignName}" is live in Google Ads (PAUSED).`);
  }

  // Enable campaign
  if (lower === "enable" || lower === "activate" || lower === "start") {
    try {
      await agent.googleAds.mutateResource("campaigns", [{
        update: { resourceName: created.campaignResourceName, status: "ENABLED" },
        updateMask: "status",
      }]);
      return reply(message, `Campaign "${rec.campaignName}" is now *ENABLED*. It will start serving ads.`);
    } catch (err) {
      return reply(message, `Failed to enable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Pause campaign
  if (lower === "pause" || lower === "stop") {
    try {
      await agent.googleAds.mutateResource("campaigns", [{
        update: { resourceName: created.campaignResourceName, status: "PAUSED" },
        updateMask: "status",
      }]);
      return reply(message, `Campaign "${rec.campaignName}" is now *PAUSED*.`);
    } catch (err) {
      return reply(message, `Failed to pause: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Update budget
  const budgetMatch = lower.match(/(?:adjust|change|set|update)\s+budget\s+(?:to\s+)?€?(\d+)/);
  if (budgetMatch) {
    const newBudgetMicros = Math.round(Number(budgetMatch[1]) * 1_000_000);
    try {
      // Get budget resource name from campaign
      const campaignData = await agent.googleAds.query(`
        SELECT campaign.campaign_budget FROM campaign
        WHERE campaign.resource_name = '${created.campaignResourceName}'
      `) as Array<{ results?: Array<Record<string, any>> }>;

      let budgetRn: string | null = null;
      for (const batch of campaignData) {
        for (const row of batch.results ?? []) {
          budgetRn = row.campaign?.campaignBudget ?? null;
        }
      }

      if (!budgetRn) {
        return reply(message, "Could not find the campaign's budget resource.");
      }

      await agent.googleAds.mutateResource("campaignBudgets", [{
        update: { resourceName: budgetRn, amount_micros: String(newBudgetMicros) },
        updateMask: "amount_micros",
      }]);
      return reply(message, `Budget updated to *€${budgetMatch[1]}/day*.`);
    } catch (err) {
      return reply(message, `Failed to update budget: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Update end date
  const endDateMatch = message.text.trim().match(/(?:end\s*date|stop\s*date|einddatum)\s+(?:to\s+)?(\d{4}-\d{2}-\d{2})/i);
  if (endDateMatch) {
    try {
      await agent.googleAds.mutateResource("campaigns", [{
        update: {
          resourceName: created.campaignResourceName,
          end_date: endDateMatch[1].replace(/-/g, ""),
        },
        updateMask: "end_date",
      }]);
      return reply(message, `End date updated to *${endDateMatch[1]}*.`);
    } catch (err) {
      return reply(message, `Failed to update end date: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Remove end date
  if (lower === "no end date" || lower === "remove end date" || lower === "clear end date") {
    try {
      await agent.googleAds.mutateResource("campaigns", [{
        update: {
          resourceName: created.campaignResourceName,
          end_date: "20371231",
        },
        updateMask: "end_date",
      }]);
      return reply(message, "End date removed (campaign will run indefinitely).");
    } catch (err) {
      return reply(message, `Failed to clear end date: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rename campaign
  const nameMatch = message.text.trim().match(/(?:rename|name|set name)\s+(?:to\s+)?["']?(.+?)["']?\s*$/i);
  if (nameMatch) {
    try {
      await agent.googleAds.mutateResource("campaigns", [{
        update: { resourceName: created.campaignResourceName, name: nameMatch[1] },
        updateMask: "name",
      }]);
      rec.campaignName = nameMatch[1];
      sessions.set(key, session);
      return reply(message, `Campaign renamed to *"${nameMatch[1]}"*.`);
    } catch (err) {
      return reply(message, `Failed to rename: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Confirm pending ad
  if ((lower === "confirm ad" || lower === "confirm") && session.pendingAd) {
    return confirmPendingAd(agent, message, session, key);
  }

  // Feedback on pending ad — any text while pendingAd exists is treated as feedback
  if (session.pendingAd && !lower.startsWith("add ad") && lower !== "cancel ad") {
    return regenerateAd(agent, message, session, key, message.text.trim());
  }

  // Cancel pending ad review
  if (lower === "cancel ad" && session.pendingAd) {
    session.pendingAd = undefined;
    sessions.set(key, session);
    return reply(message, "Ad draft discarded.");
  }

  // Add ad to campaign — generate preview (not created yet)
  const isAddAd = lower.startsWith("add ad");
  const urlInMessage = message.text.match(/(https?:\/\/[^\s>|]+)/i);
  if (isAddAd && urlInMessage) {
    const finalUrl = urlInMessage[1];
    if (!created.adGroupResourceName) {
      return reply(message, "No ad group found for this campaign. Create one in Google Ads first.");
    }
    return generateAdPreview(agent, message, session, key, finalUrl);
  }

  // Unknown command — show help
  return reply(message, [
    `Campaign *"${rec.campaignName}"* — you can:`,
    "  `enable` / `pause` — Change campaign status",
    "  `adjust budget to €X` — Change daily budget",
    "  `end date YYYY-MM-DD` · `no end date` — Set/clear end date",
    "  `rename to [name]` — Rename the campaign",
    "  `add ad https://url.com` — Create a responsive search ad",
    "  `done` — Close this session",
  ].join("\n"));
}

/** Export as Google Ads Editor CSV */
async function exportCsv(
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<WizardResponse> {
  const rec = session.recommendations!;

  const csv = generateEditorCsv(rec, {
    campaignType: session.campaignType,
    targetCpa: session.sourceStructure?.bidding.targetCpaMicros
      ? session.sourceStructure.bidding.targetCpaMicros / 1_000_000
      : undefined,
    targetRoas: session.sourceStructure?.bidding.targetRoas ?? undefined,
  });

  sessions.delete(key);

  return postBlocksOrText(
    message,
    csvExportBlocks(csv, rec.campaignName),
    `CSV export for ${rec.campaignName}`,
  );
}

/** Generate ad copy preview without creating */
async function generateAdPreview(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
  finalUrl: string,
): Promise<WizardResponse> {
  const rec = session.recommendations!;

  if (isSlackConfigured()) {
    await slackPost(message.channel_id, {
      text: "Generating ad copy...",
      blocks: thinkingBlocks("Generating bilingual ad copy"),
      thread_ts: message.thread_ts ?? message.ts,
    });
  }

  try {
    const adBrand = extractBrand(rec.campaignName);
    const adRag = await gatherRagContext(adBrand, "generic", "search");

    const aiRec = await generateRecommendations({
      campaignType: "search",
      brandOrProduct: `Campaign: ${rec.campaignName}. Landing page: ${finalUrl}`,
      userNotes: session.pendingAd?.feedbackHistory.length
        ? `Previous feedback: ${session.pendingAd.feedbackHistory.join("; ")}`
        : undefined,
      ragContext: adRag,
    });

    session.pendingAd = {
      finalUrl,
      headlines: aiRec.adCopy.nl.headlines,
      descriptions: aiRec.adCopy.nl.descriptions,
      path1: aiRec.path1,
      path2: aiRec.path2,
      feedbackHistory: session.pendingAd?.feedbackHistory ?? [],
    };
    sessions.set(key, session);

    return reply(message, formatAdPreview(session.pendingAd));
  } catch (err) {
    return reply(message, `Failed to generate ad copy: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Regenerate ad copy based on user feedback */
async function regenerateAd(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
  feedback: string,
): Promise<WizardResponse> {
  const rec = session.recommendations!;
  const pending = session.pendingAd!;
  pending.feedbackHistory.push(feedback);

  if (isSlackConfigured()) {
    await slackPost(message.channel_id, {
      text: "Regenerating ad copy...",
      blocks: thinkingBlocks("Regenerating ad copy with your feedback"),
      thread_ts: message.thread_ts ?? message.ts,
    });
  }

  try {
    const currentCopy = [
      `Current headlines: ${pending.headlines.map(h => `"${h}"`).join(", ")}`,
      `Current descriptions: ${pending.descriptions.map(d => `"${d}"`).join(", ")}`,
    ].join("\n");

    const regenBrand = extractBrand(rec.campaignName);
    const regenRag = await gatherRagContext(regenBrand, "generic", "search");

    const aiRec = await generateRecommendations({
      campaignType: "search",
      brandOrProduct: `Campaign: ${rec.campaignName}. Landing page: ${pending.finalUrl}`,
      userNotes: `${currentCopy}\n\nUser feedback: ${feedback}\n\nIMPORTANT: Apply the feedback to improve the ad copy. Keep what works, fix what the user asked to change.`,
      ragContext: regenRag,
    });

    pending.headlines = aiRec.adCopy.nl.headlines;
    pending.descriptions = aiRec.adCopy.nl.descriptions;
    pending.path1 = aiRec.path1;
    pending.path2 = aiRec.path2;
    sessions.set(key, session);

    return reply(message, formatAdPreview(pending));
  } catch (err) {
    return reply(message, `Failed to regenerate: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Confirm and create the pending ad */
async function confirmPendingAd(
  agent: GoogleAdsAgent,
  message: RoutedMessage,
  session: WizardState,
  key: string,
): Promise<WizardResponse> {
  const created = session.created!;
  const pending = session.pendingAd!;

  try {
    await agent.googleAds.mutateResource("adGroupAds", [{
      create: {
        ad_group: created.adGroupResourceName,
        status: "PAUSED",
        ad: {
          responsive_search_ad: {
            headlines: pending.headlines.map((h) => ({ text: h })),
            descriptions: pending.descriptions.map((d) => ({ text: d })),
            path1: pending.path1,
            path2: pending.path2,
          },
          final_urls: [pending.finalUrl],
        },
      },
    }]);

    // Store confirmed ad copy for future RAG retrieval (non-fatal)
    const rec = session.recommendations!;
    storeAdCopy({
      brand: extractBrand(rec.campaignName),
      eventType: "generic",
      campaignType: "search",
      language: "nl",
      headlines: pending.headlines,
      descriptions: pending.descriptions,
      finalUrl: pending.finalUrl,
      path1: pending.path1,
      path2: pending.path2,
      campaignName: rec.campaignName,
      feedbackApplied: pending.feedbackHistory,
    }).catch((err) => console.warn("[wizard] Ad memory store failed:", err));

    session.pendingAd = undefined;
    sessions.set(key, session);

    return reply(message, [
      `Ad created (PAUSED) with URL \`${pending.finalUrl}\``,
      `  ${pending.headlines.length} headlines · ${pending.descriptions.length} descriptions`,
      "Saved to ad copy library for future reference.",
      "Review in Google Ads and enable when ready.",
    ].join("\n"));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const policyMatch = errMsg.match(/"topic":\s*"([^"]+)"/);
    if (policyMatch?.[1] === "DESTINATION_NOT_WORKING") {
      return reply(message, `:warning: Ad rejected — URL \`${pending.finalUrl}\` is not reachable. Check the URL and try again.`);
    }
    return reply(message, `Failed to create ad: ${errMsg.slice(0, 300)}`);
  }
}

/** Format ad preview for Slack */
function formatAdPreview(ad: PendingAd): string {
  const lines = [
    "*Ad Copy Preview*",
    `URL: \`${ad.finalUrl}\``,
    `Paths: \`${ad.path1}\` / \`${ad.path2}\``,
    "",
    `*Headlines (${ad.headlines.length}):*`,
    ...ad.headlines.map((h) => `  \`${h}\` (${h.length}/30)`),
    "",
    `*Descriptions (${ad.descriptions.length}):*`,
    ...ad.descriptions.map((d) => `  \`${d}\` (${d.length}/90)`),
    "",
    "---",
    "Reply with feedback to improve (e.g. `more urgency`, `mention 27 maart`, `shorter headlines`)",
    "`confirm ad` — Create this ad in Google Ads",
    "`cancel ad` — Discard this draft",
  ];
  return lines.join("\n");
}

/** Find a campaign ID by name or numeric ID */
async function findCampaignId(agent: GoogleAdsAgent, nameOrId: string): Promise<string | null> {
  if (/^\d+$/.test(nameOrId)) return nameOrId;

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
    SEARCH: "search", SHOPPING: "shopping", PERFORMANCE_MAX: "pmax",
    DISPLAY: "display", VIDEO: "youtube",
  };
  return map[type] ?? "search";
}
