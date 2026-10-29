import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { brokenRules, issueIdIn, kindOf, PREFIXES, TEAM_KEYS, type PullRequest, type Rules } from './rules.ts';

/** Control Tower: a gate, and tasks may go straight to it. */
const gated: Rules = { gate: 'test', umbrellaOnly: false, prefixes: PREFIXES, teamKeys: TEAM_KEYS };
/** ECO: a gate, and every task goes through its umbrella. */
const umbrellas: Rules = { ...gated, gate: 'staging', umbrellaOnly: true };
/** The toolkit: no gate, everything goes to main. */
const direct: Rules = { ...gated, gate: null };

const task: PullRequest = {
  title: 'feat(estimate): add the weekly projection',
  branch: 'feature/weekly-projection',
  base: 'project/weekly-estimate',
  body: 'Lets Emilio open the week.\n\nCompletes DEV-123',
};
const umbrella: PullRequest = {
  title: 'feat(estimate): weekly estimate and deliverables',
  branch: 'project/weekly-estimate',
  base: 'test',
  body: 'Umbrella for the Linear project «Weekly estimate».',
};
const release: PullRequest = {
  title: 'chore: release the weekly estimate to production',
  branch: 'test',
  base: 'main',
  body: '| PR | What production gets |\n|---|---|\n| #12 | The weekly estimate |\n\nCompletes DEV-123',
};

const passes = (pr: PullRequest, rules: Rules) => assert.deepEqual(brokenRules(pr, rules), []);
const breaks = (pr: PullRequest, rules: Rules, rule: string) => {
  const broken = brokenRules(pr, rules);
  assert.equal(broken.length, 1, `expected one broken rule, got:\n${broken.join('\n')}`);
  assert.ok(broken[0]?.startsWith(`${rule} — `), `expected the ${rule} rule, got: ${broken[0]}`);
  return broken[0] ?? '';
};

describe('which kind a pull request is', () => {
  it('goes by its head branch', () => {
    assert.equal(kindOf('test', gated), 'release');
    assert.equal(kindOf('project/weekly-estimate', gated), 'umbrella');
    assert.equal(kindOf('dependabot/npm_and_yarn/test/next-16.4.3', gated), 'dependabot');
    assert.equal(kindOf('hotfix/next-security-patch', gated), 'hotfix');
    assert.equal(kindOf('feature/weekly-projection', gated), 'task');
  });

  it('has no release without a gate', () => {
    assert.equal(kindOf('test', direct), 'task');
  });
});

describe('the title', () => {
  it('is in Conventional Commits, with an optional scope and breaking mark', () => {
    for (const title of ['feat: add it', 'fix(auth)!: drop the old token', 'chore(deps-dev): Bump typescript', 'ci(deps): Bump zizmorcore/zizmor-action from 0.6.4 to 0.7.1']) {
      passes({ ...task, title }, gated);
    }
  });

  it('says how to write it when it is not', () => {
    for (const title of ['Add weekly projection', 'feature: add it', 'feat(Estimate): add it', 'feat:add it', '']) {
      const message = breaks({ ...task, title }, gated, 'Title');
      assert.match(message, /<type>\(<scope>\): <summary>/);
    }
  });

  it('applies to every kind', () => {
    breaks({ ...release, title: 'Release to production' }, gated, 'Title');
    breaks({ ...umbrella, title: 'Weekly estimate' }, gated, 'Title');
  });
});

describe('a task', () => {
  it('goes to its umbrella or to the branch it is stacked on', () => {
    passes(task, gated);
    passes({ ...task, base: 'docs/panel-layout-pattern' }, gated);
    passes(task, umbrellas);
    passes({ ...task, base: 'feature/weekly-report' }, umbrellas);
  });

  it('may go straight to the gate, unless tasks go only through umbrellas', () => {
    passes({ ...task, base: 'test' }, gated);
    const message = breaks({ ...task, base: 'staging' }, umbrellas, 'Base');
    assert.match(message, /a task goes to its project\/<slug> umbrella, or to the branch it is stacked on, not to "staging"/);
  });

  it('never goes to main when there is a gate', () => {
    assert.match(breaks({ ...task, base: 'main' }, gated, 'Base'), /a task goes to test, to its project\/<slug> umbrella/);
    breaks({ ...task, base: 'main' }, umbrellas, 'Base');
  });

  it('goes to main when there is no gate', () => {
    passes({ ...task, base: 'main', body: 'Closes INT-45' }, direct);
    breaks({ ...task, base: 'test' }, direct, 'Base');
  });

  it('needs a known prefix and a kebab-case slug', () => {
    for (const branch of ['feat/weekly-projection', 'feature/Weekly_Projection', 'feature/weekly--projection', 'weekly-projection']) {
      assert.match(breaks({ ...task, branch }, gated, 'Branch'), /Use a prefix from: feature, bugfix/);
    }
  });

  it('takes the prefixes it is given', () => {
    const rules = { ...gated, prefixes: ['feature', 'spike'] };
    passes({ ...task, branch: 'spike/try-kapso' }, rules);
    breaks({ ...task, branch: 'chore/bump-node' }, rules, 'Branch');
  });

  it('keeps the issue ID out of the branch, but not a number in the slug', () => {
    for (const branch of ['feature/dev-123-weekly-projection', 'feature/weekly-projection-dev-123', 'feature/ops-7']) {
      assert.match(breaks({ ...task, branch }, gated, 'Branch'), /carries the issue ID (DEV-123|OPS-7)/);
    }
    passes({ ...task, branch: 'feature/import-step-2' }, gated);
    passes({ ...task, branch: 'feature/devops-2' }, gated);
  });

  it('links its issue with a closing or non-closing magic word, by ID or URL', () => {
    for (const body of ['Part of DEV-12', 'fixes OPS-7', 'Completes https://linear.app/always-chasing-ops/issue/DEV-123/weekly-projection']) {
      passes({ ...task, body }, gated);
    }
  });

  it('says how to link it when it does not', () => {
    for (const body of ['', 'DEV-123', 'Completes DEV-', 'Completes TEAM-123']) {
      assert.match(breaks({ ...task, body }, gated, 'Body'), /"Completes DEV-123", or "Part of DEV-123"/);
    }
  });

  it('links an issue of the teams it is given', () => {
    const toolkit = { ...direct, teamKeys: ['INT'] };
    passes({ ...task, base: 'main', body: 'Closes INT-46' }, toolkit);
    assert.match(breaks({ ...task, base: 'main', body: 'Closes DEV-46' }, toolkit, 'Body'), /"Completes INT-123".*Teams: INT\./);
  });

  it('reports every rule it breaks', () => {
    assert.deepEqual(brokenRules({ title: 'stuff', branch: 'dev-1', base: 'main', body: '' }, gated).map((rule) => rule.split(' — ')[0]), ['Title', 'Base', 'Branch', 'Branch', 'Body']);
  });
});

describe('a hotfix', () => {
  const hotfix: PullRequest = { ...task, branch: 'hotfix/next-security-patch', base: 'test', body: 'Fixes DEV-400' };

  it('goes to the gate, or to main without one', () => {
    passes(hotfix, gated);
    passes({ ...hotfix, base: 'staging' }, umbrellas);
    passes({ ...hotfix, base: 'main' }, direct);
    assert.match(breaks({ ...hotfix, base: 'main' }, gated, 'Base'), /a hotfix goes to test, and reaches main with the next release/);
  });

  it('follows a task branch’s name and link', () => {
    breaks({ ...hotfix, branch: 'hotfix/dev-400' }, gated, 'Branch');
    breaks({ ...hotfix, body: '' }, gated, 'Body');
  });
});

describe('an umbrella', () => {
  it('goes to the gate, or to main without one', () => {
    passes(umbrella, gated);
    passes({ ...umbrella, base: 'staging' }, umbrellas);
    passes({ ...umbrella, base: 'main' }, direct);
    assert.match(breaks({ ...umbrella, base: 'main' }, gated, 'Base'), /an umbrella goes to test/);
  });

  it('may carry the Completes of its issues, or none', () => {
    passes({ ...umbrella, body: 'Completes DEV-5\nCompletes DEV-6' }, gated);
  });

  it('is project/<kebab-slug>, without the issue ID', () => {
    assert.match(breaks({ ...umbrella, branch: 'project/Weekly_Estimate' }, gated, 'Branch'), /is not project\/<slug>/);
    assert.match(breaks({ ...umbrella, branch: 'project/dev-5-weekly-estimate' }, gated, 'Branch'), /carries the issue ID DEV-5/);
  });
});

describe('a release', () => {
  it('goes from the gate to main, with the Completes of what it releases', () => {
    passes(release, gated);
    passes({ ...release, branch: 'staging' }, umbrellas);
    assert.match(breaks({ ...release, base: 'project/weekly-estimate' }, gated, 'Base'), /the release goes from test to main/);
  });

  it('needs no magic word here: what it releases decides that', () => {
    passes({ ...release, body: 'Only Dependabot updates.' }, gated);
  });
});

describe("Dependabot's updates", () => {
  const update: PullRequest = { title: 'chore(deps): Bump next from 16.4.2 to 16.4.3', branch: 'dependabot/npm_and_yarn/test/next-16.4.3', base: 'test', body: 'Bumps next.' };

  it('go to the gate without an issue', () => {
    passes(update, gated);
    passes({ ...update, base: 'main' }, direct);
  });

  it('say where to set the branch when they go elsewhere', () => {
    assert.match(breaks({ ...update, base: 'main' }, gated, 'Base'), /Set target-branch: test in \.github\/dependabot\.yml/);
  });
});

describe('the issue ID in a branch', () => {
  it('is found next to a slash or a hyphen, in any case', () => {
    assert.equal(issueIdIn('feature/dev-123-weekly', TEAM_KEYS), 'DEV-123');
    assert.equal(issueIdIn('chase/int-45-feat-draft', TEAM_KEYS), 'INT-45');
    assert.equal(issueIdIn('feature/weekly-dev-123', TEAM_KEYS), 'DEV-123');
    assert.equal(issueIdIn('feature/devops-2', TEAM_KEYS), null);
    assert.equal(issueIdIn('feature/dev-1a', TEAM_KEYS), null);
  });
});
