/**
 * The Git conventions of every Always Chasing repo, as rules a pull request
 * either keeps or breaks: its title, its branch, the branch it points to and
 * its link to Linear. Each broken rule comes back as one message that says
 * which rule and how to fix it.
 *
 * A pull request is told apart by its head branch:
 *
 *   release     the gate → `main`, in a repo with a gate
 *   umbrella    `project/<slug>` → the gate, or `main` without one
 *   dependabot  `dependabot/…` → the gate, or `main`
 *   hotfix      `hotfix/<slug>` → the gate, or `main`
 *   task        anything else → its umbrella, the branch it is stacked on,
 *               or — unless tasks go only through umbrellas — the gate or `main`
 */
import { issueLinks } from '../lib/linear.ts';

export const MAIN = 'main';
export const TYPES = ['feat', 'fix', 'refactor', 'style', 'test', 'docs', 'chore', 'perf', 'ci', 'build', 'revert'];
export const PREFIXES = ['feature', 'bugfix', 'qafix', 'improvement', 'hotfix', 'refactor', 'docs', 'chore', 'perf', 'test'];
export const TEAM_KEYS = ['DEV', 'OPS', 'INT'];

export interface Rules {
  /** Where someone outside validates before production, such as `test`; null when pull requests go straight to `main`. */
  gate: string | null;
  /** Whether a task reaches the gate only through its `project/<slug>` umbrella. */
  umbrellaOnly: boolean;
  prefixes: string[];
  teamKeys: string[];
}

export interface PullRequest {
  title: string;
  /** The head branch. */
  branch: string;
  base: string;
  body: string;
}

export type Kind = 'release' | 'umbrella' | 'dependabot' | 'hotfix' | 'task';

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const TITLE = new RegExp(`^(?:${TYPES.join('|')})(?:\\([a-z0-9-]+\\))?!?: \\S`);
const UMBRELLA = new RegExp(`^project/${SLUG}$`);

const taskBranch = (rules: Rules) => new RegExp(`^(?:${rules.prefixes.join('|')})/${SLUG}$`);

export function kindOf(branch: string, rules: Rules): Kind {
  if (rules.gate !== null && branch === rules.gate) return 'release';
  if (branch.startsWith('project/')) return 'umbrella';
  if (branch.startsWith('dependabot/')) return 'dependabot';
  if (branch.startsWith('hotfix/')) return 'hotfix';
  return 'task';
}

/** The issue ID a branch name carries, such as `DEV-123` in `feature/dev-123-weekly-report`. */
export function issueIdIn(branch: string, teamKeys: readonly string[]): string | null {
  const match = new RegExp(`(?:^|[/-])((?:${teamKeys.join('|')})-\\d+)(?=$|-)`, 'i').exec(branch);
  return match?.[1]?.toUpperCase() ?? null;
}

/** Where each kind may point, in the words a message uses, and how to fix it when it points elsewhere. */
function basesFor(kind: Kind, rules: Rules): { allowed: (base: string) => boolean; wanted: string; fix?: string } {
  const entry = rules.gate ?? MAIN;
  switch (kind) {
    case 'release':
      return { allowed: (base) => base === MAIN, wanted: `the release goes from ${entry} to ${MAIN}` };
    case 'umbrella':
      return { allowed: (base) => base === entry, wanted: `an umbrella goes to ${entry}` };
    case 'dependabot':
      return {
        allowed: (base) => base === entry,
        wanted: `Dependabot's updates go to ${entry}`,
        fix: `Set target-branch: ${entry} in .github/dependabot.yml, and change this one with Edit, next to the title.`,
      };
    case 'hotfix':
      return {
        allowed: (base) => base === entry,
        wanted: rules.gate === null ? `a hotfix goes to ${MAIN}` : `a hotfix goes to ${entry}, and reaches ${MAIN} with the next release`,
      };
    case 'task': {
      const stacked = taskBranch(rules);
      return {
        allowed: (base) => UMBRELLA.test(base) || stacked.test(base) || (!rules.umbrellaOnly && base === entry),
        wanted: rules.umbrellaOnly
          ? 'a task goes to its project/<slug> umbrella, or to the branch it is stacked on'
          : `a task goes to ${entry}, to its project/<slug> umbrella, or to the branch it is stacked on`,
      };
    }
  }
}

const RENAME = 'Rename it on GitHub (Branches → ⋯ → Rename branch): the pull request follows it.';

export function brokenRules(pr: PullRequest, rules: Rules): string[] {
  const broken: string[] = [];
  const kind = kindOf(pr.branch, rules);

  if (!TITLE.test(pr.title)) {
    broken.push(
      `Title — "${pr.title}" is not in Conventional Commits. Write it as <type>(<scope>): <summary>, such as ` +
        `"feat(auth): let a user reset their password", with a type from: ${TYPES.join(', ')}. The scope is optional.`,
    );
  }

  const bases = basesFor(kind, rules);
  if (!bases.allowed(pr.base)) {
    broken.push(`Base — ${bases.wanted}, not to "${pr.base}". ${bases.fix ?? 'Change it with Edit, next to the title.'}`);
  }

  if ((kind === 'task' || kind === 'hotfix') && !taskBranch(rules).test(pr.branch)) {
    broken.push(
      `Branch — "${pr.branch}" is not <prefix>/<slug>. Use a prefix from: ${rules.prefixes.join(', ')}, and a slug ` +
        `of lowercase words joined by hyphens, such as feature/weekly-report. ${RENAME}`,
    );
  }
  if (kind === 'umbrella' && !UMBRELLA.test(pr.branch)) {
    broken.push(
      `Branch — "${pr.branch}" is not project/<slug>. Name the umbrella after its Linear project, in lowercase ` +
        `words joined by hyphens, such as project/weekly-estimate. ${RENAME}`,
    );
  }
  const id = kind === 'task' || kind === 'hotfix' || kind === 'umbrella' ? issueIdIn(pr.branch, rules.teamKeys) : null;
  if (id !== null) {
    broken.push(`Branch — "${pr.branch}" carries the issue ID ${id}. Leave it out of the name and link the issue from the body. ${RENAME}`);
  }

  if (kind === 'task' || kind === 'hotfix') {
    const links = issueLinks(pr.body, rules.teamKeys);
    if (links.closes.length === 0 && links.refs.length === 0) {
      const example = `${rules.teamKeys[0] ?? 'DEV'}-123`;
      broken.push(
        `Body — it links no Linear issue. Add a magic word with the issue's ID: "Completes ${example}", or ` +
          `"Part of ${example}" when this pull request does not finish it. Teams: ${rules.teamKeys.join(', ')}.`,
      );
    }
  }
  return broken;
}
