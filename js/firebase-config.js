/* ============================================================
   TRAMARSA LMS — Configuración de Firebase
   ------------------------------------------------------------
   Reemplaza los valores de abajo por los de tu proyecto Firebase:
   Consola de Firebase → Configuración del proyecto → Tus apps →
   app web → "SDK setup and configuration" → Config.

   Requisitos en la consola de Firebase antes de usar la app:
   1. Authentication → Sign-in method → habilitar "Correo electrónico/contraseña".
   2. Firestore Database → crear la base de datos (cualquier región).
   3. Copiar las reglas de firestore.rules (raíz del proyecto) al
      editor de reglas de Firestore.

   No se usan valores de prueba: si no reemplazas este objeto, la
   app lo detecta y muestra un aviso explícito en vez de fallar en
   silencio (ver comprobarFirebaseConfigurado() más abajo).
   ============================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

export const firebaseConfig = {
  apiKey: 'AIzaSyD2L1l6NiFuKRunbKIIHLJSCPILKY75KIM',
  authDomain: 'tramarsa-lms.firebaseapp.com',
  projectId: 'tramarsa-lms',
  storageBucket: 'tramarsa-lms.firebasestorage.app',
  messagingSenderId: '592728620545',
  appId: '1:592728620545:web:eb83d940136dec1aecca00'
};

export function firebaseEstaConfigurado() {
  return !Object.values(firebaseConfig).some(v => typeof v === 'string' && v.startsWith('TU_'));
}

let app = null, auth = null, db = null;
if (firebaseEstaConfigurado()) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

export { app, auth, db };
