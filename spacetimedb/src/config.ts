// Settings you fill in once.
export const config = {
  // false: Play Online is open to everyone, guests included; signing in is optional.
  // true: Play Online needs a signed-in account. Keep in step with ONLINE_NEEDS_ACCOUNT in src/main.ts.
  requireAccount: false,

  // Your Firebase project ID (Firebase console → Project settings → "Project ID").
  // While this is empty, Google sign-in is off and anyone can claim a username from their browser.
  // Once set, an account requires a Google sign-in from this Firebase project.
  firebaseProjectId: 'rps10-b5833',

  // Accounts that have every card style unlocked, by identity (from the player table). Ekam1:
  allSkins: ['c20065b074861b3e83e2c2f64434dcf583f4211683462b37eb01b502add43ad2'],
};
