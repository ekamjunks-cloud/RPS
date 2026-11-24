# RPS 10 on Spacetime

This folder is a complete, separate version of the game that runs on Spacetime instead of the Node
server in the parent folder. Nothing here depends on the parent folder.

- `spacetimedb/src/index.ts` — the server "module": rules, timers, matchmaking, rooms, bot, ratings,
  tutorial gate. This is what you publish to your Spacetime database.
- `src/main.ts`, `index.html`, `src/style.css` — the game players see. It builds into a `dist` folder
  of plain files that you put on any static web host.
- `src/module_bindings/` — the glue between the two. Spacetime's tool regenerates it (step 4).
- `src/auth.ts` — Google sign-in through Firebase.
- `spacetimedb/src/config.ts` — your Firebase project ID goes here.
- `spacetimedb/src/index.test.ts` — 22 automated checks that play whole matches against Spacetime's
  real datastore.

## Deploy it (first time)

Run these in Terminal. Steps 1–2 are one-off.

1. **Install Spacetime's tool** (the same command your dashboard shows):
   ```
   curl -sSf https://install.spacetimedb.com | sh
   ```
2. **Sign in** — opens your browser; use the same account as the dashboard (@ekamjunks):
   ```
   spacetime login
   ```
3. **Install the project** — from this `spacetime` folder:
   ```
   npm install
   npm --prefix spacetimedb install
   ```
4. **Publish the server to your database** `rps-10-b7hi9`, then regenerate the glue code from it:
   ```
   npm run publish:cloud
   npm run generate
   ```
   If publish refuses because of what's already in the database, add `-- --delete-data` to the publish
   command. That wipes the database, which is fine before launch and never something to do after.
5. **Try it on your computer:**
   ```
   npm run dev
   ```
   Open http://localhost:5173. For a second player, open a private/incognito window.
6. **Put the game online:**
   ```
   npm run build
   ```
   Upload the `dist` folder to a static host (Netlify, Cloudflare Pages and Vercel all take a folder
   like this), then point your domain at it. Spacetime runs the server and database; the static host
   only serves these files.

After any change to `spacetimedb/src/index.ts`, repeat step 4, then step 6.

## Before you launch
- **Database visibility.** Your dashboard shows the database as *Private*. If players can't connect
  after publishing, that setting is the first thing to check.
- **Free plan pauses when idle.** It wakes on the next visit (Spacetime says typically under a second).
  The Pro plan keeps it always on.
- **Run the checks:** `npm test`

## Guest-only mode (current setting)

Sign-in is switched off: everyone plays as a guest, including ranked online matches, and the leaderboard
shows guest names. A guest profile lives in the browser that created it. To bring accounts back, set
`ACCOUNTS = true` at the top of `src/main.ts` and `requireAccount: true` in `spacetimedb/src/config.ts`,
then publish and rebuild.

## Turn on Google sign-in (Firebase)

Only applies once accounts are switched back on (see above).

Until you do this the game runs guest-only and the button says "Create account" (username only).

1. Go to https://console.firebase.google.com and create a project (Analytics is optional).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable**, pick a support email, Save.
3. **Project settings (gear icon) → Your apps → Web (`</>`)**, register an app. Firebase shows a
   `firebaseConfig` block. Copy `.env.example` to `.env.local` and fill in the four `VITE_FIREBASE_…`
   lines from it. These values are safe to ship in a web page.
4. Put the same **Project ID** in `spacetimedb/src/config.ts`. This is what makes the server accept
   only sign-ins from *your* Firebase project.
5. Publish and rebuild (deploy step 4, then 5 or 6).
6. Before going live: **Authentication → Settings → Authorized domains → Add domain** and add the
   domain your game is hosted on. `localhost` is already allowed.

## How players and accounts work here
- A new visitor gets a guest profile automatically, saved in that browser.
- Tutorial, then one practice match, then the home screen.
- **Continue with Google** turns the guest into an account: their stats and progress move across,
  they pick a unique username, and the same Google login works on any device.
- A returning player who signs in on a new device gets their existing account back.
- **Play Online needs an account.** Practice and friend rooms work for guests.
- **Sign out** (Account button, top right) returns the browser to a guest profile.
- Google sign-in opens a pop-up window. Browsers built into apps like Instagram or TikTok often
  block Google sign-in altogether; players arriving that way can still play as guests.

## Keeping an eye on it
- **Dashboard** (spacetimedb.com → your database): players online, logs, energy use, SQL console.
- **Match history:** in the SQL console, `SELECT * FROM match_result`
- **Players and ratings:** `SELECT name, rating, wins, losses, is_guest FROM player`
- **Live logs from Terminal:** `spacetime logs rps-10-b7hi9 --server maincloud`

## Why players can't cheat
Every table is private. The browser only receives what the server's "views" return for that player:
their own hand, how many cards the opponent holds, and each round's cards once both are locked in.
The opponent's pick and which kind they hold four of never leave the server. Hands are dealt with a
secret random seed, and every move is checked on the server.

## Settings
All at the top of `spacetimedb/src/index.ts`: phase timings (`TIMES`), rounds per match (`ROUNDS`),
disconnect grace (`DC_GRACE_MS`), time before a bot joins (`QUEUE_RETRY_MS` × `QUEUE_RETRIES`),
rating steps for repeat opponents (`K_STEPS`). Tutorial text is `TUT` in `src/main.ts`.

## Using a different database
Copy `.env.example` to `.env.local` and change the name there, and change the name in the
`publish:cloud` script in `package.json`.
