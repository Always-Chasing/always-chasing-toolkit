/**
 * The one way out to Slack: an incoming webhook, an address that can only
 * post to the channel it was created for. Nothing but `hooks.slack.com` is
 * posted to, and the address never reaches a log or an error — Slack's answer
 * does, a short code such as `channel_not_found`.
 *
 * Every project posts through the same app, so every message starts with the
 * project's name.
 */

/** What Slack may take to answer. */
const TIMEOUT_MS = 30_000;

/** Slack mrkdwn treats these three as control characters; text from outside is escaped before it is quoted. */
export function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function link(url: string, label: string): string {
  return `<${url}|${escape(label)}>`;
}

/** A message as it goes out: the project's name first, then what happened. */
export function headed(project: string, text: string): string {
  return `*${escape(project)}* · ${text}`;
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

export async function postToSlack(raw: string | undefined, text: string): Promise<void> {
  const webhook = slackWebhook(raw);
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Slack refused the message: ${response.status} ${(await response.text()).slice(0, 100)}`);
}
