/**
 * CreatePostUseCase — pure business logic, no HTTP awareness.
 *
 * Owns its Zod `input` / `output` schemas (declared as `static` members, the
 * single source of truth shared with `routes.ts`) and runs the logic in
 * `execute`. The shared `services` container is injected by the `UseCase` base
 * class via the constructor.
 */

import { UseCase } from "@lpdjs/firestore-repo-service/servers/hono";
import { z } from "zod";
import type { Services } from "../../../../services.js";

const input = z.object({
  id: z.string(),
  example: z.string(),
});

const output = z.object({
  id: z.string(),
});

export class CreatePostUseCase extends UseCase<
  typeof input,
  typeof output,
  Services
> {
  static readonly input = input;
  static readonly output = output;

  async execute(
    payload: z.infer<typeof input>,
  ): Promise<z.infer<typeof output>> {
    const user = this.services.ctx.c.get("user");
    user.role === "admin"
      ? console.log("admin access")
      : console.log("user access");

    console.log(this.services.repository.db.comments.get.byDocId("1234"));
    console.log(this.services.hubspot.hello());
    return { id: payload.example };
  }
}
