import { randomBytes } from "node:crypto";
import type { DocumentReference, Firestore } from "firebase-admin/firestore";

const ID_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a random 20-char alphanumeric ID matching Firestore's native format.
 *
 * Uses a CSPRNG (`crypto.randomBytes`) with rejection sampling (dropping the
 * biased tail `>= 62*4`) to keep the distribution uniform across the 62-char
 * alphabet.
 */
export function generateFirestoreId(): string {
  let id = "";
  while (id.length < 20) {
    const bytes = randomBytes(20);
    for (let i = 0; i < bytes.length && id.length < 20; i++) {
      const byte = bytes[i]!;
      if (byte >= ID_CHARS.length * 4) continue; // drop biased tail (248..255)
      id += ID_CHARS.charAt(byte % ID_CHARS.length);
    }
  }
  return id;
}

/** Extract parameter name from a `{param}` segment, or `null` if static. */
function extractSegmentParam(segment: string): string | null {
  const match = segment.match(/^\{([^}]+)\}$/);
  return match?.[1]?.trim() || null;
}

/**
 * Parsed metadata from a repository `path` configuration string.
 */
export interface ParsedPathTemplate {
  /** Raw path string as configured on the repository */
  rawPath: string;
  /**
   * Target Firestore collection ID (last collection segment, e.g. `"prev_events"`
   * from `"prevention/prev_rules/prev_workshops/{workshopId}/prev_events"`).
   * Used for `db.collectionGroup(collectionId)`.
   */
  collectionId: string;
  /**
   * Collection path (without trailing document segment). Used for `db.collection(...)`
   * on non-group repositories (`isGroup: false`).
   */
  collectionPath: string;
  /**
   * Ordered list of dynamic `{param}` parent keys extracted from the path
   * (excluding fixed transit segments like `"prev_rules"` and the trailing
   * `documentKey`).
   */
  parentKeys: string[];
  /**
   * Full Firestore document path pattern including trailing `/{documentKey}`
   * (e.g. `"prevention/prev_rules/prev_workshops/{workshopId}/prev_events/{docId}"`),
   * or `null` when `isGroup: true` and `rawPath` is a bare single-segment
   * collection name without a path template.
   */
  documentPathTemplate: string | null;
  /** `true` when `rawPath` contains `/` or `{...}` template placeholders */
  hasTemplate: boolean;
}

/**
 * Parse a repository `path` into collection ID, ordered dynamic parent keys,
 * and full document path template.
 *
 * Supports:
 * - Bare collection names: `"users"`, `"res_events"`
 * - Odd-segment collection templates: `"residences/{residenceId}/res_events"`,
 *   `"prevention/prev_rules/prev_workshops/{workshopId}/prev_events"`
 * - Even-segment document templates: `"residences/{residenceId}/res_events/{docId}"`
 */
export function parsePathTemplate(
  rawPath: string,
  documentKey = "docId",
  isGroup = false,
): ParsedPathTemplate {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return {
      rawPath: rawPath ?? "",
      collectionId: "",
      collectionPath: "",
      parentKeys: [],
      documentPathTemplate: null,
      hasTemplate: false,
    };
  }

  const segments = rawPath
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return {
      rawPath,
      collectionId: rawPath,
      collectionPath: rawPath,
      parentKeys: [],
      documentPathTemplate: null,
      hasTemplate: false,
    };
  }

  if (segments.length === 1) {
    const seg = segments[0]!;
    return {
      rawPath,
      collectionId: seg,
      collectionPath: seg,
      parentKeys: [],
      documentPathTemplate: isGroup ? null : `${seg}/{${documentKey}}`,
      hasTemplate: rawPath.includes("{") && rawPath.includes("}"),
    };
  }

  // Multi-segment path:
  // - Even number of segments (col/doc/col/{docId}) -> last segment is the document ID placeholder
  // - Odd number of segments (col/doc/col) -> last segment is the target collection
  const isEvenSegments = segments.length % 2 === 0;
  const collectionSegments = isEvenSegments ? segments.slice(0, -1) : segments;
  const collectionId = collectionSegments[collectionSegments.length - 1]!;
  const collectionPath = collectionSegments.join("/");

  // Parent segments are all segments before the target collection segment
  const parentSegments = collectionSegments.slice(0, -1);
  const parentKeys = parentSegments
    .map(extractSegmentParam)
    .filter((p): p is string => p !== null);

  const documentPathTemplate = isEvenSegments
    ? segments.join("/")
    : `${collectionPath}/{${documentKey}}`;

  return {
    rawPath,
    collectionId,
    collectionPath,
    parentKeys,
    documentPathTemplate,
    hasTemplate: true,
  };
}

/**
 * Build a Firestore `DocumentReference` from a `documentPathTemplate`
 * (e.g. `"prevention/prev_rules/prev_workshops/{workshopId}/prev_events/{docId}"`)
 * and positional dynamic arguments (`[workshopId, docId]`).
 *
 * Static transit segments (like `"prev_rules"`) are preserved automatically.
 */
export function buildDocumentRefFromTemplate(
  db: Firestore,
  documentPathTemplate: string,
  args: unknown[],
): DocumentReference {
  const segments = documentPathTemplate
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

  let argIndex = 0;
  const resolvedSegments: string[] = [];

  for (const seg of segments) {
    const paramName = extractSegmentParam(seg);
    if (paramName !== null) {
      const val = args[argIndex++];
      if (typeof val !== "string" || val.trim() === "") {
        throw new Error(
          `Missing or empty path parameter "${paramName}" when resolving document reference for "${documentPathTemplate}".`,
        );
      }
      resolvedSegments.push(val);
    } else {
      resolvedSegments.push(seg);
    }
  }

  const anyDb = db as any;

  // Try walking db.collection(seg0).doc(seg1).collection(seg2).doc(seg3)...
  // so mocks that spy on .collection().doc() work identically to hand-written refCb.
  if (typeof anyDb?.collection === "function" && resolvedSegments.length >= 2) {
    let cur: any = anyDb;
    let walked = true;
    for (let i = 0; i < resolvedSegments.length; i += 2) {
      const colName = resolvedSegments[i]!;
      const docId = resolvedSegments[i + 1]!;
      if (typeof cur?.collection !== "function") {
        walked = false;
        break;
      }
      const colRef = cur.collection(colName);
      if (typeof colRef?.doc !== "function") {
        walked = false;
        break;
      }
      cur = colRef.doc(docId);
    }
    if (walked && cur && cur !== anyDb) {
      return cur as DocumentReference;
    }
  }

  // Fallback: db.doc(fullPath)
  const fullPath = resolvedSegments.join("/");
  if (typeof anyDb?.doc === "function") {
    return anyDb.doc(fullPath) as DocumentReference;
  }

  // Last-resort fallback for minimal single-collection test mocks
  if (typeof anyDb?.collection === "function" && resolvedSegments.length >= 2) {
    const colPath = resolvedSegments.slice(0, -1).join("/");
    const docId = resolvedSegments[resolvedSegments.length - 1]!;
    const colRef = anyDb.collection(colPath);
    if (typeof colRef?.doc === "function") {
      return colRef.doc(docId) as DocumentReference;
    }
    return colRef as DocumentReference;
  }

  throw new Error(
    `Cannot resolve DocumentReference for "${fullPath}": Firestore instance does not expose .collection() or .doc().`,
  );
}

export interface ExtractPathArgsOptions {
  pathKey?: string | null;
  documentKey?: string | null;
  parentKeys?: string[];
  documentPathTemplate?: string | null;
  isGroup?: boolean;
}

/**
 * Extract the dynamic document reference arguments from a stored document.
 *
 * Unlike naive odd-segment splitting, this helper skips fixed transit document
 * segments (such as `"prev_rules"` in `"prevention/prev_rules/prev_workshops/w1/prev_events/e1"`)
 * by matching against `documentPathTemplate` or `parentKeys`.
 */
export function extractPathArgsFromDoc(
  doc: Record<string, unknown> | null | undefined,
  options: ExtractPathArgsOptions = {},
): string[] | undefined {
  if (!doc || typeof doc !== "object") return undefined;

  const {
    pathKey,
    documentKey = "docId",
    parentKeys,
    documentPathTemplate,
    isGroup,
  } = options;

  const fullPath =
    pathKey && typeof doc[pathKey] === "string" && doc[pathKey]
      ? (doc[pathKey] as string)
      : undefined;

  // 1. If we have both fullPath and a matching documentPathTemplate, extract only `{param}` positions
  if (fullPath && documentPathTemplate) {
    const pathSegments = fullPath.split("/").filter(Boolean);
    const tplSegments = documentPathTemplate.split("/").filter(Boolean);
    if (pathSegments.length === tplSegments.length) {
      const extracted: string[] = [];
      for (let i = 0; i < tplSegments.length; i++) {
        if (extractSegmentParam(tplSegments[i]!) !== null) {
          extracted.push(pathSegments[i]!);
        }
      }
      if (extracted.length > 0) {
        return extracted;
      }
    }
  }

  // 2. If parentKeys are known and non-empty
  if (parentKeys && parentKeys.length > 0) {
    const expectedCount = parentKeys.length + 1;

    if (fullPath) {
      const segments = fullPath.split("/").filter(Boolean);
      const oddSegments: string[] = [];
      for (let i = 1; i < segments.length; i += 2) {
        oddSegments.push(segments[i]!);
      }
      if (oddSegments.length >= expectedCount) {
        return oddSegments.slice(oddSegments.length - expectedCount);
      }
    }

    // Fallback: extract parentKeys + documentKey directly from document fields
    const docIdVal = documentKey ? doc[documentKey] : undefined;
    if (typeof docIdVal === "string" && docIdVal.trim() !== "") {
      const parentVals: string[] = [];
      let allPresent = true;
      for (const pk of parentKeys) {
        const v = doc[pk];
        if (typeof v === "string" && v.trim() !== "") {
          parentVals.push(v);
        } else {
          allPresent = false;
          break;
        }
      }
      if (allPresent) {
        return [...parentVals, docIdVal];
      }
    }
  }

  // 3. Fallback when fullPath is present
  if (fullPath) {
    const segments = fullPath.split("/").filter(Boolean);
    const oddSegments: string[] = [];
    for (let i = 1; i < segments.length; i += 2) {
      oddSegments.push(segments[i]!);
    }
    if (oddSegments.length > 0) {
      // For non-group repos without parentKeys (e.g. under a fixed transit doc), only the last docId is dynamic
      if (!isGroup && (!parentKeys || parentKeys.length === 0)) {
        return [oddSegments[oddSegments.length - 1]!];
      }
      return oddSegments;
    }
  }

  return undefined;
}
