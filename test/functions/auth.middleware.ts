import { MiddlewareHandler } from "hono";

export const enrichUser: MiddlewareHandler = async (c, next) => {
  c.set("user", {
    uid: c.req.header("uid") ?? "",
    role: (c.req.header("role") as "admin" | "user") ?? "user",
    email: c.req.header("email") ?? "",
  });
  await next();
};
