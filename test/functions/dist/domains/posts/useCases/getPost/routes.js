"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * domains/posts/useCases/getPost/routes.ts
 *
 * Route GET /posts/:id — paramètre de path lu via source: "param".
 * L'URL dérivée par le codegen sera /posts/getPost ; on override
 * explicitement via `path` pour obtenir /posts/:id.
 */
const zod_1 = require("zod");
const __1 = require("../../../..");
const apis_js_1 = require("../../../../apis.js");
exports.default = (0, apis_js_1.defineRoute)({
    api: "v1",
    method: "get",
    /** Override explicite du path (le codegen utiliserait /posts/getPost sinon). */
    path: "/posts/:id",
    source: "param",
    input: zod_1.z.object({
        id: zod_1.z.string().min(1),
    }),
    output: __1.postSchema.nullable(),
    summary: "Récupérer un post par ID",
    tags: ["posts"],
    handler: async ({ input, c }) => {
        console.log("getPost route handler called with input:", input);
        // En vrai : repos.posts.getById(input.id)
        const post = await __1.repos.posts.get.byDocId(input.id);
        return post;
    },
});
//# sourceMappingURL=routes.js.map