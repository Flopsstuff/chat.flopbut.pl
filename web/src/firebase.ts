import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, GoogleAuthProvider, getAuth } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase } from 'firebase/database';

// In dev the app talks to the local emulators under a demo project, so nothing can reach
// production by accident. Set VITE_FIREBASE_EMULATORS=false to run dev against production.
const useEmulators = import.meta.env.DEV && import.meta.env.VITE_FIREBASE_EMULATORS !== 'false';

// The web config is public by design: access is enforced by the server and the RTDB rules.
const config = useEmulators
  ? {
      apiKey: 'demo-key',
      authDomain: 'demo-chat.firebaseapp.com',
      projectId: 'demo-chat',
      databaseURL: 'http://127.0.0.1:9000?ns=demo-chat-default-rtdb',
    }
  : {
      apiKey: 'AIzaSyAQB7BFJNU6hDGJ-ultMWswJYJAfJeSpwI',
      // Our own domain, not flopbut.firebaseapp.com: the server passes /__/auth through to
      // Firebase, so sign-in stays on one site and Safari and in-app browsers let the result
      // through (server/authProxy.ts).
      authDomain: 'chat.flopbut.pl',
      projectId: 'flopbut',
      databaseURL: 'https://flopbut-default-rtdb.europe-west1.firebasedatabase.app',
      appId: '1:647538737053:web:80ada23e0560579b59b974',
    };

export const firebaseApp = initializeApp(config);
export const auth = getAuth(firebaseApp);
/** Read-only from the client: the rules forbid every write, the server writes. */
export const database = getDatabase(firebaseApp);

if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectDatabaseEmulator(database, '127.0.0.1', 9000);
}

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
