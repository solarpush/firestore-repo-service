/**
 * CreatePostUseCase — pure business logic, no HTTP awareness.
 * Instantiated by route handlers (or cron / triggers) with the shared
 * services they want to inject. The container in `services.ts` holds the
 * SPI singletons; useCases stay outside of it.
 */

import { Services } from "../../../../services.js";

export interface CreatePostUseCaseInput {
  example: string;
}

export interface CreatePostUseCaseOutput {
  id: string;
}

export class CreatePostUseCase {
  constructor(private readonly services: Services) {}

  async execute(
    input: CreatePostUseCaseInput,
  ): Promise<CreatePostUseCaseOutput> {
    const user = this.services.ctx.c.get("user");
    user.role === "admin"
      ? console.log("admin access")
      : console.log("user access");

    console.log(this.services.repository.db.comments.get.byDocId("1234"));
    console.log(this.services.hubspot.hello());
    return { id: input.example };
  }
}
