/**
 * domains/posts/useCases/getPost/routes.ts
 *
 * Route GET /posts/:id — paramètre de path lu via source: "param".
 * L'URL dérivée par le codegen serait /posts/getPost ; on override
 * explicitement via `path` pour obtenir /posts/:id.
 */
import { defineRoutes } from "@lpdjs/firestore-repo-service/servers/hono";
import { useCaseRoute } from "../../../../apis.js";
import { GetPostUseCase } from "./useCase.js";

export default defineRoutes([
  useCaseRoute(GetPostUseCase, {
    api: "v1",
    method: "get",

    /** Override explicite du path (le codegen utiliserait /posts/getPost sinon). */
    path: "/posts/:id",

    source: "param",

    summary: "Récupérer un post par ID",
    tags: ["posts"],
  }),
]);
