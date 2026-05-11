/**
 * HealthUseCase — pure business logic, no HTTP awareness.
 * Reusable across multiple routes / cron jobs / triggers.
 */

export interface HealthUseCaseInput {
  // TODO: define the input shape
  example: string;
}

export interface HealthUseCaseOutput {
  // TODO: define the output shape
  id: string;
}

export class HealthUseCase {
  // TODO: inject repositories / services via the constructor.
  // constructor(private readonly repo: SomeRepository) {}

  async execute(input: HealthUseCaseInput): Promise<HealthUseCaseOutput> {
    // TODO: implement
    return { id: input.example };
  }
}
