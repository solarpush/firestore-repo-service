/**
 * GetPostUseCase — récupère un post par ID.
 *
 * Owns its Zod `input` / `output` schemas (declared as `static` members, the
 * single source of truth shared with `routes.ts`) and runs the logic in
 * `execute`. The shared `services` container is injected by the `UseCase` base
 * class via the constructor.
 */

import { z } from "zod";
import { UseCase } from "@lpdjs/firestore-repo-service/servers/hono";
import { postSchema } from "../../../..";
import type { Services } from "../../../../services.js";

const input = z.object({
  id: z.string().min(1),
});

const output = postSchema.nullable();

export class GetPostUseCase extends UseCase<typeof input, typeof output, Services> {
  static readonly input = input;
  static readonly output = output;

  async execute(
    payload: z.infer<typeof input>,
  ): Promise<z.infer<typeof output>> {
    return this.services.repository.db.posts.get.byDocId(payload.id);
  }
}
