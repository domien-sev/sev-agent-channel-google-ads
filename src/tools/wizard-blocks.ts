/**
 * Wizard-specific Block Kit builders.
 * Converts wizard data into rich Slack messages with buttons, fields, and sections.
 */
import type { SlackBlock } from "./slack.js";
import type { WizardRecommendations } from "./ai-recommendations.js";
import type { EventData } from "./event-source.js";
import type { CampaignStructure } from "./campaign-analyzer.js";
import {
  headerBlock,
  sectionBlock,
  sectionFields,
  sectionWithAccessory,
  dividerBlock,
  contextBlock,
  actionsBlock,
  buttonElement,
  confirmDialog,
} from "./blocks.js";

// --- Step 1: Wizard Start ---

export function wizardStartBlocks(
  showEvents: boolean,
  recentCampaigns?: Array<{ name: string; type: string; cost: number }>,
): SlackBlock[] {
  const blocks: SlackBlock[] = [
    headerBlock("Campaign Creation Wizard"),
    sectionBlock("What would you like to create?"),
  ];

  // Clone from existing campaign
  if (recentCampaigns && recentCampaigns.length > 0) {
    blocks.push(
      dividerBlock(),
      sectionBlock(":arrow_right_hook: *Clone existing campaign:*"),
    );

    // Show top 5 as buttons (unique action_id per button)
    const cloneButtons = recentCampaigns.slice(0, 5).map((c, i) => {
      const typeShort = { SEARCH: "S", SHOPPING: "SH", PERFORMANCE_MAX: "PM", DISPLAY: "D", VIDEO: "YT" }[c.type] ?? "?";
      const label = `${c.name} [${typeShort}]`.slice(0, 75);
      return buttonElement(label, `wizard_clone_${i}`, c.name);
    });

    blocks.push(actionsBlock(cloneButtons, "wizard_clone_actions"));

    if (recentCampaigns.length > 5) {
      blocks.push(contextBlock([`+ ${recentCampaigns.length - 5} more — type \`clone [campaign name]\` for any campaign`]));
    }
  }

  // From event
  if (showEvents) {
    blocks.push(
      dividerBlock(),
      sectionBlock(":calendar: *From event:*"),
      actionsBlock([
        buttonElement("Browse Events", "wizard_events", "events"),
      ], "wizard_events_actions"),
    );
  }

  // New campaign
  blocks.push(
    dividerBlock(),
    sectionBlock(":new: *New campaign:*"),
    actionsBlock([
      buttonElement("Search", "wizard_type_search", "search"),
      buttonElement("Shopping", "wizard_type_shopping", "shopping"),
      buttonElement("PMax", "wizard_type_pmax", "pmax"),
      buttonElement("Display", "wizard_type_display", "display"),
      buttonElement("YouTube", "wizard_type_youtube", "youtube"),
    ], "wizard_type_actions"),
    dividerBlock(),
    contextBlock(["Type `cancel` to abort."]),
  );

  return blocks;
}

// --- Step 2: Event List ---

export function eventListBlocks(events: EventData[]): SlackBlock[] {
  if (events.length === 0) {
    return [sectionBlock("No active events found.")];
  }

  const blocks: SlackBlock[] = [
    headerBlock(`Active Events (${events.length})`),
  ];

  for (let i = 0; i < Math.min(events.length, 15); i++) {
    const e = events[i];
    const brands = e.brands.length > 0 ? e.brands.join(", ") : "—";
    const dates = e.dateTextNl ?? `${e.startDate?.split("T")[0] ?? "?"} → ${e.endDate?.split("T")[0] ?? "?"}`;
    const typeEmoji = e.type === "online" ? ":globe_with_meridians:" : ":round_pushpin:";

    blocks.push(
      sectionWithAccessory(
        `${typeEmoji} *${e.titleNl}*\n${brands} · ${dates}`,
        buttonElement("Use", `wizard_event_${i}`, e.id),
      ),
    );
  }

  blocks.push(
    dividerBlock(),
    contextBlock(["Or type `event [brand name]` to search directly."]),
  );

  return blocks;
}

// --- Step 2.5: Event Confirmation ---

export function eventConfirmationBlocks(opts: {
  event: EventData;
  campaignEndDate: string;
  targetingRadius: number;
  targetingLocation: string;
  landingPageUrl: string;
  languages?: ("nl" | "fr")[];
}): SlackBlock[] {
  const { event, campaignEndDate, targetingRadius, targetingLocation, landingPageUrl, languages = ["nl", "fr"] } = opts;

  const langDisplay = languages.length === 2 ? "NL + FR (separate ad groups)" : languages[0].toUpperCase();

  const blocks: SlackBlock[] = [
    headerBlock(`Event: ${event.titleNl}`),
    sectionFields([
      `*Type:*\n${event.type === "physical" ? ":round_pushpin: Physical" : ":globe_with_meridians: Online"}`,
      `*Brands:*\n${event.brands.join(", ") || "—"}`,
      `*Event Dates:*\n${event.dateTextNl ?? "—"}`,
      `*Location:*\n${event.locationText ?? "—"}`,
    ]),
    dividerBlock(),
    headerBlock("Campaign Settings"),
    sectionFields([
      `*Campaign End Date:*\n${campaignEndDate}`,
      `*Ad Targeting:*\n${targetingRadius}km radius around ${targetingLocation}`,
      `*Languages:*\n${langDisplay}`,
      `*Landing Page:*\n${landingPageUrl}`,
    ]),
    dividerBlock(),
    actionsBlock([
      buttonElement("Confirm & Generate", "wizard_confirm_event", "confirm_event", "primary"),
      buttonElement("Change Radius", "wizard_change_radius", "change_radius"),
      buttonElement("Change End Date", "wizard_change_end", "change_end"),
      buttonElement("Cancel", "wizard_cancel", "cancel", "danger"),
    ], "wizard_event_confirm_actions"),
    contextBlock([
      "Modify: `radius 50km` · `end date YYYY-MM-DD` · `nl only` / `fr only` / `nl+fr` · `url https://...` · `confirm`",
    ]),
  ];

  return blocks;
}

// --- Step 3: Source Campaign Summary ---

export function sourceCampaignBlocks(
  structure: CampaignStructure,
  eventInfo?: { title: string; dates: string; type: string; url?: string },
): SlackBlock[] {
  const blocks: SlackBlock[] = [
    headerBlock(`Source: ${structure.name}`),
    sectionFields([
      `*Type:*\n${structure.type}`,
      `*Status:*\n${structure.status ?? "PAUSED"}`,
      `*Budget:*\n€${structure.budget.daily.toFixed(2)}/day`,
      `*Bidding:*\n${structure.bidding.strategy}`,
    ]),
  ];

  // Show ad groups summary
  for (const ag of structure.adGroups.slice(0, 3)) {
    const kwCount = ag.keywords.length;
    const adCount = ag.ads.length;
    blocks.push(
      sectionBlock(`*Ad Group: ${ag.name}*\n${kwCount} keywords · ${adCount} ads`),
    );
  }

  if (eventInfo) {
    blocks.push(
      dividerBlock(),
      sectionFields([
        `*Event Matched:*\n${eventInfo.title}`,
        `*Dates:*\n${eventInfo.dates}`,
        `*Type:*\n${eventInfo.type}`,
        eventInfo.url ? `*URL:*\n${eventInfo.url}` : `*URL:*\n—`,
      ]),
    );
  }

  return blocks;
}

// --- Step 4: Recommendation Review ---

export function recommendationBlocks(rec: WizardRecommendations): SlackBlock[] {
  const fields = [
    `*Budget:*\n€${rec.budget.dailyEuros}/day`,
    `*Targeting:*\n${rec.targeting.locations.join(", ")}`,
    `*Landing Page:*\n${rec.finalUrl}`,
    `*URL Paths:*\n${rec.path1}${rec.path2 ? ` / ${rec.path2}` : ""}`,
  ];
  if (rec.endDate) {
    fields.push(`*End Date:*\n${rec.endDate}`);
  }

  const blocks: SlackBlock[] = [
    headerBlock(rec.campaignName),
    sectionFields(fields),
    contextBlock([rec.budget.reasoning]),
    dividerBlock(),
  ];

  // NL Ad Copy
  blocks.push(sectionBlock("*Ad Copy (Dutch)*"));
  const nlHeadlines = rec.adCopy.nl.headlines
    .map((h) => `\`${h}\` (${h.length}/30)`)
    .join("\n");
  blocks.push(sectionBlock(`_Headlines (${rec.adCopy.nl.headlines.length}):_\n${nlHeadlines}`));

  const nlDescs = rec.adCopy.nl.descriptions
    .map((d) => `\`${d}\` (${d.length}/90)`)
    .join("\n");
  blocks.push(sectionBlock(`_Descriptions (${rec.adCopy.nl.descriptions.length}):_\n${nlDescs}`));

  blocks.push(dividerBlock());

  // FR Ad Copy
  blocks.push(sectionBlock("*Ad Copy (French)*"));
  const frHeadlines = rec.adCopy.fr.headlines
    .map((h) => `\`${h}\` (${h.length}/30)`)
    .join("\n");
  blocks.push(sectionBlock(`_Headlines (${rec.adCopy.fr.headlines.length}):_\n${frHeadlines}`));

  const frDescs = rec.adCopy.fr.descriptions
    .map((d) => `\`${d}\` (${d.length}/90)`)
    .join("\n");
  blocks.push(sectionBlock(`_Descriptions (${rec.adCopy.fr.descriptions.length}):_\n${frDescs}`));

  blocks.push(dividerBlock());

  // Keywords (grouped)
  const groups = new Map<string, typeof rec.keywords>();
  for (const kw of rec.keywords) {
    const existing = groups.get(kw.group) ?? [];
    existing.push(kw);
    groups.set(kw.group, existing);
  }

  const kwLines: string[] = [];
  for (const [group, kws] of groups) {
    kwLines.push(`_${group}:_ ${kws.map((k) => `\`${k.text}\` [${k.matchType}]`).join(", ")}`);
  }
  blocks.push(sectionBlock(`*Keywords (${rec.keywords.length}):*\n${kwLines.join("\n")}`));

  blocks.push(dividerBlock());

  // Action buttons
  blocks.push(
    actionsBlock([
      buttonElement("Confirm (API)", "wizard_confirm", "confirm", "primary"),
      buttonElement("Export CSV", "wizard_csv", "csv"),
      buttonElement("Regenerate Copy", "wizard_regenerate", "regenerate"),
      buttonElement("Cancel", "wizard_cancel", "cancel", "danger"),
    ], "wizard_review_actions"),
  );

  // Modification hints
  blocks.push(
    contextBlock([
      "Modify: `adjust budget to €X` · `end date YYYY-MM-DD` · `url https://...` · `path outlet/sale` · `target BE, NL` · `rename to ...` · `add/remove keyword ...`",
    ]),
  );

  return blocks;
}

// --- Step 5: Confirmation ---

export function confirmationBlocks(opts: {
  campaignName: string;
  type: string;
  budget: number;
  keywords: number;
  headlinesNl: number;
  headlinesFr: number;
  campaignResource: string;
  adGroupResource?: string;
  assetGroupResource?: string;
  warning?: string;
}): SlackBlock[] {
  const blocks: SlackBlock[] = [
    headerBlock("Campaign Created"),
    sectionFields([
      `*Name:*\n${opts.campaignName}`,
      `*Type:*\n${opts.type.toUpperCase()}`,
      `*Budget:*\n€${opts.budget}/day`,
      `*Status:*\nPAUSED`,
      `*Keywords:*\n${opts.keywords}`,
      `*Headlines:*\n${opts.headlinesNl} NL + ${opts.headlinesFr} FR`,
    ]),
    dividerBlock(),
    sectionBlock(`*Resource:* \`${opts.campaignResource}\``),
  ];

  if (opts.adGroupResource) {
    blocks.push(sectionBlock(`*Ad Group:* \`${opts.adGroupResource}\``));
  }
  if (opts.assetGroupResource) {
    blocks.push(sectionBlock(`*Asset Group:* \`${opts.assetGroupResource}\``));
  }

  if (opts.warning) {
    blocks.push(
      dividerBlock(),
      sectionBlock(`:warning: ${opts.warning}`),
    );
  }

  blocks.push(
    dividerBlock(),
    actionsBlock([
      buttonElement("Enable", "wizard_enable", "enable", "primary"),
      buttonElement("Update Budget", "wizard_update_budget", "adjust budget to"),
      buttonElement("Done", "wizard_done", "done"),
    ], "wizard_post_actions"),
    contextBlock([
      "Campaign is PAUSED. Use buttons above or type: `enable` · `pause` · `adjust budget to €X` · `end date YYYY-MM-DD` · `rename to ...` · `done`",
    ]),
  );

  return blocks;
}

// --- Error / Status blocks ---

export function errorBlock(message: string): SlackBlock[] {
  return [
    sectionBlock(`:x: ${message}`),
  ];
}

export function thinkingBlocks(action: string): SlackBlock[] {
  return [
    sectionBlock(`:hourglass_flowing_sand: ${action}...`),
  ];
}

// --- Context prompt (step awaiting_context) ---

export function contextPromptBlocks(campaignType: string): SlackBlock[] {
  return [
    headerBlock(`${campaignType.charAt(0).toUpperCase() + campaignType.slice(1)} Campaign`),
    sectionBlock("Tell me about the campaign. You can:"),
    sectionBlock("1. Paste an *event URL* from admin.shoppingeventvip.be (e.g. `admin.shoppingeventvip.be/items/event/123`) — I'll pull all event details automatically"),
    sectionBlock("2. Or describe the campaign: brand/product, landing page, and goal"),
    contextBlock([
      "Example: `https://admin.shoppingeventvip.be/items/event/42` or `RiverWoods winter sale, shoppingeventvip.be/river-woods, drive registrations`",
    ]),
  ];
}

// --- CSV Export ---

export function csvExportBlocks(csv: string, campaignName: string): SlackBlock[] {
  // Slack code blocks max out around 3000 chars, truncate if needed
  const truncated = csv.length > 2500 ? csv.slice(0, 2500) + "\n... (truncated)" : csv;

  return [
    headerBlock("Google Ads Editor CSV"),
    sectionBlock(`Campaign: *${campaignName}*\nCopy the CSV below and import into Google Ads Editor.`),
    sectionBlock(`\`\`\`\n${truncated}\n\`\`\``),
    contextBlock([
      "Paste into Google Ads Editor via *Account > Import > Paste text*",
    ]),
  ];
}
