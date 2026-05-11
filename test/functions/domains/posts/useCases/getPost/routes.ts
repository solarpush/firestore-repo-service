/**
 * domains/posts/useCases/getPost/routes.ts
 *
 * Route GET /posts/:id — paramètre de path lu via source: "param".
 * L'URL dérivée par le codegen sera /posts/getPost ; on override
 * explicitement via `path` pour obtenir /posts/:id.
 */
import { z } from "zod";

import { postSchema, repos } from "../../../..";
import { defineRoute } from "../../../../apis.js";

export default defineRoute({
  api: "v1",
  method: "get",

  /** Override explicite du path (le codegen utiliserait /posts/getPost sinon). */
  path: "/posts/:id",

  source: "param",

  input: z.object({
    id: z.string().min(1),
  }),

  output: postSchema.nullable(),

  summary: "Récupérer un post par ID",
  tags: ["posts"],

  handler: async ({ input, c }) => {
    console.log("getPost route handler called with input:", input);
    // En vrai : repos.posts.getById(input.id)
    const post = await repos.posts.get.byDocId(input.id);
    return post;
  },
});
