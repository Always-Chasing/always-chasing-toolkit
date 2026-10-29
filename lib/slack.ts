/**
 * The one way out to Slack: an incoming webhook, an address that can only
 * post to the channel it was created for. Nothing but `hooks.slack.com` is
 * posted to, and the address never reaches a log or an error — Slack's answer
 * does, a short code such as `channel_not_found`.
 *
 * Every project posts through the same app, so every message starts with the
 * project's name. Every message has the same shape, made to be read at a
 * glance: a title that says only what happened, and under it a card with a
 * color bar — its steps as a line of icons, a table of two columns, a list
 * when there is one, and a footer with where to look.
 */

/** What Slack may take to answer. */
const TIMEOUT_MS = 30_000;
/** Slack takes up to 10 fields in a section, and 3,000 characters in a section's text. */
const FIELDS_PER_SECTION = 10;
const SECTION_TEXT = 3_000;

/** Slack mrkdwn treats these three as control characters; text from outside is escaped before it is quoted. */
export function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function link(url: string, label: string): string {
  return `<${url}|${escape(label)}>`;
}

/** The color bar: what kind of news it is, before anyone reads a word. */
export type Tone = 'ready' | 'good' | 'bad' | 'warning';

export const COLORS: Record<Tone, string> = {
  /** Something to try: `test` is ready. */
  ready: '#2563EB',
  /** Production took a release, or got well again. */
  good: '#16A34A',
  /** A deploy failed or got stuck. */
  bad: '#DC2626',
  /** Production has a problem. */
  warning: '#D97706',
};

export type StepState = 'done' | 'failed' | 'held' | 'waiting';

const STEP_ICONS: Record<StepState, string> = { done: '✅', failed: '❌', held: '⏸', waiting: '⏳' };

export interface Step {
  state: StepState;
  label: string;
}

export interface Field {
  /** Plain text. */
  label: string;
  /** Slack mrkdwn, already escaped. */
  value: string;
}

export interface Message {
  /** Only what happened, starting with the project: «Control Tower · test is ready to try». Plain text. */
  title: string;
  tone: Tone;
  /** What the thing went through, as a line: ✅ Code built → ✅ Database updated → ✅ Site live. */
  steps?: Step[];
  /** One sentence above the table, in mrkdwn. */
  note?: string;
  /** The table, two columns wide. */
  fields?: Field[];
  /** A list under the table, such as «What's new (3)»: its label in plain text and its lines in mrkdwn. */
  list?: { label: string; items: string[] };
  /** The footer's pieces, in mrkdwn: where to look next. */
  footer?: string[];
}

/** A title: the project first, then what happened. */
export function titled(project: string, what: string): string {
  return `${project} · ${what}`;
}

export function stepsLine(steps: readonly Step[]): string {
  return steps.map((step) => `${STEP_ICONS[step.state]} ${step.label}`).join(' → ');
}

/** A list's text, cut where Slack would refuse it, saying how many lines were left out. */
function listText(label: string, items: readonly string[]): string {
  let text = `*${escape(label)}*`;
  for (const [index, item] of items.entries()) {
    const rest = items.length - index;
    const more = `\n… and ${rest} more`;
    if (text.length + 1 + item.length + (rest > 1 ? more.length : 0) > SECTION_TEXT) return `${text}${more}`;
    text += `\n${item}`;
  }
  return text;
}

/**
 * What goes to the webhook: the title as the message's text — bold, and what a
 * notification shows — and one attachment with the color bar and the blocks.
 */
export function payload(message: Message): Record<string, unknown> {
  const mrkdwn = (text: string) => ({ type: 'mrkdwn', text });
  const blocks: Record<string, unknown>[] = [];
  if (message.steps && message.steps.length > 0) blocks.push({ type: 'section', text: mrkdwn(stepsLine(message.steps)) });
  if (message.note) blocks.push({ type: 'section', text: mrkdwn(message.note) });
  const fields = message.fields ?? [];
  for (let start = 0; start < fields.length; start += FIELDS_PER_SECTION) {
    const section = fields.slice(start, start + FIELDS_PER_SECTION);
    blocks.push({ type: 'section', fields: section.map((field) => mrkdwn(`*${escape(field.label)}*\n${field.value}`)) });
  }
  if (message.list && message.list.items.length > 0) blocks.push({ type: 'section', text: mrkdwn(listText(message.list.label, message.list.items)) });
  if (message.footer && message.footer.length > 0) blocks.push({ type: 'context', elements: [mrkdwn(message.footer.join('  ·  '))] });
  return {
    text: `*${escape(message.title)}*`,
    attachments: [{ color: COLORS[message.tone], fallback: message.title, blocks }],
    unfurl_links: false,
    unfurl_media: false,
  };
}

/** Slack's links, `<url|label>`, as `label (url)`: how a log or a run's summary shows a message. */
function unlinked(mrkdwn: string): string {
  return mrkdwn
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** The message as plain lines, for logs and dry runs. */
export function plainText(message: Message): string {
  const lines = [`${message.title}  [${message.tone}]`];
  if (message.steps && message.steps.length > 0) lines.push(stepsLine(message.steps));
  if (message.note) lines.push(unlinked(message.note));
  for (const field of message.fields ?? []) lines.push(`${field.label}: ${unlinked(field.value)}`);
  if (message.list && message.list.items.length > 0) lines.push(`${message.list.label}:`, ...message.list.items.map(unlinked));
  if (message.footer && message.footer.length > 0) lines.push(unlinked(message.footer.join(' · ')));
  return lines.join('\n');
}

/** The webhook, once it is known to be one: an https address on `hooks.slack.com`. */
export function slackWebhook(raw: string | undefined): URL {
  const address = raw?.trim() ?? '';
  if (address === '') throw new Error('SLACK_WEBHOOK_URL is not set: the message has nowhere to go');
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('SLACK_WEBHOOK_URL is not a URL: nothing was posted');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com') throw new Error('SLACK_WEBHOOK_URL is not a Slack webhook: nothing was posted');
  return url;
}

export async function postToSlack(raw: string | undefined, message: Message): Promise<void> {
  const webhook = slackWebhook(raw);
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload(message)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Slack refused the message: ${response.status} ${(await response.text()).slice(0, 100)}`);
}
