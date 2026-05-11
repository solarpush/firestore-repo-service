import { z } from "zod";
import { defineRoute } from "../../../../apis.js";
import { CreatePostUseCase } from "./useCase.js";

export default [
  defineRoute({
    api: "v2",
    method: "post",

    input: z.object({
      // POST → lu depuis le body JSON
      example: z.string(),
    }),

    output: z.object({
      id: z.string(),
    }),

    summary: "Creer un post mock standard",
    tags: ["posts"],

    handler: async ({ input, c }) => {
      const useCase = new CreatePostUseCase();
      const data = await useCase.execute(input, c);
      return data;
    },
  }),
  defineRoute({
    api: "v1",
    method: "get",
    source: "form",
    input: z.object({
      id: z.string(),
      // POST → lu depuis le body JSON
      example: z.string(),
    }),
    output: z.object({
      id: z.string(),
    }),
    summary: "Creer un post mock standard",
    tags: ["posts"],
    handler: async ({ input, c }) => {
      const useCase = new CreatePostUseCase();
      const data = await useCase.execute(input, c);
      return data;
    },
  }),
  defineRoute({
    api: "v1",
    method: "put",
    input: z.object({
      // POST → lu depuis le body JSON
      example: z.string(),
    }),
    output: z.object({
      id: z.string(),
    }),
    summary: "Mettre à jour un post mock standard",
    tags: ["posts"],
    handler: async ({ input, c }) => {
      const useCase = new CreatePostUseCase();
      const data = await useCase.execute(input, c);
      return data;
    },
  }),
];
