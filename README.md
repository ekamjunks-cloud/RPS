# RPS 10 on Spacetime

The whole game lives in this folder: a Spacetime server module plus a static web page.

- `spacetimedb/src/index.ts` — the server "module": rules, timers, matchmaking, rooms, bot, ratings,
  tutorial gate. This is what you publish to your Spacetime database.
- `src/main.ts`, `index.html`, `src/style.css` — the game players see. It builds into a `dist` folder
  of plain files that you put on any static web host.
- `src/module_bindings/` — the glue between the two. Spacetime's tool regenerates it (step 4).
- `src/auth.ts` — Google sign-in through Firebase.
- `spacetimedb/src/config.ts` — your Firebase project ID goes here.
- `spacetimedb/src/index.test.ts` — 52 automated checks that play whole matches against Spacetime's
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
3. **Install the project** — from this folder:
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
   only serves these files. Or let GitHub Pages do it for you (next section).

After any change to `spacetimedb/src/index.ts`, repeat step 4, then step 6. Always publish the server
first: a page built against new server code can't talk to the old server.

## Deploy with GitHub Pages

`.github/workflows/pages.yml` builds the game and puts it on GitHub Pages every time you push to `main`.
It only publishes the web page; the Spacetime server is still published with `npm run publish:cloud`.

1. Create a GitHub repository and push this folder to its `main` branch. `.env` is meant to be
   committed: it only holds the Firebase web values, which every sign-in page shows anyway.
   `.env.local` stays on your computer.
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push (or run the workflow from the **Actions** tab). The address appears on the workflow run,
   usually `https://<your-username>.github.io/<repository>/`.
4. Put that address in `VITE_SITE_URL` in `.env` (ending in `/`) and push again, so links shared in
   chats show the preview image (see "Link previews").
5. Add the domain (`<your-username>.github.io`, or your own domain) to Firebase's authorized domains
   (see "Google sign-in").

## Before you launch
- **Database visibility.** Your dashboard shows the database as *Private*. If players can't connect
  after publishing, that setting is the first thing to check.
- **Free plan pauses when idle.** It wakes on the next visit (Spacetime says typically under a second).
  The Pro plan keeps it always on.
- **Firebase authorized domains.** Google sign-in only works on domains you've added in Firebase
  (step 6 below). Without it, the sign-in pop-up fails on the live site.
- **Restrict the Firebase API key** (optional): Google Cloud console → APIs & Services → Credentials →
  the "Browser key" → Website restrictions → add your domain(s) and `localhost`.
- **Support email.** When you have one, put it in `SUPPORT_EMAIL` near the top of `src/main.ts`
  (Settings › Contact us) and in the Contact sections of `public/privacy.html` and `public/terms.html`
  (they point players to Report a bug until then).
- **Run the checks:** `npm test`

## Accounts and guests (current setting)

Google sign-in is on, and guests can play everything, ranked online matches included. Signing in keeps
a player's progress on every device and lets them pick their own name. Three switches control this;
keep the client and server in step:

| Switch | Where | Now | What it does |
| --- | --- | --- | --- |
| `ACCOUNTS` | top of `src/main.ts` | `true` | `false` hides sign-in everywhere: guest-only |
| `ONLINE_NEEDS_ACCOUNT` | top of `src/main.ts` | `false` | `true` makes Play Online ask guests to sign in |
| `requireAccount` | `spacetimedb/src/config.ts` | `false` | the server-side lock for the same rule |

After changing them, publish and rebuild (deploy steps 4 and 6).

## Google sign-in (Firebase)

Already set up for the Firebase project `rps10-b5833`. To set it up again or for another project:

1. Go to https://console.firebase.google.com and create a project (Analytics is optional).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable**, pick a support email, Save.
3. **Project settings (gear icon) → Your apps → Web (`</>`)**, register an app. Firebase shows a
   `firebaseConfig` block. Copy `.env.example` to `.env.local` and fill in the four `VITE_FIREBASE_…`
   lines from it. These values are safe to ship in a web page.
4. Put the same **Project ID** in `spacetimedb/src/config.ts`. This is what makes the server accept
   only sign-ins from *your* Firebase project.
   (The live values are in `.env`, so the GitHub Pages build gets them too.)
5. Publish and rebuild (deploy step 4, then 5 or 6).
6. Before going live: **Authentication → Settings → Authorized domains → Add domain** and add the
   domain your game is hosted on. `localhost` is already allowed.

## Link previews

When someone shares the game's link, chat apps and social sites show `public/og-image.png`
(1200×630) with the title and description from `index.html`. Most of them need the image's full
address, so set `VITE_SITE_URL` in `.env` to the game's address, ending in `/`, then rebuild. While it's
empty the page still builds, but some apps won't show the image.

## How players and accounts work here
- A new visitor gets a guest profile automatically, saved in that browser.
- Tutorial, then one practice match, then the home screen.
- **Continue with Google** turns the guest into an account: their stats and progress move across,
  they pick a unique username, and the same Google login works on any device.
- A returning player who signs in on a new device gets their existing account back.
- Guests can play everything, Play Online included (see "Accounts and guests" to change that).
- **Sign out** (Account button, top right) returns the browser to a guest profile.
- Google sign-in opens a pop-up window. Browsers built into apps like Instagram or TikTok often
  block Google sign-in altogether; players arriving that way can still play as guests.

## Keeping an eye on it
- **Dashboard** (spacetimedb.com → your database): players online, logs, energy use, SQL console.
- **Match history:** in the SQL console, `SELECT * FROM match_result`
- **Players and ratings:** `SELECT name, rating, wins, losses, is_guest FROM player`
- **Live logs from Terminal:** `spacetime logs rps-10-b7hi9 --server maincloud`
- **Player reports:** `spacetime sql rps-10-b7hi9 "SELECT reported_name, reason, at FROM report" --server maincloud`

### The admin page
Open `admin.html` on the live site (for example `https://ekamjunks-cloud.github.io/RPS/admin.html`)
and sign in with Google as an admin account. It shows players online, players today, matches and new
players per day, player reports and bug reports. From it you can rename or suspend a player, give coins
or an item (to make up for a bug), and show everyone a notice. Turning on **Maintenance** stops new
online matches from starting (matches already running finish normally); practice still works.
Admins are listed by identity in `admins` in `spacetimedb/src/config.ts`. The page is public, but the
server only sends its data to those accounts.

## Why players can't cheat
Every table is private. The browser only receives what the server's "views" return for that player:
their own hand, how many cards the opponent holds, and each round's cards once both are locked in.
The opponent's pick and which kind they hold four of never leave the server. Hands are dealt with a
secret random seed, and every move is checked on the server.

## Settings
All at the top of `spacetimedb/src/index.ts`: phase timings (`TIMES`), rounds per match (`ROUNDS`),
disconnect grace (`DC_GRACE_MS`), time before a bot joins (`QUEUE_RETRY_MS` × `QUEUE_RETRIES`),
rating steps for repeat opponents (`K_STEPS`). Tutorial text is `TUT` in `src/main.ts`.
Accounts that own every item: `allSkins` in `spacetimedb/src/config.ts`.

### Coins, the Store and the Level road
Everything a player can own is listed once, in `spacetimedb/src/catalog.ts`: each card style, avatar,
aura, chat pack, title, card back, message colour and win effect, with its price and the level that
unlocks it. The game reads the same file, so prices and levels can't drift apart. Coin amounts
(per win, first win of the day, level-ups, achievements, the 300 welcome gift and the daily deal's 20%)
are in `COINS` there. Nobody can buy coins: they are only earned by playing. Coins live in the
`wallet` table and bought items in `owned`, so a payment option can be added later without changing
either. Item names and descriptions shown in the game are in `src/catalog.ts`.

### Leaderboards
**This week** counts ranked matches only (3 points a win, 1 a draw) and empties every Monday 00:00 UTC.
**This month** is the ranked rating, which resets halfway towards 1000 on the 1st (the monthly season).
Unranked matches are rated nowhere: normal XP and coins, no rating change.

## Using a different database
Copy `.env.example` to `.env.local` and change the name there, and change the name in the
`publish:cloud` script in `package.json`.
