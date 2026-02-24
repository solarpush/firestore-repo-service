import type { RelationConfig, RepositoryConfig } from "../shared/types";
import { capitalize } from "../shared/utils";

/**
 * Options for populate with select support.
 * Two formats:
 * - Single relation:   { relation: "userId", select: ["name", "email"] }
 * - Multiple relations: { relations: ["userId", "editorId"], select: { userId: ["name"] } }
 */
export type PopulateOptions<TRelationKey = string> =
  | {
      relation: TRelationKey;
      select?: string[];
    }
  | {
      relations: TRelationKey | TRelationKey[];
      select?: Partial<Record<string, string[]>>;
    };

/**
 * Creates populate methods for resolving relations between repositories.
 * Results are keyed by the **field name** (relation key) — not the repo name —
 * to avoid collisions when two fields point to the same repository.
 *
 * @template TConfig - Repository configuration type
 * @param config - Repository configuration with relational keys
 * @param allRepositories - Map of all repositories for relation resolution
 * @returns Object containing the populate method
 *
 * @example
 * ```typescript
 * // Assume relations configured as:
 * // posts.userId -> users.docId (one-to-one)
 * // posts.categoryId -> categories.docId (one-to-one)
 * // users.docId -> posts.userId (one-to-many)
 *
 * // POPULATE SINGLE RELATION - Get post with its author
 * const post = await repos.posts.get.byDocId("post-123");
 * const postWithAuthor = await repos.posts.populate(post, "userId");
 * console.log(postWithAuthor.populated.userId); // User object
 *
 * // POPULATE WITH SELECT - Only fetch specific fields
 * const postWithPartialAuthor = await repos.posts.populate(post, {
 *   relation: "userId",
 *   select: ["name", "email", "avatar"]
 * });
 * console.log(postWithPartialAuthor.populated.userId.name);
 *
 * // POPULATE MULTIPLE RELATIONS - Get post with author and category
 * const postWithRelations = await repos.posts.populate(post, ["userId", "categoryId"]);
 * console.log(postWithRelations.populated.userId);     // User object
 * console.log(postWithRelations.populated.categoryId); // Category object
 *
 * // POPULATE MULTIPLE WITH DIFFERENT SELECTS
 * const postWithCustomSelects = await repos.posts.populate(post, {
 *   relations: ["userId", "categoryId"],
 *   select: {
 *     userId: ["name", "avatar"],
 *     categoryId: ["name", "slug"]
 *   }
 * });
 *
 * // POPULATE ONE-TO-MANY - Get user with all their posts
 * const user = await repos.users.get.byDocId("user-123");
 * const userWithPosts = await repos.users.populate(user, "docId");
 * console.log(userWithPosts.populated.docId); // Array of Post objects
 *
 * // With select on one-to-many
 * const userWithPartialPosts = await repos.users.populate(user, {
 *   relation: "docId",
 *   select: ["title", "status", "createdAt"]
 * });
 *
 * // Chained population (nested relations)
 * const post = await repos.posts.get.byDocId("post-123");
 * const postWithAuthor = await repos.posts.populate(post, "userId");
 * // If you need author's posts too:
 * const authorWithPosts = await repos.users.populate(
 *   postWithAuthor.populated.userId,
 *   "docId"
 * );
 * ```
 *
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
  >,
>(
  config: TConfig,
  allRepositories: Record<string, any>,
): {
  populate: <
    K extends keyof NonNullable<TConfig["relationalKeys"]>,
    TDoc extends Pick<TConfig["type"], K>,
  >(
    document: TDoc,
    relationKeyOrOptions: K | K[] | PopulateOptions<K>,
  ) => Promise<TDoc & { populated: Record<string, any> }>;
} {
  return {
    populate: async (document: any, relationKeyOrOptions: any) => {
      if (!config.relationalKeys) {
        return { ...document, populated: {} };
      }

      // Parse options into a list of keys + per-key select map
      let keys: string[];
      let selectMap: Record<string, string[]> = {};

      if (
        typeof relationKeyOrOptions === "object" &&
        !Array.isArray(relationKeyOrOptions)
      ) {
        if ("relation" in relationKeyOrOptions) {
          const opts = relationKeyOrOptions as {
            relation: string;
            select?: string[];
          };
          keys = [opts.relation];
          if (opts.select) selectMap[opts.relation] = opts.select;
        } else if ("relations" in relationKeyOrOptions) {
          const opts = relationKeyOrOptions as {
            relations: string | string[];
            select?: Record<string, string[]>;
          };
          keys = Array.isArray(opts.relations)
            ? opts.relations
            : [opts.relations];
          selectMap = opts.select ?? {};
        } else {
          keys = [];
        }
      } else {
        keys = Array.isArray(relationKeyOrOptions)
          ? relationKeyOrOptions
          : [relationKeyOrOptions];
      }

      // Resolve all relations in parallel
      const entries = await Promise.all(
        keys.map(async (key) => {
          const relation: RelationConfig | undefined =
            config.relationalKeys?.[key as string];
          if (!relation) {
            console.warn(`[populate] Relation "${key}" not found in config`);
            return [key, undefined] as const;
          }

          const targetRepo = allRepositories[relation.repo];
          if (!targetRepo) {
            console.warn(
              `[populate] Repository "${relation.repo}" not found in mapping`,
            );
            return [key, undefined] as const;
          }

          const fieldValue = document[key];
          if (fieldValue === undefined || fieldValue === null) {
            return [key, relation.type === "one" ? null : []] as const;
          }

          const selectFields = selectMap[key];
          const opts = selectFields ? { select: selectFields } : undefined;

          try {
            if (relation.type === "one") {
              const method = `by${capitalize(relation.key)}`;
              const result =
                typeof targetRepo.get?.[method] === "function"
                  ? await targetRepo.get[method](fieldValue, opts)
                  : null;
              return [key, result] as const;
            } else {
              const method = `by${capitalize(relation.key)}`;
              const result =
                typeof targetRepo.query?.[method] === "function"
                  ? await targetRepo.query[method](fieldValue, opts)
                  : [];
              return [key, result] as const;
            }
          } catch (err) {
            console.error(`[populate] Error populating "${key}":`, err);
            return [key, relation.type === "one" ? null : []] as const;
          }
        }),
      );

      const populated: Record<string, any> = {};
      for (const [k, v] of entries) {
        if (v !== undefined) populated[k] = v;
      }

      return { ...document, populated };
    },
  };
}
