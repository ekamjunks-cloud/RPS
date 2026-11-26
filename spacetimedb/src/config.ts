// Settings you fill in once.
export const config = {
  // false: Play Online is open to everyone, guests included; signing in is optional.
  // true: Play Online needs a signed-in account. Keep in step with ONLINE_NEEDS_ACCOUNT in src/main.ts.
  requireAccount: false,

  // Your Firebase project ID (Firebase console → Project settings → "Project ID").
  // While this is empty, Google sign-in is off and anyone can claim a username from their browser.
  // Once set, an account requires a Google sign-in from this Firebase project.
  firebaseProjectId: 'rps10-b5833',

  // Accounts that own every item (card styles, avatars, auras, chat packs and Level-road rewards), by identity.
  allSkins: [
    'c20065b074861b3e83e2c2f64434dcf583f4211683462b37eb01b502add43ad2', // Ekam1
    'c2004076ec97424761c09a2cb5a99fc54dc4f598604d6696fade295f1e0594c1', // paper
  ] as string[],

  // Accounts that can open the admin page (reports, bug reports, rename, suspend, grant, notices).
  admins: [
    'c20065b074861b3e83e2c2f64434dcf583f4211683462b37eb01b502add43ad2', // Ekam1
  ] as string[],
};
