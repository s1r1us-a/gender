/* Auth-Schicht: Login-Form, Passwort-Wechsel, Role-Resolution, Login-Gate. */

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth, db } from "./firebase.js";
import { ref, get, set, serverTimestamp } from "./sync.js";
import { state, notify } from "./state.js";
import { flushPending } from "./sync.js";
import { maybeShowOnboarding } from "./ui.js";

/* ---------- Auth / Rollen ---------- */
const ADMIN_EMAIL  = "raederich@outlook.com";
const VIEWER_EMAIL = "nele.busse@web.de";
const ALLOWED_EMAILS = [ADMIN_EMAIL, VIEWER_EMAIL];

function roleFor(email) {
  const e = (email || "").trim().toLowerCase();
  if (e === ADMIN_EMAIL)  return "admin";
  if (e === VIEWER_EMAIL) return "viewer";
  return null;
}

let loginGate, loginForm, loginEmail, loginPassword, loginError, loginSubmit;
let changePwForm, newPassword, newPasswordRepeat, changePwError, changePwSubmit, changePwCancel;
let userBadge, logoutBtn;

function showLoginView() {
  loginGate.hidden = false;
  loginForm.hidden = false;
  changePwForm.hidden = true;
  loginError.textContent = "";
  changePwError.textContent = "";
  newPassword.value = "";
  newPasswordRepeat.value = "";
}
function showChangePwView() {
  loginGate.hidden = false;
  loginForm.hidden = true;
  changePwForm.hidden = false;
  changePwError.textContent = "";
}
function hideLoginGate() {
  loginGate.hidden = true;
  loginPassword.value = "";
  newPassword.value = "";
  newPasswordRepeat.value = "";
}

function applyRoleUI() {
  document.body.classList.toggle("viewer-mode", state.currentRole === "viewer");
  if (state.currentUser) {
    userBadge.textContent = state.currentUser.email || "";
    userBadge.hidden = false;
    logoutBtn.hidden = false;
    logoutBtn.title = state.currentUser.email
      ? `Abmelden (${state.currentUser.email})`
      : "Abmelden";
  } else {
    userBadge.hidden = true;
    logoutBtn.hidden = true;
    logoutBtn.title = "Abmelden";
  }
}

function friendlyAuthError(err) {
  const code = err && err.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("invalid-login-credentials"))
    return "E-Mail oder Passwort stimmt nicht.";
  if (code.includes("user-not-found"))   return "Unbekannte E-Mail-Adresse.";
  if (code.includes("invalid-email"))    return "Ungültige E-Mail-Adresse.";
  if (code.includes("too-many-requests")) return "Zu viele Versuche. Bitte kurz warten.";
  if (code.includes("network"))           return "Netzwerk-Problem. Bitte erneut versuchen.";
  if (code.includes("weak-password"))     return "Passwort zu schwach (mind. 8 Zeichen).";
  if (code.includes("requires-recent-login")) return "Bitte erneut anmelden, um das Passwort zu ändern.";
  return "Anmeldung fehlgeschlagen.";
}

async function needsPasswordChange(uid) {
  try {
    const snap = await get(ref(db, `meta/users/${uid}/passwordChanged`));
    return !(snap.exists() && snap.val() === true);
  } catch {
    // Im Zweifel sicherheitshalber Wechsel verlangen.
    return true;
  }
}

export function initAuth() {
  loginGate     = document.getElementById("loginGate");
  loginForm     = document.getElementById("loginForm");
  loginEmail    = document.getElementById("loginEmail");
  loginPassword = document.getElementById("loginPassword");
  loginError    = document.getElementById("loginError");
  loginSubmit   = document.getElementById("loginSubmit");
  changePwForm       = document.getElementById("changePwForm");
  newPassword        = document.getElementById("newPassword");
  newPasswordRepeat  = document.getElementById("newPasswordRepeat");
  changePwError      = document.getElementById("changePwError");
  changePwSubmit     = document.getElementById("changePwSubmit");
  changePwCancel     = document.getElementById("changePwCancel");
  userBadge          = document.getElementById("userBadge");
  logoutBtn          = document.getElementById("logoutBtn");

  loginForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    loginError.textContent = "";
    const email = (loginEmail.value || "").trim().toLowerCase();
    const pw    = loginPassword.value || "";
    if (!ALLOWED_EMAILS.includes(email)) {
      loginError.textContent = "Kein zugelassener Account.";
      return;
    }
    loginSubmit.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, email, pw);
      // weiter geht's in onAuthStateChanged
    } catch (err) {
      loginError.textContent = friendlyAuthError(err);
    } finally {
      loginSubmit.disabled = false;
    }
  });

  changePwForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    changePwError.textContent = "";
    const a = newPassword.value || "";
    const b = newPasswordRepeat.value || "";
    if (a.length < 8) { changePwError.textContent = "Passwort muss mind. 8 Zeichen haben."; return; }
    if (a !== b)      { changePwError.textContent = "Passwörter stimmen nicht überein."; return; }
    if (!auth.currentUser) { changePwError.textContent = "Nicht angemeldet."; return; }
    changePwSubmit.disabled = true;
    try {
      await updatePassword(auth.currentUser, a);
      await set(ref(db, `meta/users/${auth.currentUser.uid}`), {
        passwordChanged: true,
        changedAt: serverTimestamp(),
        email: auth.currentUser.email || null
      });
      hideLoginGate();
    } catch (err) {
      changePwError.textContent = friendlyAuthError(err);
    } finally {
      changePwSubmit.disabled = false;
    }
  });

  changePwCancel.addEventListener("click", async () => {
    try { await signOut(auth); } catch {}
  });

  logoutBtn.addEventListener("click", async () => {
    try { await signOut(auth); } catch {}
    // Nach Logout: Reload statt komplexem Teardown der Listener.
    location.reload();
  });

  /* Erster Auth-Callback entfernt den Boot-Splash — egal ob User
     eingeloggt ist oder nicht. So gibt es kein kurzes Aufblitzen
     des Login-Formulars vor der automatischen Weiterleitung. */
  const authBoot = document.getElementById("authBoot");
  const removeAuthBoot = () => { if (authBoot) authBoot.hidden = true; };

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      state.currentUser = null;
      state.currentRole = null;
      applyRoleUI();
      notify();
      showLoginView();
      removeAuthBoot();
      return;
    }
    const role = roleFor(user.email);
    if (!role) {
      // Unbekannter Account: sofort wieder rauswerfen.
      await signOut(auth).catch(() => {});
      loginError.textContent = "Kein zugelassener Account.";
      removeAuthBoot();
      return;
    }
    state.currentUser = user;
    state.currentRole = role;
    applyRoleUI();
    notify();
    if (await needsPasswordChange(user.uid)) {
      showChangePwView();
    } else {
      hideLoginGate();
      maybeShowOnboarding();
    }
    removeAuthBoot();
    // Falls vor dem Login Pending-Ops anstanden, jetzt sync versuchen.
    if (role === "admin") flushPending();
  });
}
