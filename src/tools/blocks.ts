/**
 * Block Kit builder helpers — thin wrappers producing Slack Block Kit JSON.
 * No external dependencies. Type-safe builder pattern.
 */
import type { SlackBlock } from "./slack.js";

// --- Block Builders ---

export function headerBlock(text: string): SlackBlock {
  return {
    type: "header",
    text: { type: "plain_text", text: text.slice(0, 150), emoji: true },
  };
}

export function sectionBlock(text: string): SlackBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: text.slice(0, 3000) },
  };
}

export function sectionWithAccessory(text: string, accessory: Record<string, any>): SlackBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: text.slice(0, 3000) },
    accessory,
  };
}

export function sectionFields(fields: string[]): SlackBlock {
  return {
    type: "section",
    fields: fields.slice(0, 10).map((f) => ({
      type: "mrkdwn",
      text: f.slice(0, 2000),
    })),
  };
}

export function dividerBlock(): SlackBlock {
  return { type: "divider" };
}

export function contextBlock(elements: string[]): SlackBlock {
  return {
    type: "context",
    elements: elements.slice(0, 10).map((e) => ({
      type: "mrkdwn",
      text: e,
    })),
  };
}

export function actionsBlock(elements: Record<string, any>[], blockId?: string): SlackBlock {
  const block: SlackBlock = {
    type: "actions",
    elements: elements.slice(0, 25),
  };
  if (blockId) block.block_id = blockId;
  return block;
}

// --- Element Builders ---

export function buttonElement(
  text: string,
  actionId: string,
  value: string,
  style?: "primary" | "danger",
): Record<string, any> {
  const btn: Record<string, any> = {
    type: "button",
    text: { type: "plain_text", text: text.slice(0, 75), emoji: true },
    action_id: actionId,
    value: value.slice(0, 2000),
  };
  if (style) btn.style = style;
  return btn;
}

export function confirmDialog(
  title: string,
  text: string,
  confirm: string = "Yes",
  deny: string = "Cancel",
  style?: "danger",
): Record<string, any> {
  const dialog: Record<string, any> = {
    title: { type: "plain_text", text: title.slice(0, 100) },
    text: { type: "mrkdwn", text: text.slice(0, 300) },
    confirm: { type: "plain_text", text: confirm.slice(0, 30) },
    deny: { type: "plain_text", text: deny.slice(0, 30) },
  };
  if (style) dialog.style = style;
  return dialog;
}

export function staticSelect(
  actionId: string,
  placeholder: string,
  options: Array<{ text: string; value: string }>,
): Record<string, any> {
  return {
    type: "static_select",
    action_id: actionId,
    placeholder: { type: "plain_text", text: placeholder.slice(0, 150) },
    options: options.slice(0, 100).map((o) => ({
      text: { type: "plain_text", text: o.text.slice(0, 75) },
      value: o.value.slice(0, 150),
    })),
  };
}

export function overflowMenu(
  actionId: string,
  options: Array<{ text: string; value: string }>,
): Record<string, any> {
  return {
    type: "overflow",
    action_id: actionId,
    options: options.slice(0, 5).map((o) => ({
      text: { type: "plain_text", text: o.text.slice(0, 75) },
      value: o.value.slice(0, 150),
    })),
  };
}
