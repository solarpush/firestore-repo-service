"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enrichUser = void 0;
const enrichUser = async (c, next) => {
    c.set("user", {
        uid: c.req.header("uid") ?? "",
        role: c.req.header("role") ?? "user",
        email: c.req.header("email") ?? "",
    });
    await next();
};
exports.enrichUser = enrichUser;
//# sourceMappingURL=auth.middleware.js.map