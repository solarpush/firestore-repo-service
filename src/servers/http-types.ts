/**
 * Minimal HTTP interface types compatible with:
 *  - Firebase Functions v1 (https.Request / Response)
 *  - Firebase Functions v2 (Cloud Run Request / Response)
 *  - Express.js Request / Response
 *  - Node.js http.IncomingMessage / ServerResponse (subset)
 *
 * Using these avoids importing from firebase-functions or express directly,
 * keeping `servers/` free of hard runtime dependencies.
 */

import type { Response } from "express";
import type { Request } from "firebase-functions/https";
/** Minimal HTTP request interface */
export interface HttpRequest extends Request {}

/** Minimal HTTP response interface */
export interface HttpResponse extends Response {}

/** The handler signature expected by Firebase Functions `https.onRequest` */
export type HttpHandler = (
  req: HttpRequest,
  res: HttpResponse,
) => void | Promise<void>;
