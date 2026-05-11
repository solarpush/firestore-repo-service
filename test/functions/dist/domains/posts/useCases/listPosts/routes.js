"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * domains/posts/useCases/listPosts/routes.ts
 *
 * Route GET /posts — payload lu depuis les query params (comportement par
 * défaut pour les méthodes GET).
 */
const zod_1 = require("zod");
const apis_js_1 = require("../../../../apis.js");
const PostSchema = zod_1.z.object({
    id: zod_1.z.string(),
    title: zod_1.z.string(),
    status: zod_1.z.enum(["draft", "published"]),
    authorId: zod_1.z.string(),
    createdAt: zod_1.z.string(),
});
exports.default = (0, apis_js_1.defineRoute)({
    api: "v1",
    method: "get",
    /** Pour GET la source est automatiquement "query" — les champs sont lus depuis ?status=&authorId= */
    input: zod_1.z.object({
        status: zod_1.z.enum(["draft", "published"]).optional(),
        authorId: zod_1.z.string().optional(),
        limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
        cursor: zod_1.z.string().optional(),
    }),
    output: zod_1.z.object({
        data: zod_1.z.array(PostSchema),
        nextCursor: zod_1.z.string().nullable(),
        total: zod_1.z.number(),
    }),
    summary: "Lister les posts",
    tags: ["posts"],
    handler: async ({ input }) => {
        // En vrai : repos.posts.list({ filters: [...], limit: input.limit })
        return {
            data: [],
            nextCursor: null,
            total: 0,
        };
    },
});
//# sourceMappingURL=routes.js.map