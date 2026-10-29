import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  byIssue,
  checkBody,
  compareWithInTest,
  linkedToOpenPullRequests,
  pullRequestNumbers,
  releaseBody,
  releaseOf,
  whatProductionGets,
  type MergedPullRequest,
} from './release.ts';

const keys = ['DEV', 'OPS', 'INT'];

const pr = (number: number, base: string, head: string, title: string, body = ''): MergedPullRequest => ({ number, base, head, title, body });

// Control Tower's release #324, as it entered test.
const board = pr(326, 'test', 'feature/opportunities-board', 'feat(opportunities): follow every opportunity on a board by stage', 'Completes DEV-275\nCompletes DEV-370\nCompletes DEV-373\nCompletes DEV-374');
const metaCheck = pr(316, 'test', 'chore/real-template-check', 'chore(whatsapp): check with real Meta that an approved text goes out on its own', 'Completes DEV-375');
// An umbrella with its own Completes, and the tasks that entered it.
const umbrella = pr(285, 'test', 'project/opportunity-registration', 'feat: register opportunities from the panel', 'Completes DEV-127\nCompletes DEV-144');
const task = pr(280, 'project/opportunity-registration', 'feature/offer-measures', 'feat(panel): ask for the measures of the offer', 'Completes DEV-144');
const partial = pr(281, 'project/opportunity-registration', 'feature/offer-documents', 'feat(panel): add the documents step', 'Part of DEV-150');
const sync = pr(282, 'project/opportunity-registration', 'main', 'chore: bring main into the umbrella', 'Completes DEV-1');
const dependabot = pr(320, 'test', 'dependabot/npm_and_yarn/test/development', 'chore(deps-dev): Bump the development group | 5 updates');

describe('the pull requests a range of commits names', () => {
  it('reads squashes and merges, once each, in order', () => {
    const messages = [
      'feat(opportunities): follow every opportunity on a board by stage (#326)\n\nCompletes DEV-275',
      'Merge pull request #285 from Always-Chasing/project/opportunity-registration\n\nfeat: register opportunities from the panel',
      'chore(whatsapp): check with real Meta (#316)',
      'feat(opportunities): follow every opportunity on a board by stage (#326)',
    ];
    assert.deepEqual(pullRequestNumbers(messages), [285, 316, 326]);
  });

  it('takes the last number of a revert, which is the revert itself', () => {
    assert.deepEqual(pullRequestNumbers(['Revert "feat: x (#12)" (#13)']), [13]);
  });

  it('names none for a commit without a pull request', () => {
    assert.deepEqual(pullRequestNumbers(["Merge branch 'main' into project/whatsapp-inbox", 'fix: a typo', 'see #12 for why', '']), []);
  });
});

describe('a release', () => {
  it('has a row for each pull request that entered the gate itself', () => {
    const release = releaseOf('test', 319, [board, metaCheck, umbrella, task, dependabot], keys);
    assert.deepEqual(release.rows.map((row) => row.number), [285, 316, 320, 326]);
  });

  it('completes every issue a pull request of it finishes, umbrellas and their tasks alike, once each', () => {
    const release = releaseOf('test', 319, [board, metaCheck, umbrella, task], keys);
    assert.deepEqual(release.completes.map((issue) => issue.id), ['DEV-127', 'DEV-144', 'DEV-275', 'DEV-370', 'DEV-373', 'DEV-374', 'DEV-375']);
    assert.deepEqual(release.completes.find((issue) => issue.id === 'DEV-144')?.pullRequests, [280, 285]);
  });

  it('leaves open the issues it only works on, unless another pull request finishes them', () => {
    assert.deepEqual(releaseOf('test', null, [umbrella, partial], keys).stillOpen, [{ id: 'DEV-150', pullRequests: [281] }]);
    const finished = pr(290, 'project/opportunity-registration', 'feature/offer-documents-end', 'feat(panel): finish the documents step', 'Completes DEV-150');
    const release = releaseOf('test', null, [umbrella, partial, finished], keys);
    assert.deepEqual(release.stillOpen, []);
    assert.ok(release.completes.some((issue) => issue.id === 'DEV-150'));
  });

  it('leaves out a sync from main, whose commits production has', () => {
    const release = releaseOf('test', null, [umbrella, sync], keys);
    assert.ok(!release.completes.some((issue) => issue.id === 'DEV-1'));
  });

  it('counts only the teams given', () => {
    const old = pr(300, 'test', 'feature/old', 'feat: old', 'Completes TEAM-9\nCompletes OPS-4');
    assert.deepEqual(releaseOf('test', null, [old], keys).completes.map((issue) => issue.id), ['OPS-4']);
  });
});

describe('the body of a release', () => {
  it('lists the rows and a Completes line per issue, as Control Tower writes them', () => {
    const body = releaseBody(releaseOf('test', 319, [board, metaCheck], keys));
    assert.equal(
      body,
      [
        '## What this PR does',
        '',
        'Releases to production what entered `test` since the previous release (#319):',
        '',
        '| PR | What production gets |',
        '|---|---|',
        '| #316 | Check with real Meta that an approved text goes out on its own |',
        '| #326 | Follow every opportunity on a board by stage |',
        '',
        '## Why',
        '',
        'Completes DEV-275',
        'Completes DEV-370',
        'Completes DEV-373',
        'Completes DEV-374',
        'Completes DEV-375',
        '',
      ].join('\n'),
    );
  });

  it('names what stays open with bare IDs, which link nothing', () => {
    const body = releaseBody(releaseOf('test', null, [umbrella, partial], keys));
    assert.match(body, /Releases to production what entered `test`:/);
    assert.match(body, /\nStill open after this release: DEV-150 \(#281\)\.\n$/);
    assert.doesNotMatch(body, /Part of DEV-150/);
  });

  it('says when nothing in it finishes an issue', () => {
    const body = releaseBody(releaseOf('test', 330, [dependabot], keys));
    assert.match(body, /\| #320 \| Bump the development group \\\| 5 updates \|/);
    assert.match(body, /No pull request in this release finishes a Linear issue\./);
  });
});

describe("a row's words", () => {
  it('drop the type and the scope, and start in capitals', () => {
    assert.equal(whatProductionGets('feat(opportunities)!: drag a card'), 'Drag a card');
    assert.equal(whatProductionGets('ci(deps): Bump zizmor'), 'Bump zizmor');
    assert.equal(whatProductionGets('A title without a type'), 'A title without a type');
  });
});

describe('a release body against what it releases', () => {
  const release = releaseOf('test', 324, [pr(327, 'test', 'chore/alerts-through-toolkit', 'chore(ci): post alerts through the toolkit', 'Completes DEV-372')], keys);

  it('misses an issue it does not complete — release #329', () => {
    const body = '| PR | What production gets |\n|---|---|\n| #327 | Nothing a user sees. |';
    assert.deepEqual(checkBody(release, body, keys), { missing: [{ id: 'DEV-372', pullRequests: [327] }], extra: [] });
  });

  it('holds when it completes them all, by any closing word', () => {
    assert.deepEqual(checkBody(release, 'Fixes DEV-372', keys), { missing: [], extra: [] });
    assert.deepEqual(checkBody(release, 'Part of DEV-372', keys).missing.length, 1);
  });

  it('tells apart what it completes beyond the release', () => {
    assert.deepEqual(checkBody(release, 'Completes DEV-372\nCompletes DEV-9', keys).extra, ['DEV-9']);
  });
});

describe('a release against Linear', () => {
  const release = releaseOf('test', 324, [board, metaCheck], keys);
  const states = new Map([
    ['DEV-275', 'In Test'],
    ['DEV-370', 'In Test'],
    ['DEV-373', 'In Test'],
    ['DEV-374', 'In Review'],
  ]);
  const inTest = [
    { id: 'DEV-275', title: 'a', state: 'In Test' },
    { id: 'DEV-370', title: 'b', state: 'In Test' },
    { id: 'DEV-373', title: 'c', state: 'In Test' },
    { id: 'DEV-399', title: 'Forgotten', state: 'In Test' },
  ];

  it('names what the release completes outside In Test, and what In Test has outside the release', () => {
    const comparison = compareWithInTest(release, 'DEV', 'In Test', inTest, states);
    assert.deepEqual(
      comparison.notInTest.map(({ issue, state }) => [issue.id, state]),
      [
        ['DEV-374', 'In Review'],
        ['DEV-375', null],
      ],
    );
    assert.deepEqual(comparison.notReleased.map((issue) => issue.id), ['DEV-399']);
  });

  it('agrees when both lists are the same', () => {
    const same = new Map([...release.completes].map((issue) => [issue.id, 'In Test']));
    const comparison = compareWithInTest(release, 'DEV', 'In Test', [...same.keys()].map((id) => ({ id, title: id, state: 'In Test' })), same);
    assert.deepEqual(comparison, { notInTest: [], notReleased: [] });
  });

  it('compares only the team it is given', () => {
    const other = releaseOf('test', null, [pr(1, 'test', 'feature/x', 'feat: x', 'Completes OPS-4')], keys);
    assert.deepEqual(compareWithInTest(other, 'DEV', 'In Test', [], new Map()).notInTest, []);
  });
});

describe('an issue an open pull request still links', () => {
  const release = releaseOf('test', 329, [pr(333, 'test', 'chore/shared-pr-rules', 'ci: check every pull request', 'Completes DEV-401')], keys);
  const open = (number: number, body: string, title = 'docs: a note', head = 'docs/a-note', base = 'test') => ({ number, title, body, base, head });

  it('is named with the pull requests that link it — DEV-401 and #337 after release #334', () => {
    assert.deepEqual(linkedToOpenPullRequests(release, [open(337, 'Part of DEV-401'), open(340, 'Completes DEV-9')], keys), [{ id: 'DEV-401', pullRequests: [337] }]);
  });

  it('counts a closing word, an ID in the title or in the branch, as Linear does', () => {
    for (const linking of [open(1, 'Fixes DEV-401'), open(2, '', 'docs: follow up DEV-401'), open(3, '', 'docs: a note', 'docs/dev-401-follow-up')]) {
      assert.equal(linkedToOpenPullRequests(release, [linking], keys).length, 1, JSON.stringify(linking));
    }
  });

  it('leaves out the release itself, and an issue whose number only starts the same', () => {
    assert.deepEqual(linkedToOpenPullRequests(release, [open(334, 'Completes DEV-401', 'chore: release', 'test', 'main'), open(5, 'Part of DEV-4010'), open(6, '', 'XDEV-401')], keys), []);
  });
});

describe('issue IDs', () => {
  it('sort by team, then by number', () => {
    assert.deepEqual(['DEV-10', 'INT-2', 'DEV-9', 'DEV-100'].sort(byIssue), ['DEV-9', 'DEV-10', 'DEV-100', 'INT-2']);
  });
});
