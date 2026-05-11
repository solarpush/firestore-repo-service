import { z } from "zod";
import { defineRoute } from "../../../../apis.js";
import { HealthUseCase } from "./useCase.js";

export default defineRoute({
  api: "v1",
  method: "get",

  input: z.object({
    // GET → lu depuis les query params
    example: z.string(),
  }),

  output: z.object({
    id: z.string(),
  }),

  summary: "TODO: health",
  tags: ["status"],

  handler: async ({ input }) => {
    const useCase = new HealthUseCase();
    const data = await useCase.execute(input);
    return data;
  },
});
