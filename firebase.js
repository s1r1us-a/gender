/* Firebase-Bootstrap. Initialisiert App, DB, Auth einmalig und stellt sie
   den anderen Modulen zur Verfügung. */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// HINWEIS: Damit Lesen/Schreiben funktioniert müssen die Realtime-DB-Regeln in der
// Firebase-Console entsprechend gesetzt sein. Die Daten sind persönlicher Natur –
// bitte sicherstellen, dass der Zugriff abgesichert ist.
const firebaseConfig = {
  apiKey: "AIzaSyCeX68K7Vf5QPPdcd_JKpOEi4LUYCkZmZ8",
  authDomain: "gender-4ba3f.firebaseapp.com",
  databaseURL: "https://gender-4ba3f-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "gender-4ba3f",
  storageBucket: "gender-4ba3f.firebasestorage.app",
  messagingSenderId: "1010456171607",
  appId: "1:1010456171607:web:b848b8064899d3a9f6bf12",
  measurementId: "G-MH3Q769WR3"
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});
