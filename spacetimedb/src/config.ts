// Settings you fill in once.
export const config = {
  // false: Play Online is open to everyone, guests included; signing in is optional.
  // true: Play Online needs a signed-in account. Keep in step with ONLINE_NEEDS_ACCOUNT in src/main.ts.
  requireAccount: false,

  // Your Firebase project ID (Firebase console → Project settings → "Project ID").
  // While this is empty, Google sign-in is off and anyone can claim a username from their browser.
  // Once set, an account requires a Google sign-in from this Firebase project.
  firebaseProjectId: 'rps10-b5833',
};
