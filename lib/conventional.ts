/** A Conventional Commits title without its type and scope, in capitals: `feat(board): drag a card` → `Drag a card`. */
export function summaryOf(title: string): string {
  const summary = title.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/, '').trim();
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}
