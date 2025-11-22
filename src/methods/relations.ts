import type { RelationConfig, RepositoryConfig } from "../shared/types";

/**
 * Creates populate methods for resolving relations between repositories
 * @internal
 */
export function createPopulateMethods<
  TConfig extends RepositoryConfig<any, any, any, any, any, any>
>(
  config: TConfig,
  allRepositories: Record<string, any>
): {
  populate: <
    K extends keyof NonNullable<TConfig["relationalKeys"]>,
    TRelation extends NonNullable<TConfig["relationalKeys"]>[K]
  >(
    document: TConfig["type"],
    relationKey: K | K[]
  ) => Promise<
    TConfig["type"] & {
      [R in K]: TRelation extends RelationConfig
        ? TRelation["type"] extends "one"
          ? any | null
          : any[]
        : never;
    }
  >;
} {
  return {
    populate: async (document: any, relationKey: any) => {
      if (!config.relationalKeys) {
        return document;
      }

      const keys = Array.isArray(relationKey) ? relationKey : [relationKey];
      const result = { ...document };

      for (const key of keys) {
        const relation = config.relationalKeys[key as string];
        if (!relation) {
          console.warn(
            `[populate] Relation "${String(key)}" not found in config`
          );
          continue;
        }

        const targetRepo = allRepositories[relation.repo];
        if (!targetRepo) {
          console.warn(
            `[populate] Repository "${relation.repo}" not found in mapping`
          );
          continue;
        }

        const fieldValue = document[key];
        if (fieldValue === undefined || fieldValue === null) {
          result[key] = relation.type === "one" ? null : [];
          continue;
        }

        try {
          if (relation.type === "one") {
            // One-to-one: Get single document
            const getMethod = `by${capitalize(relation.key)}`;
            if (typeof targetRepo.get[getMethod] === "function") {
              result[key] = await targetRepo.get[getMethod](fieldValue);
            } else {
              console.warn(
                `[populate] Method "get.${getMethod}" not found in ${relation.repo}`
              );
              result[key] = null;
            }
          } else {
            // One-to-many: Query multiple documents
            const queryMethod = `by${capitalize(relation.key)}`;
            if (typeof targetRepo.query[queryMethod] === "function") {
              result[key] = await targetRepo.query[queryMethod](fieldValue);
            } else {
              console.warn(
                `[populate] Method "query.${queryMethod}" not found in ${relation.repo}`
              );
              result[key] = [];
            }
          }
        } catch (error) {
          console.error(`[populate] Error populating "${String(key)}":`, error);
          result[key] = relation.type === "one" ? null : [];
        }
      }

      return result;
    },
  };
}

/**
 * Utility to capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
