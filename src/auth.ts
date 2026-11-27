// Google, or email and password, sign-in through Firebase. Loaded in the background so guests never wait for it.
// The Firebase ID token is what proves to the game server who the player is.
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, type User } from 'firebase/auth';

export type Profile = { name: string; email: string; photo: string; provider: 'google' | 'email' };

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
  u ? { name: u.displayName || '', email: u.email || '', photo: u.photoURL || '',
    provider: u.providerData.some(p => p.providerId === 'google.com') ? 'google' : 'email' } : null;

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
/** Email and password: sign in to an existing account, or make a new one (which also gets a "verify your email" message). */
export async function emailSignIn(email: string, password: string, create: boolean): Promise<Profile> {
  if (!auth) throw new Error('not-configured');
  const r = create ? await createUserWithEmailAndPassword(auth, email, password) : await signInWithEmailAndPassword(auth, email, password);
  if (create) sendEmailVerification(r.user).catch(() => {});
  return profile(r.user)!;
}
/** Firebase emails a link for choosing a new password. */
export async function resetPassword(email: string): Promise<void> {
  if (!auth) throw new Error('not-configured');
  await sendPasswordResetEmail(auth, email);
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
