import { defineRoutes } from "@lpdjs/firestore-repo-service/servers/hono";
import { useCaseRoute } from "../../../../apis.js";
import { CreatePostUseCase } from "./useCase.js";

export default defineRoutes([
  useCaseRoute(CreatePostUseCase, {
    api: "v2",
    method: "post",
    summary: "Creer un post mock standard",
    tags: ["posts"],
  }),
  useCaseRoute(CreatePostUseCase, {
    api: "v1",
    method: "get",
    source: "form",
    summary: "Creer un post mock standard",
    tags: ["posts"],
  }),
  useCaseRoute(CreatePostUseCase, {
    api: "v1",
    method: "put",
    summary: "Mettre à jour un post mock standard",
    tags: ["posts"],
  }),
]);
