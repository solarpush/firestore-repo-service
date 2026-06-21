/**
 * CreatePostUseCase — pure business logic, no HTTP awareness.
 *
 * Owns its Zod `input` / `output` schemas (declared as `static` members, the
 * single source of truth shared with `routes.ts`) and runs the logic in
 * `execute`. The shared `services` container is injected by the `UseCase` base
 * class via the constructor.
 */

import { z } from "zod";
import { AppUseCase } from "../../../../base-usecase.js";
import type { Services } from "../../../../services.js";

const input = z.object({
  id: z.string(),
  example: z.string(),
});

const output = z.object({
  id: z.string(),
});

export class CreatePostUseCase extends AppUseCase<
  typeof input,
  typeof output
> {
  static readonly input = input;
  static readonly output = output;

  async execute(
    payload: z.infer<typeof input>,
  ): Promise<z.infer<typeof output>> {
    const user = this.services.ctx.c.get("user");
    this.logger.info(`post access by role=${user.role}`, { postId: payload.id });

    return { id: payload.example };
  }
}
