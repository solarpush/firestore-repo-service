import { describe, it, expect } from "vitest";
import { HealthUseCase } from "./useCase.js";

describe("HealthUseCase", () => {
  it("returns a response shaped like the output schema", async () => {
    const useCase = new HealthUseCase();
    const result = await useCase.execute({ example: "hello" });
    expect(result).toMatchObject({ id: expect.any(String) });
  });

  // TODO: add error-path tests, repository mocks, etc.
});
