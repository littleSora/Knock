# Knock: video calls and messaging

Guests join a call with a random code and a nickname. Signed-in people join calls under their display name (no nickname step) and also get a dashboard, friends with live presence, direct messages, and an Inbox/Spam split for notifications.
"Knock" is a placeholder name; rename it in `views/*.html` and `server/auth.js`.

## Run it (Windows PowerShell)

Needs **Node.js 22.13 or newer** (`node -v`). No database to install: SQLite is built into Node.

```powershell
copy .env.example .env
npm install
npm start
```

Open http://localhost:3000. To test a call, open a second window in a private/incognito tab and join with the code.

In development, with the `.env` keys left blank:
- the CAPTCHA page shows a "Continue (dev mode)" button,
- sign-in codes are printed in the terminal instead of being texted or emailed.

Camera and mic need **HTTPS** on anything other than `localhost`.

## Turning on the real services (all keys go in `.env`, never in the browser code)

| Feature | Variables | Where to get it |
|---|---|---|
| Human check | `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET` | google.com/recaptcha/admin (type: v2 "I'm not a robot") |
| Continue with Google | `GOOGLE_CLIENT_ID` | Google Cloud Console > Credentials > OAuth client ID (Web). Add your site as an authorized JavaScript origin |
| Email (Gmail) codes | `SMTP_URL`, `MAIL_FROM` | Any SMTP server. For Gmail use an app password: `smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com` |
| Phone (SMS) codes | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | twilio.com |
| Calls behind strict firewalls | `TURN_URL`, `TURN_SECRET` | Your own coturn server (`static-auth-secret`) |

Production (`NODE_ENV=production`) refuses to start without `COOKIE_SECRET` (32+ chars) and both reCAPTCHA keys.
Behind a proxy/host such as nginx, Render or Cloudflare, set `TRUST_PROXY=1` so rate limits use real visitor IPs.

## Where each requirement lives

| Requirement | Implementation |
|---|---|
| Guest sessions with random ID | `POST /api/sessions` makes a 10-character code (about 1.1e15 possibilities, from a crypto RNG). `/s/<code>` is the room |
| Nickname before entering (guests) | Lobby screen in `views/room.html`; the server also rejects a guest `room:join` without one. Signed-in people skip it and always use their display name (`server/realtime.js`) |
| Landing + login (phone, Google, Gmail) | `/` and `/login`. Phone and email use one-time codes; Google uses a verified ID token (`server/auth.js`) |
| Dashboard | `/dashboard`: calls yesterday (plus a 7-day strip), all of your scheduled calls (upcoming grouped by day, earlier ones tucked away, with a form to add them), and Smart recaps |
| Notifications | Bell icon, top right. Inbox = friends' messages + "added you as a friend". Spam tab = people not on your list. Spam never raises the badge |
| Smart recaps | During a call, the Recap tab lets anyone jot a decision or a follow-up with an owner (synced live, stored in `recap_items`). Everyone who was in the call sees it on their dashboard and can tick follow-ups off (`/api/recaps`) |
| Profile card in a call | Tap anyone's avatar on their video tile: display name, name at signup, account creation date, and a Send friend request button (`/api/users/:handle`) |
| Friends | Profile page `/u/<handle>` has the add-friend icon; the other person is notified. Friends panel: Unfriend on the left, green/gray dot on the right, online first |
| Guest → account, mid-call | Guests see a bar in the call (and a link in the lobby) to log in or create an account. It sends them to `/login?next=/s/<code>` and they rejoin as a member, so others can then open their profile card |
| Host ends the session | The creator (signed-in owner, or the signed per-session host cookie a guest creator gets) is the host. The host's Leave button and the top-left logo ask "End this session?"; confirming sends `room:end`, which removes everyone and marks the session ended (`call_sessions.ended_at`). Everyone else is asked to confirm only when clicking the logo |
| Hide/show the code | Eye button in the call's top bar. The code is hidden when you enter |
| Friends, notifications and chat during a call | The call's top right has Find people, Friends, the bell, and **Copy invite link** right beside them (icon only on phones). Direct-message chats open as a dock bottom-left; "Invite to call" there sends *this* call's link and keeps you in it, and profile/invite links open in a new tab so you never drop out of the call |
| One seat per person | You can't join a call you're already in. The server refuses a second connection from the same account (`already_in_call`, covers other browsers and devices) and a browser lock (`navigator.locks`) stops a second tab, guests included. Leaving, closing the tab or disconnecting frees the seat |
| Friend profile card + group chats | In a direct-message chat, the friend's name (no underline) opens their picture and details, with **Create a group with …**. Name the group, then **Add another friend** shows your friend list (or a "make a friend first" note if it's empty). Groups appear in the Friends panel. In a group chat, tapping the group name shows its name, creation date, members and a rename box (`server/api.js` `/api/groups*`, `public/js/topbar.js`) |
| Profile menu | Round picture button, top right (and in calls). Change display name, see account details (Gmail/email and mobile show `n/a` when empty), upload a picture up to 3 MB and crop it to the circle (`public/js/account.js`, `cropper.js`). Stored as a 256×256 JPEG in the `avatars` table; the server accepts only real PNG/JPEG/WebP bytes up to 512 KB |
| Settings page | **Settings** button at the bottom of the account info (round picture, top right) opens `/settings` (a new tab when you're in a call). Sections: Appearance, Email/phone/sign-in, Names, Security. See below |
| CAPTCHA | reCAPTCHA gate at `/verify`. Every page, API route and WebSocket needs the signed "human" cookie it sets |
| Hidden keys and endpoints | See below |

## Settings page (`/settings`)

- **Appearance** (`public/js/theme-core.js`, `theme.js`, `colorwheel.js`): 10 presets (Match my device, Day, Night, High contrast, High contrast light, and gradients Sunset, Ocean, Candy, Aurora, Nebula) or build your own with a real colour wheel, hex box and brightness slider for the background (solid or two-colour gradient with direction), buttons and highlights. Text colour is picked automatically for readability (with a warning if the background makes text hard to read, and a manual Dark/Light text override). The whole app restyles live and the theme is saved on the account (`users.theme`, `PUT/DELETE /api/me/theme`), cached in `localStorage` and replayed by `theme-boot.js` before first paint so there is no flash.
- **Change email or phone**: the new address/number gets a 6-digit code and only replaces the old one after you enter it (`/api/auth/contact/request` and `/verify`, same hashing, 10-minute expiry and 5-attempt limit as sign-in). A number or address already used by another account is refused. You can remove one as long as another way to sign in remains.
- **Names**: display name and username (3-20 lowercase letters/numbers, unique, 5 changes per hour).
- **Security**: "Sign out of other devices" ends every other login for the account.
- In development the change-of-email/phone codes are printed in the terminal, like sign-in codes.

## Security notes

- Secrets live only in `.env` (git-ignored) and are used only by the server. The browser talks to same-origin `/api/*`; Google, Twilio and SMTP are called from the server.
- Two identifiers are public by design and are sent to the browser only after the human check: the reCAPTCHA *site* key and the Google *client ID*. Restrict both to your domain in their consoles.
- TURN passwords are generated per request and expire after an hour (`GET /api/ice`); the TURN secret never leaves the server.
- Every API route is behind the human check, a rate limit and (where needed) a login. Sign-in codes are stored hashed, expire in 10 minutes and allow 5 attempts.
- Login cookie: random token, `HttpOnly`, `SameSite=Lax`, `Secure` in production, only its hash is stored. Cross-site POSTs are rejected, WebSockets are same-origin only, and `helmet` sets a strict Content-Security-Policy.
- Names and messages are rendered as text (never as HTML).

## Behavior worth knowing

- **Friend adds are one-way.** Adding someone puts them in *your* list and notifies them. Whether a message is spam depends on whether the *recipient* has the sender in their list. Presence is visible to anyone who has added you, so for a privacy-first product add an accept step.
- Calls are peer-to-peer mesh, comfortable up to about 6 people (`MAX_PEOPLE` in `server/realtime.js`). Larger rooms need an SFU such as LiveKit.
- A "call" for the dashboard is a session where you were present with at least one other person.
- Run a single server process; presence and live rooms are kept in memory.
- Group members must be on the creator's friend list when the group is made. Any member can rename the group. Leaving/removing members and group unread badges are not built yet.
- Not included yet: blocking/reporting, account deletion, linking Google from Settings (it links automatically the first time you use Google with the same email), email/SMS cost controls beyond rate limits.
