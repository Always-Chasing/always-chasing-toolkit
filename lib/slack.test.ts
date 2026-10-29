import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { escape, headed, link, slackWebhook } from './slack.ts';

describe('the webhook', () => {
  it('is an https address on hooks.slack.com', () => {
    assert.equal(slackWebhook(' https://hooks.slack.com/services/T0/B0/x \n').hostname, 'hooks.slack.com');
  });

  it('is refused otherwise, without repeating the address', () => {
    for (const wrong of [undefined, '', 'hooks.slack.com/services/x', 'http://hooks.slack.com/services/x', 'https://hooks.slack.com.evil.example/services/x']) {
      assert.throws(
        () => slackWebhook(wrong),
        (error: unknown) => error instanceof Error && !(wrong && wrong !== '' && error.message.includes(wrong)),
      );
    }
  });
});

describe('the markup', () => {
  it('escapes what Slack would read as markup', () => {
    assert.equal(escape('<!channel> & <b>'), '&lt;!channel&gt; &amp; &lt;b&gt;');
    assert.equal(link('https://example.com', 'a <b>'), '<https://example.com|a &lt;b&gt;>');
  });

  it('starts every message with the project', () => {
    assert.equal(headed('Control Tower', '✅ done'), '*Control Tower* · ✅ done');
  });
});
