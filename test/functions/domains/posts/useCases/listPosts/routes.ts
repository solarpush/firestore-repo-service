/**
 * domains/posts/useCases/listPosts/routes.ts
 *
 * Route GET /posts — payload lu depuis les query params (comportement par
 * défaut pour les méthodes GET).
 */
import { defineRoutes } from "@lpdjs/firestore-repo-service/servers/hono";
import { useCaseRoute } from "../../../../apis.js";
import { ListPostsUseCase } from "./useCase.js";

export default defineRoutes([
  useCaseRoute(ListPostsUseCase, {
    api: "v1",
    method: "get",
    summary: "Lister les posts",
    tags: ["posts"],
  }),
]);
