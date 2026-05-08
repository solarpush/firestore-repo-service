/**
 * Firebase Auth helper for `servers.admin()` and `servers.crud()`.
 * See {@link firebaseAuth} for full documentation.
 *
 * @module servers/auth
 */

export {
  firebaseAuth,
  isAuthExtension,
  allowAll,
} from "./firebase-auth";

export type {
  AuthExtension,
  AuthRoute,
  AuthUser,
  DecodedIdTokenLike,
  FirebaseAdminAuthLike,
  FirebaseAuthConfig,
  FirebaseAuthLoginPageConfig,
  FirebaseAuthMode,
} from "./firebase-auth";

export { SESSION_COOKIE_DEFAULT, parseCookies } from "./session";
