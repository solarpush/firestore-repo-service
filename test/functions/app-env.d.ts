import "hono";

declare module "hono" {
  interface ContextVariableMap {
    user: { uid: string; role: "admin" | "user"; email: string };
    // ajoute d'autres variables ici, ex:
    // requestId: string;
    // tenant: { id: string; plan: "free" | "pro" };
  }
}

export {};
