// Google sign-in through Firebase. Loaded in the background so guests never wait for it.
// The Firebase ID token is what proves to the game server who the player is.
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, type User } from 'firebase/auth';

export type Profile = { name: string; email: string; photo: string };

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
/** False until the Firebase values are filled in (.env.local): the game then runs guest-only. */
export const configured = !!(cfg.apiKey && cfg.authDomain && cfg.projectId);
const auth = configured ? getAuth(initializeApp(cfg)) : null;

const profile = (u: User | null): Profile | null =>
  u ? { name: u.displayName || '', email: u.email || '', photo: u.photoURL || '' } : null;

/** The player who was signed in last time on this device, if any. */
export async function restore(): Promise<Profile | null> {
  if (!auth) return null;
  await auth.authStateReady();
  return profile(auth.currentUser);
}
export async function signIn(): Promise<Profile> {
  if (!auth) throw new Error('not-configured');
  const r = await signInWithPopup(auth, new GoogleAuthProvider());
  return profile(r.user)!;
}
export async function signOutUser(): Promise<void> {
  if (auth) await signOut(auth);
}
/** A current ID token (Firebase refreshes it when it is close to its one-hour expiry). */
export async function token(): Promise<string> {
  const u = auth && auth.currentUser;
  if (!u) throw new Error('signed-out');
  return u.getIdToken();
}
