import { createServices } from "@lpdjs/firestore-repo-service/servers/hono";
import { HubspotService } from "./services/hubspot.js";
import { RepositoryService } from "./services/repository.js";

/**
 * Global DI container — shared infrastructure only (SPI, repositories,
 * SDK clients, loggers). UseCases are **not** registered here; they are
 * instantiated per-call inside routes / cron / triggers and receive the
 * services they need through their constructor.
 *
 * This boundary keeps `Services` free of any reference back to itself
 * (no circular type alias) and makes useCases trivial to unit-test with
 * hand-rolled fakes.
 */
export const services = createServices({
  repository: ({ ctx }) => new RepositoryService(ctx),
  hubspot: ({ ctx }) => new HubspotService(ctx),
});

export type Services = typeof services;
