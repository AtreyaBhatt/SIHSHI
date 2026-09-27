import { TAB_VERBS, type AgentAction } from './schema';

/**
 * A plan runs in the content script until the first tab-level verb. That verb
 * runs in the worker (tabs.update / tabs.goBack). Anything after it would run
 * on a page nobody has seen yet, so it is dropped and the next capture re-plans.
 */
export function splitAtTabVerb(actions: AgentAction[]): { page: AgentAction[]; tab: AgentAction | null; dropped: AgentAction[] } {
  const index = actions.findIndex((a) => TAB_VERBS.has(a.action));
  if (index === -1) return { page: actions, tab: null, dropped: [] };
  return { page: actions.slice(0, index), tab: actions[index]!, dropped: actions.slice(index + 1) };
}
