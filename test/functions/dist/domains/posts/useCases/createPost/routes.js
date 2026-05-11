"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const apis_js_1 = require("../../../../apis.js");
const useCase_js_1 = require("./useCase.js");
exports.default = [
    (0, apis_js_1.defineRoute)({
        api: "v2",
        method: "post",
        input: zod_1.z.object({
            // POST → lu depuis le body JSON
            example: zod_1.z.string(),
        }),
        output: zod_1.z.object({
            id: zod_1.z.string(),
        }),
        summary: "Creer un post mock standard",
        tags: ["posts"],
        handler: async ({ input, c }) => {
            const useCase = new useCase_js_1.CreatePostUseCase();
            const data = await useCase.execute(input, c);
            return data;
        },
    }),
    (0, apis_js_1.defineRoute)({
        api: "v1",
        method: "get",
        source: "form",
        input: zod_1.z.object({
            id: zod_1.z.string(),
            // POST → lu depuis le body JSON
            example: zod_1.z.string(),
        }),
        output: zod_1.z.object({
            id: zod_1.z.string(),
        }),
        summary: "Creer un post mock standard",
        tags: ["posts"],
        handler: async ({ input, c }) => {
            const useCase = new useCase_js_1.CreatePostUseCase();
            const data = await useCase.execute(input, c);
            return data;
        },
    }),
    (0, apis_js_1.defineRoute)({
        api: "v1",
        method: "put",
        input: zod_1.z.object({
            // POST → lu depuis le body JSON
            example: zod_1.z.string(),
        }),
        output: zod_1.z.object({
            id: zod_1.z.string(),
        }),
        summary: "Mettre à jour un post mock standard",
        tags: ["posts"],
        handler: async ({ input, c }) => {
            const useCase = new useCase_js_1.CreatePostUseCase();
            const data = await useCase.execute(input, c);
            return data;
        },
    }),
];
//# sourceMappingURL=routes.js.map