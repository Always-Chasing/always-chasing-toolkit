import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COLORS, escape, link, payload, plainText, slackWebhook, stepsLine, titled, type Message } from './slack.ts';

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

  it('starts every title with the project', () => {
    assert.equal(titled('Control Tower', 'test is ready to try'), 'Control Tower · test is ready to try');
  });
});

const message: Message = {
  title: 'Control Tower · production updated',
  tone: 'good',
  steps: [
    { state: 'done', label: 'Code built' },
    { state: 'failed', label: 'Database updated' },
    { state: 'held', label: 'Site held back' },
    { state: 'waiting', label: 'Later' },
  ],
  fields: [
    { label: 'Release', value: '<https://github.com/o/r/pull/9|#9 Release>' },
    { label: 'Commit', value: '<https://github.com/o/r/commit/abc|abc1234>' },
  ],
  list: { label: "What's new (1)", items: ['• <https://github.com/o/r/pull/8|#8> A &amp; b'] },
  footer: ['<https://example.com|Open production>'],
};

describe('a message', () => {
  it('draws its steps as a line of icons', () => {
    assert.equal(stepsLine(message.steps ?? []), '✅ Code built → ❌ Database updated → ⏸ Site held back → ⏳ Later');
  });

  it('goes out as a bold title and one attachment with the color bar and its blocks, in order', () => {
    const sent = payload(message) as { text: string; attachments: { color: string; fallback: string; blocks: { type: string }[] }[] };
    assert.equal(sent.text, '*Control Tower · production updated*');
    assert.equal(sent.attachments.length, 1);
    assert.equal(sent.attachments[0]?.color, COLORS.good);
    assert.equal(sent.attachments[0]?.fallback, 'Control Tower · production updated');
    assert.deepEqual(
      sent.attachments[0]?.blocks.map((block) => block.type),
      ['section', 'section', 'section', 'context'],
    );
    assert.deepEqual((sent.attachments[0]?.blocks[1] as { fields?: unknown }).fields, [
      { type: 'mrkdwn', text: '*Release*\n<https://github.com/o/r/pull/9|#9 Release>' },
      { type: 'mrkdwn', text: '*Commit*\n<https://github.com/o/r/commit/abc|abc1234>' },
    ]);
  });

  it('escapes the title, which is the one plain text in it', () => {
    assert.equal((payload({ title: 'A <b> & co · up', tone: 'ready' }) as { text: string }).text, '*A &lt;b&gt; &amp; co · up*');
  });

  it('splits more than 10 rows across sections, and cuts a list too long for Slack', () => {
    const fields = Array.from({ length: 12 }, (_, index) => ({ label: `Check ${index}`, value: 'failing' }));
    const items = Array.from({ length: 200 }, (_, index) => `• #${index} ${'a long title '.repeat(3)}`);
    const sent = payload({ title: 't', tone: 'warning', fields, list: { label: 'Many', items } }) as { attachments: { blocks: { fields?: unknown[]; text?: { text: string } }[] }[] };
    const blocks = sent.attachments[0]?.blocks ?? [];
    assert.deepEqual(blocks.slice(0, 2).map((block) => block.fields?.length), [10, 2]);
    const list = blocks[2]?.text?.text ?? '';
    assert.ok(list.length <= 3000, `${list.length}`);
    assert.match(list, /\n… and \d+ more$/);
  });

  it('reads as plain lines in a log, with its links spelled out', () => {
    assert.equal(
      plainText(message),
      [
        'Control Tower · production updated  [good]',
        '✅ Code built → ❌ Database updated → ⏸ Site held back → ⏳ Later',
        'Release: #9 Release (https://github.com/o/r/pull/9)',
        'Commit: abc1234 (https://github.com/o/r/commit/abc)',
        "What's new (1):",
        '• #8 (https://github.com/o/r/pull/8) A & b',
        'Open production (https://example.com)',
      ].join('\n'),
    );
  });
});
