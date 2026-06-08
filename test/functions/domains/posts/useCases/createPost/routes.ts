import { z } from "zod";
import { defineRoute } from "../../../../apis.js";
import { CreatePostUseCase } from "./useCase.js";

export default [
  defineRoute({
    api: "v2",
    method: "post",

    input: z.object({
      example: z.string(),
    }),

    output: z.object({
      id: z.string(),
    }),

    summary: "Creer un post mock standard",
    tags: ["posts"],

    handler: async ({ input, services }) =>
      new CreatePostUseCase(services).execute(input),
  }),
  defineRoute({
    api: "v1",
    method: "get",
    source: "form",
    input: z.object({
      id: z.string(),
      example: z.string(),
    }),
    output: z.object({
      id: z.string(),
    }),
    summary: "Creer un post mock standard",
    tags: ["posts"],
    handler: async ({ input, services }) =>
      new CreatePostUseCase(services).execute(input),
  }),
  defineRoute({
    api: "v1",
    method: "put",
    input: z.object({
      example: z.string(),
    }),
    output: z.object({
      id: z.string(),
    }),
    summary: "Mettre à jour un post mock standard",
    tags: ["posts"],
    handler: async ({ input, services }) =>
      new CreatePostUseCase(services).execute(input),
  }),
];
