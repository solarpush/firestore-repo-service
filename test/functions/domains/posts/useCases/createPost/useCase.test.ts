import { describe, expect, it } from "vitest";
import { CreatePostUseCase } from "./useCase.js";

describe("CreatePostUseCase", () => {
  it("returns a response shaped like the output schema", async () => {
    const useCase = new CreatePostUseCase();
    const result = await useCase.execute({ example: "hello" }, {} as any);
    expect(result).toMatchObject({ id: expect.any(String) });
  });

  // TODO: add error-path tests, repository mocks, etc.
});
