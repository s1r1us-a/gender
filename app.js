/* Entry-Point: verdrahtet die Module in fester Reihenfolge.

   1) Render abonniert sich auf state-Änderungen, damit ein späteres
      notify() aus initSync den ersten Paint auslöst.
   2) UI initialisiert DOM-Refs + Event-Handler (Sheet, FAB, Toasts, Info-Karten).
   3) Sync lädt lokale Daten, ruft notify() (erster Render!), abonniert Firebase.
   4) Auth verdrahtet Login-Form und onAuthStateChanged.
*/

import { initRender } from "./render.js";
import { initUi } from "./ui.js";
import { initSync } from "./sync.js";
import { initAuth } from "./auth.js";

initRender();
initUi();
initSync();
initAuth();
