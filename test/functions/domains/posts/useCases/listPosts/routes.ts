/**
 * domains/posts/useCases/listPosts/routes.ts
 *
 * Route GET /posts — payload lu depuis les query params (comportement par
 * défaut pour les méthodes GET).
 */
import { z } from "zod";

import { defineRoute } from "../../../../apis.js";

const PostSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["draft", "published"]),
  authorId: z.string(),
  createdAt: z.string(),
});

export default defineRoute({
  api: "v1",
  method: "get",

  /** Pour GET la source est automatiquement "query" — les champs sont lus depuis ?status=&authorId= */
  input: z.object({
    status: z.enum(["draft", "published"]).optional(),
    authorId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  }),

  output: z.object({
    data: z.array(PostSchema),
    nextCursor: z.string().nullable(),
    total: z.number(),
  }),

  summary: "Lister les posts",
  tags: ["posts"],

  handler: async ({ input }) => {
    // En vrai : repos.posts.list({ filters: [...], limit: input.limit })
    return {
      data: [],
      nextCursor: null,
      total: 0,
    };
  },
});
