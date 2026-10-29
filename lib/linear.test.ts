import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { issueLinks } from './linear.ts';

const keys = ['DEV', 'OPS', 'INT'];

describe('the issues a body links', () => {
  it('reads closing and non-closing words, in any case', () => {
    assert.deepEqual(issueLinks('Completes DEV-123\nfixes OPS-7\nPart of DEV-12', keys), { closes: ['DEV-123', 'OPS-7'], refs: ['DEV-12'] });
    assert.deepEqual(issueLinks('closed int-4. Resolving DEV-5', keys).closes, ['INT-4', 'DEV-5']);
  });

  it('reads every form of every word', () => {
    for (const word of ['Close', 'Closes', 'Closed', 'Closing', 'Fix', 'Fixes', 'Fixed', 'Fixing', 'Resolve', 'Resolves', 'Resolved', 'Resolving', 'Complete', 'Completes', 'Completed', 'Completing', 'Implement', 'Implements', 'Implemented', 'Implementing']) {
      assert.deepEqual(issueLinks(`${word} DEV-1`, keys).closes, ['DEV-1'], word);
    }
    for (const word of ['Ref', 'Refs', 'References', 'Part of', 'Related to', 'Contributes to', 'Toward', 'Towards', 'Updates']) {
      assert.deepEqual(issueLinks(`${word} DEV-1`, keys).refs, ['DEV-1'], word);
    }
  });

  it('reads an issue by its URL', () => {
    assert.deepEqual(issueLinks('Completes https://linear.app/always-chasing-ops/issue/DEV-123/weekly-report', keys).closes, ['DEV-123']);
  });

  it('names each issue once, in the order the body names it', () => {
    assert.deepEqual(issueLinks('Completes DEV-2\nCompletes DEV-1\nCloses DEV-2', keys).closes, ['DEV-2', 'DEV-1']);
  });

  it('counts only the teams given', () => {
    assert.deepEqual(issueLinks('Completes TEAM-9\nCompletes DEV-3', keys).closes, ['DEV-3']);
    assert.deepEqual(issueLinks('Completes DEV-3', ['INT']).closes, []);
  });

  it('needs the word, a space and a whole ID', () => {
    assert.deepEqual(issueLinks('DEV-1 is done', keys), { closes: [], refs: [] });
    assert.deepEqual(issueLinks('Completes DEV-', keys), { closes: [], refs: [] });
    assert.deepEqual(issueLinks('hotfixes DEV-1 and prefixes DEV-2', keys), { closes: [], refs: [] });
  });
});
