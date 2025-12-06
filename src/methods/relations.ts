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
 * Options for populate with select support
 * Supports two formats:
 * - Single relation: { relation: "posts", select: ["title", "content"] }
 * - Multiple relations: { relations: ["posts", "comments"], select: { posts: ["title"], comments: ["content"] } }
 */
export type PopulateOptions<TRelationKey = string> =
  | {
      /** Single relation key to populate */
      relation: TRelationKey;
      /** Fields to select for this relation */
      select?: string[];
    }
  | {
      /** Multiple relation keys to populate */
      relations: TRelationKey | TRelationKey[];
      /** Fields to select per relation (keyed by relation name or repo name) */
      select?: Partial<Record<string, string[]>>;
    };

/**
 * Creates populate methods for resolving relations between repositories
 * @internal
 */
export function createPopulateMethods<
  TConfig extends RepositoryConfig<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  >
>(
  config: TConfig,
  allRepositories: Record<string, any>
): {
  populate: <
    K extends keyof NonNullable<TConfig["relationalKeys"]>,
    TDoc extends Pick<TConfig["type"], K>
  >(
    document: TDoc,
    relationKeyOrOptions: K | K[] | PopulateOptions<K>
  ) => Promise<
    TDoc & {
      populated: UnionToIntersection<
        PopulatedData<NonNullable<TConfig["relationalKeys"]>, K>
      >;
    }
  >;
} {
  return {
    populate: async (document: any, relationKeyOrOptions: any) => {
      if (!config.relationalKeys) {
        return { ...document, populated: {} };
      }

      // Parse options
      let keys: string[];
      let selectMap: Record<string, string[]> = {};

      if (
        typeof relationKeyOrOptions === "object" &&
        !Array.isArray(relationKeyOrOptions)
      ) {
        if ("relation" in relationKeyOrOptions) {
          // Single relation format: { relation: "posts", select: ["title"] }
          const opts = relationKeyOrOptions as {
            relation: string;
            select?: string[];
          };
          keys = [opts.relation];
          if (opts.select) {
            selectMap[opts.relation] = opts.select;
          }
        } else if ("relations" in relationKeyOrOptions) {
          // Multiple relations format: { relations: [...], select: { posts: [...] } }
          const opts = relationKeyOrOptions as {
            relations: string | string[];
            select?: Record<string, string[]>;
          };
          keys = Array.isArray(opts.relations)
            ? opts.relations
            : [opts.relations];
          selectMap = opts.select || {};
        } else {
          // Unknown object format, treat as empty
          keys = [];
        }
      } else {
        // Legacy format: key or key[]
        keys = Array.isArray(relationKeyOrOptions)
          ? relationKeyOrOptions
          : [relationKeyOrOptions];
      }

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

        // Get select fields for this relation (by key or by repo name)
        const selectFields =
          selectMap[key as string] || selectMap[relation.repo];

        try {
          if (relation.type === "one") {
            // One-to-one: Get single document
            const getMethod = `by${capitalize(relation.key)}`;
            if (typeof targetRepo.get?.[getMethod] === "function") {
              populated[relation.repo] = await targetRepo.get[getMethod](
                fieldValue,
                selectFields ? { select: selectFields } : {}
              );
            } else {
              console.warn(
                `[populate] Method "get.${getMethod}" not found in ${relation.repo}`
              );
              populated[relation.repo] = null;
            }
          } else {
            // One-to-many: Query multiple documents with select
            const queryMethod = `by${capitalize(relation.key)}`;
            if (typeof targetRepo.query[queryMethod] === "function") {
              populated[relation.repo] = await targetRepo.query[queryMethod](
                fieldValue,
                selectFields ? { select: selectFields } : {}
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
