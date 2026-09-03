/**
 * @module servers/crud/rules
 *
 * Rules and diff engine for CRUD authorization and field-level before rules.
 */
import { valuesEqual } from "../../history/diff";
import type { AuthUser } from "../auth";
import type {
  CrudUpdateRuleContext,
  DeepDiffReturn,
  Rule,
  RulesMap,
} from "./types";

/**
 * Computes a typed diff between the existing document (`before`) and the incoming partial changes (`changesInput`).
 * Only fields whose values have actually changed (via structural equality) are included in `changes`.
 */
export function computeDeepDiff<T extends Record<string, unknown>>(
  before: T,
  changesInput: Partial<T>,
): DeepDiffReturn<T> {
  const beforeObj = before || ({} as T);
  const changes: Partial<T> = {};
  const after: T = { ...beforeObj };

  for (const [key, val] of Object.entries(changesInput || {})) {
    const oldVal = (beforeObj as any)[key];
    if (!valuesEqual(oldVal, val)) {
      (changes as any)[key] = val;
      (after as any)[key] = val;
    }
  }

  return {
    before: beforeObj,
    after,
    changes,
  };
}

/**
 * Helper to define field-by-field before-rules with strong typing.
 */
export function createRules<T>(
  rules: RulesMap<T>,
): RulesMap<T> {
  return rules;
}

/**
 * Executes a map of field rules against a computed diff.
 * Evaluates rules only for the keys that changed in `diff.changes`.
 * Returns `{ allowed: true }` if all rules pass, or `{ allowed: false, reason: rule.description }` on the first failure.
 */
export async function applyRules<T>(
  diff: DeepDiffReturn<T>,
  rulesMap: RulesMap<T>,
  user?: AuthUser,
): Promise<{ allowed: boolean; reason?: string }> {
  const changes = diff.changes || {};
  for (const key of Object.keys(changes) as (keyof T)[]) {
    const rules = rulesMap[key];
    if (rules && rules.length > 0) {
      for (const rule of rules) {
        const res = await rule.rule({
          diff,
          key,
          user,
          authenticatedUser: user,
        });
        if (res === false) {
          return { allowed: false, reason: rule.description };
        }
      }
    }
  }
  return { allowed: true };
}

/**
 * Wraps a rules map into a standard `rules.update` handler for `createCrudServer`.
 */
export function createBeforeRules<T>(
  rulesMap: RulesMap<T>,
): (ctx: CrudUpdateRuleContext<T>) => Promise<{ allowed: boolean; reason?: string }> {
  return async (ctx: CrudUpdateRuleContext<T>) => {
    return applyRules(ctx.diff, rulesMap, ctx.user);
  };
}
