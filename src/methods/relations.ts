import type { RelationConfig, RepositoryConfig } from "../shared/types";

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never;

type PopulatedData<
  TRelationalKeys,
  K extends keyof TRelationalKeys
> = TRelationalKeys[K] extends RelationConfig<infer TRepo, any, infer TType>
  ? TType extends "one"
    ? { [R in TRepo]: any | null }
    : { [R in TRepo]: any[] }
  : never;

/**
 * Creates populate methods for resolving relations between repositories
 * @internal
 */
export function createPopulateMethods<
  T,
  TForeignKeys extends readonly (keyof T)[],
  TQueryKeys extends readonly (keyof T)[],
  TIsGroup extends boolean,
  TRefCb,
  TRelationalKeys extends Record<string, any>,
  TConfig extends RepositoryConfig<
    T,
    TForeignKeys,
    TQueryKeys,
    TIsGroup,
    TRefCb,
    TRelationalKeys
  >
>(
  config: TConfig,
  allRepositories: Record<string, any>
): {
  populate: <K extends keyof NonNullable<TConfig["relationalKeys"]>>(
    document: T,
    relationKey: K | K[]
  ) => Promise<
    T & {
      populated: UnionToIntersection<
        PopulatedData<NonNullable<TConfig["relationalKeys"]>, K>
      >;
    }
  >;
} {
  return {
    populate: async (document: any, relationKey: any) => {
      if (!config.relationalKeys) {
        return { ...document, populated: {} };
      }

      const keys = Array.isArray(relationKey) ? relationKey : [relationKey];
      const result = { ...document };
      const populated: Record<string, any> = {};

      for (const key of keys) {
        const relation: RelationConfig | undefined =
          config.relationalKeys?.[key as string];
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
          populated[relation.repo] = relation.type === "one" ? null : [];
          continue;
        }

        try {
          if (relation.type === "one") {
            // One-to-one: Get single document
            const getMethod = `by${capitalize(relation.key)}`;
            if (typeof targetRepo.get?.[getMethod] === "function") {
              populated[relation.repo] = await targetRepo.get[getMethod](
                fieldValue
              );
            } else {
              console.warn(
                `[populate] Method "get.${getMethod}" not found in ${relation.repo}`
              );
              populated[relation.repo] = null;
            }
          } else {
            // One-to-many: Query multiple documents
            const queryMethod = `by${capitalize(relation.key)}`;
            if (typeof targetRepo.query[queryMethod] === "function") {
              populated[relation.repo] = await targetRepo.query[queryMethod](
                fieldValue
              );
            } else {
              console.warn(
                `[populate] Method "query.${queryMethod}" not found in ${relation.repo}`
              );
              populated[relation.repo] = [];
            }
          }
        } catch (error) {
          console.error(`[populate] Error populating "${String(key)}":`, error);
          populated[relation.repo] = relation.type === "one" ? null : [];
        }
      }

      return { ...result, populated };
    },
  };
}

/**
 * Utility to capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
