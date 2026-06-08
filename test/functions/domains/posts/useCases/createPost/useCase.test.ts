import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { CreatePostUseCase } from "./useCase.js";
import type { Services } from "../../../../services.js";

describe("CreatePostUseCase", () => {
  it("returns a response shaped like the output schema", async () => {
    const fakeContext = {
      get: () => ({ role: "admin", id: "u1" }),
    } as unknown as Context;

    const services = {
      ctx: { c: fakeContext, maybeC: fakeContext },
      repository: {
        db: {
          comments: { get: { byDocId: () => ({ id: "1234" }) } },
        },
      },
      hubspot: { hello: () => "hubspot-mock" },
    } as unknown as Services;

    const uc = new CreatePostUseCase(services);
    const result = await uc.execute({ example: "hello" });
    expect(result).toMatchObject({ id: expect.any(String) });
  });
});
