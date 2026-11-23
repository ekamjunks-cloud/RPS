// Settings you fill in once.
export const config = {
  // false: everyone plays as a guest, including ranked online matches (no sign-in anywhere).
  // true: Play Online needs an account. Also set ACCOUNTS = true at the top of src/main.ts.
  requireAccount: false,

  // Your Firebase project ID (Firebase console → Project settings → "Project ID").
  // While this is empty, Google sign-in is off and anyone can claim a username from their browser.
  // Once set, an account requires a Google sign-in from this Firebase project.
  firebaseProjectId: '',
};
