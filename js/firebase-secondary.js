/* ============================================================
   TRAMARSA LMS — App secundaria de Firebase, solo para que el admin
   pueda crear cuentas de Auth para otros usuarios sin cerrar su
   propia sesión.
   ------------------------------------------------------------
   Firebase Auth client-side no tiene una operación "admin crea
   usuario para otra persona": createUserWithEmailAndPassword() deja
   autenticado, en el navegador actual, al usuario recién creado — si
   se usara la app principal, el admin perdería su sesión cada vez que
   crea un trabajador. La solución estándar sin Cloud Functions/Admin
   SDK es una segunda instancia de Firebase (mismo proyecto), crear ahí
   la cuenta, cerrar esa sesión secundaria, y la sesión del admin en la
   app principal queda intacta.
   ============================================================ */

import { initializeApp, getApps, deleteApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { firebaseConfig, firebaseEstaConfigurado } from './firebase-config.js';

// Crea (o recrea) la cuenta de Firebase Auth para un usuario, sin tocar
// la sesión del admin que está usando la app principal. Devuelve el uid.
export async function crearCuentaAuthParaUsuario(correo, password) {
  if (!firebaseEstaConfigurado()) {
    throw new Error('Firebase no está configurado todavía (js/firebase-config.js).');
  }
  const nombreApp = 'tramarsa-secundaria';
  const appExistente = getApps().find(a => a.name === nombreApp);
  const appSecundaria = appExistente || initializeApp(firebaseConfig, nombreApp);
  const authSecundaria = getAuth(appSecundaria);

  try {
    const credencial = await createUserWithEmailAndPassword(authSecundaria, correo, password);
    const uid = credencial.user.uid;
    await signOut(authSecundaria);
    return uid;
  } finally {
    await deleteApp(appSecundaria).catch(() => {});
  }
}
