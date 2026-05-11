/**
 * CreatePostUseCase — pure business logic, no HTTP awareness.
 * Reusable across multiple routes / cron jobs / triggers.
 */

import { Context } from "hono";

export interface CreatePostUseCaseInput {
  // TODO: define the input shape
  example: string;
}

export interface CreatePostUseCaseOutput {
  // TODO: define the output shape
  id: string;
}

export class CreatePostUseCase {
  // TODO: inject repositories / services via the constructor.
  // constructor(private readonly repo: SomeRepository) {}

  async execute(
    input: CreatePostUseCaseInput,
    c: Context,
  ): Promise<CreatePostUseCaseOutput> {
    // TODO: implement
    const user = c.get("user");
    user.role === "admin"
      ? console.log("admin access")
      : console.log("user access");
    return { id: input.example };
  }
}
