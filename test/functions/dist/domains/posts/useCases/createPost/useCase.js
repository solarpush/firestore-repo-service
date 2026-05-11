"use strict";
/**
 * CreatePostUseCase — pure business logic, no HTTP awareness.
 * Reusable across multiple routes / cron jobs / triggers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreatePostUseCase = void 0;
class CreatePostUseCase {
    // TODO: inject repositories / services via the constructor.
    // constructor(private readonly repo: SomeRepository) {}
    async execute(input, c) {
        // TODO: implement
        const user = c.get("user");
        user.role === "admin"
            ? console.log("admin access")
            : console.log("user access");
        return { id: input.example };
    }
}
exports.CreatePostUseCase = CreatePostUseCase;
//# sourceMappingURL=useCase.js.map