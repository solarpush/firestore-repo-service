/**
 * Login page renderer for `firebaseAuth`.
 * Standalone HTML — no JSX. Embeds the Firebase JS SDK from the official CDN
 * (modular v10) so users don't need a frontend build step.
 *
 * Flow:
 *  1. User signs in client-side (email/password or Google popup).
 *  2. We call `user.getIdToken(true)` and `POST` it to `{sessionPath}`.
 *  3. The server mints a session cookie and we redirect to `next`.
 */

interface LoginPageOptions {
  title: string;
  providers: ("password" | "google")[];
  apiKey: string;
  authDomain: string;
  sessionPath: string;
  next: string;
  error: string | null;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonEscape(value: string): string {
  // Safe for embedding inside a <script> string literal.
  return JSON.stringify(value).slice(1, -1);
}

export function renderLoginPage(opts: LoginPageOptions): string {
  const showPassword = opts.providers.includes("password");
  const showGoogle = opts.providers.includes("google");
  const initialError = opts.error ? htmlEscape(opts.error) : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${htmlEscape(opts.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f7;
      color: #1d1d1f;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1d1d1f; color: #f5f5f7; }
      .card { background: #2c2c2e; }
      input { background: #1d1d1f; color: #f5f5f7; border-color: #444; }
      .divider { color: #888; }
      .divider::before, .divider::after { background: #444; }
    }
    .card {
      width: min(420px, 92vw);
      padding: 32px;
      background: #fff;
      border-radius: 14px;
      box-shadow: 0 20px 50px rgba(0,0,0,.08);
    }
    h1 { font-size: 22px; margin: 0 0 6px; font-weight: 600; }
    p.sub { margin: 0 0 24px; opacity: .7; font-size: 14px; }
    label { display: block; font-size: 13px; margin-bottom: 6px; opacity: .8; }
    input {
      width: 100%; padding: 11px 12px;
      border: 1px solid #d2d2d7; border-radius: 8px;
      font-size: 15px; outline: none; background: #fff; color: inherit;
      margin-bottom: 14px;
    }
    input:focus { border-color: #0071e3; box-shadow: 0 0 0 3px rgba(0,113,227,.15); }
    button {
      width: 100%; padding: 11px 12px; border: none; border-radius: 8px;
      font-size: 15px; font-weight: 500; cursor: pointer;
      transition: opacity .15s, transform .05s;
    }
    button:active { transform: scale(.98); }
    button:disabled { opacity: .55; cursor: progress; }
    .btn-primary { background: #0071e3; color: #fff; }
    .btn-google {
      background: #fff; color: #1d1d1f; border: 1px solid #d2d2d7;
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    @media (prefers-color-scheme: dark) {
      .btn-google { background: #2c2c2e; color: #f5f5f7; border-color: #444; }
    }
    .divider {
      display: flex; align-items: center; gap: 12px;
      margin: 16px 0; font-size: 12px; opacity: .55; text-transform: uppercase;
    }
    .divider::before, .divider::after {
      content: ""; flex: 1; height: 1px; background: #d2d2d7;
    }
    .err {
      margin: 0 0 14px; padding: 10px 12px;
      background: rgba(255,59,48,.12); color: #ff3b30;
      border-radius: 8px; font-size: 13px;
      display: ${initialError ? "block" : "none"};
    }
    .ok {
      margin: 0 0 14px; padding: 10px 12px;
      background: rgba(52,199,89,.12); color: #34c759;
      border-radius: 8px; font-size: 13px; display: none;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>${htmlEscape(opts.title)}</h1>
    <p class="sub">Sign in to continue.</p>
    <div id="err" class="err">${initialError}</div>
    <div id="ok" class="ok"></div>

    ${
      showPassword
        ? `<form id="pwd-form" autocomplete="on">
      <label for="email">Email</label>
      <input id="email" type="email" name="email" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" type="password" name="password" autocomplete="current-password" required />
      <button class="btn-primary" type="submit" id="pwd-submit">Sign in</button>
    </form>`
        : ""
    }

    ${showPassword && showGoogle ? `<div class="divider">or</div>` : ""}

    ${
      showGoogle
        ? `<button class="btn-google" type="button" id="google-btn">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
        <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
        <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
        <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
      </svg>
      Continue with Google
    </button>`
        : ""
    }
  </main>

  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
    import {
      getAuth,
      signInWithEmailAndPassword,
      signInWithPopup,
      GoogleAuthProvider,
      setPersistence,
      browserSessionPersistence,
    } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

    const app = initializeApp({
      apiKey:     "${jsonEscape(opts.apiKey)}",
      authDomain: "${jsonEscape(opts.authDomain)}",
    });
    const auth = getAuth(app);
    // Don't persist client-side — the server-side session cookie is the source of truth.
    await setPersistence(auth, browserSessionPersistence).catch(() => {});

    const SESSION_PATH = "${jsonEscape(opts.sessionPath)}";
    const NEXT = ${JSON.stringify(opts.next)};

    const errEl = document.getElementById("err");
    const okEl  = document.getElementById("ok");
    function showError(msg) {
      errEl.textContent = msg;
      errEl.style.display = "block";
      okEl.style.display = "none";
    }
    function showOk(msg) {
      okEl.textContent = msg;
      okEl.style.display = "block";
      errEl.style.display = "none";
    }

    async function exchangeForSession(user) {
      const idToken = await user.getIdToken(true);
      const res = await fetch(SESSION_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Session exchange failed (" + res.status + ")");
      }
      // Sign out client-side immediately — we only needed the id token.
      try { await auth.signOut(); } catch {}
      showOk("Signed in. Redirecting…");
      window.location.replace(NEXT);
    }

    const pwdForm = document.getElementById("pwd-form");
    if (pwdForm) {
      pwdForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const submit = document.getElementById("pwd-submit");
        submit.disabled = true;
        try {
          const email = document.getElementById("email").value.trim();
          const password = document.getElementById("password").value;
          const cred = await signInWithEmailAndPassword(auth, email, password);
          await exchangeForSession(cred.user);
        } catch (err) {
          showError(err && err.message ? err.message : String(err));
          submit.disabled = false;
        }
      });
    }

    const googleBtn = document.getElementById("google-btn");
    if (googleBtn) {
      googleBtn.addEventListener("click", async () => {
        googleBtn.disabled = true;
        try {
          const provider = new GoogleAuthProvider();
          const cred = await signInWithPopup(auth, provider);
          await exchangeForSession(cred.user);
        } catch (err) {
          showError(err && err.message ? err.message : String(err));
          googleBtn.disabled = false;
        }
      });
    }
  </script>
</body>
</html>`;
}
