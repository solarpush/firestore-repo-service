/**
 * ListPostsUseCase — liste paginée des posts.
 *
 * Owns its Zod `input` / `output` schemas (declared as `static` members, the
 * single source of truth shared with `routes.ts`) and runs the logic in
 * `execute`. The shared `services` container is injected by the `UseCase` base
 * class via the constructor.
 */

import { z } from "zod";
import { UseCase } from "@lpdjs/firestore-repo-service/servers/hono";
import type { Services } from "../../../../services.js";

const PostSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["draft", "published"]),
  authorId: z.string(),
  createdAt: z.string(),
});

const input = z.object({
  status: z.enum(["draft", "published"]).optional(),
  authorId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const output = z.object({
  data: z.array(PostSchema),
  nextCursor: z.string().nullable(),
  total: z.number(),
});

export class ListPostsUseCase extends UseCase<typeof input, typeof output, Services> {
  static readonly input = input;
  static readonly output = output;

  async execute(
    payload: z.infer<typeof input>,
  ): Promise<z.infer<typeof output>> {
    // En vrai : this.services.repository.db.posts.list({ filters: [...], limit: payload.limit })
    void payload;
    return {
      data: [],
      nextCursor: null,
      total: 0,
    };
  }
}
