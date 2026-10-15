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
| Repeating calls | When scheduling, **Repeat** offers every day, every weekday (Mon–Fri), every week, every 2 weeks or every month, with an optional last day (`appointments.recurrence`, `repeat_until`; rules in `public/js/recurrence.js`, shared by the dashboard and the server). A series is one row that always shows its **next** call, and **Cancel series** removes all of it. It keeps one **standing link**: if the host ends a call, everyone is sent out but the code works again at the next one (`isStandingSession` in `server/db.js`). Times follow wall-clock time in the viewer's zone, so 9:00 stays 9:00 across daylight saving. A monthly call on the 29th–31st skips months without that day, the same way calendar apps do. A weekday series that starts on a weekend begins the next Monday |
| Calendar export (.ics) | **Calendar** on any scheduled call downloads its `.ics`; **Add all to my calendar (.ics)** under the list downloads every upcoming call and repeating series (`GET /api/appointments/:id/ics`, `GET /api/calendar.ics`, built by `server/ics.js`). Each entry has the invite link as its location and description, a 10-minute reminder, and lasts one hour. Repeating calls export as one event with an `RRULE`, so the calendar app expands them itself. Times are written in UTC. This is a one-time file, not a live subscription: later changes on the dashboard don't update a calendar you already imported into |
| Screen sharing | **Share your screen** button in the call controls (hidden in browsers without `getDisplayMedia`, which includes most phone browsers). Your screen replaces your camera in every connection (`RTCRtpSender.replaceTrack`, so no renegotiation), the tile grows to full width and shows the screen uncropped with "· presenting", and everyone who joins mid-share sees it too. Stop with the button or the browser's own *Stop sharing* bar and your camera comes back. Screen audio isn't shared. People can't share unless the browser supports it, but anyone in the call can watch (`public/js/room.js`) |
| Notifications | Bell icon, top right. Inbox = friend requests (with **Accept / Decline** right in the bell), "accepted your request" notices, unread group chats, and friends' messages. Spam tab = people who aren't your friends. Spam never raises the badge |
| Smart recaps | During a call, the Recap tab lets anyone jot a decision or a follow-up with an owner (synced live, stored in `recap_items`). Everyone who was in the call sees it on their dashboard and can tick follow-ups off (`/api/recaps`) |
| Profile card in a call | Tap anyone's avatar on their video tile: display name, name at signup, account creation date, and a Send friend request button (`/api/users/:handle`) |
| Friends | Friendship is **mutual and needs consent**. **Add friend** (profile page or a call's profile card) sends a request; the other person accepts or declines from the bell or from your profile. Friends panel: Unfriend on the left, green/gray dot on the right, online first. Unfriending removes both sides (`/api/friends*`, `friend_requests` table) |
| Guest → account, mid-call | Guests see a bar in the call (and a link in the lobby) to log in or create an account. It sends them to `/login?next=/s/<code>` and they rejoin as a member, so others can then open their profile card |
| Host ends the session | The creator (signed-in owner, or the signed per-session host cookie a guest creator gets) is the host. The host's Leave button and the top-left logo ask "End this session?"; confirming sends `room:end`, which removes everyone and marks the session ended (`call_sessions.ended_at`). Everyone else is asked to confirm only when clicking the logo |
| Hide/show the code | Eye button in the call's top bar. The code is hidden when you enter |
| Friends, notifications and chat during a call | The call's top right has Find people, Friends, the bell, and **Copy invite link** right beside them (icon only on phones). Direct-message chats open as a dock bottom-left; "Invite to call" there sends *this* call's link and keeps you in it, and profile/invite links open in a new tab so you never drop out of the call |
| One seat per person | You can't join a call you're already in. The server refuses a second connection from the same account (`already_in_call`, covers other browsers and devices) and a browser lock (`navigator.locks`) stops a second tab, guests included. Leaving, closing the tab or disconnecting frees the seat |
| Friend profile card + group chats | In a direct-message chat, the friend's name (no underline) opens their picture and details, with **Create a group with …**. Name the group, then **Add another friend** shows your friend list (or a "make a friend first" note if it's empty). Groups appear in the Friends panel with an unread count. In a group chat, tapping the group name shows its name, creation date, members, **Add people**, **Remove** (creator only), a rename box and **Leave group** (`server/api.js` `/api/groups*`, `public/js/topbar.js`) |
| Profile menu | Round picture button, top right (and in calls). Change display name, see account details (Gmail/email and mobile show `n/a` when empty), upload a picture up to 3 MB and crop it to the circle (`public/js/account.js`, `cropper.js`). Stored as a 256×256 JPEG in the `avatars` table; the server accepts only real PNG/JPEG/WebP bytes up to 512 KB |
| Settings page | **Settings** button at the bottom of the account info (round picture, top right) opens `/settings` (a new tab when you're in a call). Sections: Appearance, Email/phone/sign-in, Names, Security. See below |
| Group calls, pictures and reactions | **Call group** (top of any group chat): one tap creates a session, sends its link to every member as a message (shown as a **Join the group call** link) and takes you into the call. Already in a call? It sends *that* call's link and keeps you there. **Group picture**: group info > *Add a picture* uses the same cropper as profile pictures; any member can change or remove it, and the chat gets a "X changed the group picture" note (`group_avatars`, `/api/groups/:id/avatar`). **Pictures in chats**: the picture button next to the message box (friend chats and groups); text typed in the box becomes the caption. The browser shrinks it to 1280 px JPEG first; the server stores it in `chat_images`, and `/api/chat-images/:id` only serves it to people in that chat (group members must have been in the group when it was sent; blocked pairs get nothing). **Reactions**: the smiley under any message opens 👍 ❤️ 😂 😮 😢 🙏 (list in `public/js/reactions.js`); tap your chip again to take it back. Live via `reaction:update`; stored in `reactions`; people you've blocked (or who blocked you) are left out. Server rules live in `server/chat-extras.js` |
| Block and report | **Block** and **Report** sit under every profile: the profile card in a call, the card in a direct-message chat, the `/u/<handle>` page, and each member in a group's info card. Report is a three-step dialog (category, reason, details) with the presets in `public/js/report-categories.js`. Blocked people are listed under **Settings > Blocked people**. See below |
| Edit, delete, pin and search messages | Tap the **⋯** under any message in a friend chat or group chat (also in a call's chat dock). **Edit** and **Delete** are for your own messages; **Pin** is for anyone in the chat. A magnifier in the chat header searches that conversation. See *Message tools* below |
| Browser push notifications | **Settings > Notifications > Turn on notifications** (per browser). The server sends a push for a friend's or group's message, a friend request and an accepted request, through the browser's own push service, so it arrives even when no Knock tab is open or the browser is closed. The service worker (`public/sw.js`) stays quiet while a Knock tab is in front, and tapping a notification opens that chat. Spam never notifies, **Do not disturb** pauses it, and logging out (or *Sign out of other devices*) turns it off for that browser. Needs **https** (or `localhost`); where push isn't available it falls back to in-page notifications while a tab is open. Keys are made automatically and kept in the `kv` table (or set `VAPID_*` in `.env`). Code: `server/push.js`, `public/js/notify.js` |
| Status | Profile popup (round picture, top right) > **Status** drop-down: **Automatic** (default), *In a meeting*, *Do not disturb* or *Away*, plus an optional *Clear after* (30 minutes to today) for the ones you pick. **Automatic** sets *In a meeting* by itself while you are in a call (the server does it when you join/leave a room, `syncCallStatus` in `realtime.js`) and *Away* after 10 minutes with no Knock tab in front (`public/js/autostatus.js`, shared across tabs through `localStorage`); both go away again on their own. A status you pick yourself is never overwritten (automatic ones are flagged `users.status_auto`). Friends see it next to your online dot (Friends panel, chat header, profile card). Only friends see it, it clears itself when the time is up, and **Do not disturb** also stops push and pop-up notifications for you. Stored on `users.status_*`; live via the `status` event (`/api/me/status`, `/api/me/status/away`) |
| Group admins | The group info card has **Group rules** (creator only): *Only admins can change the group name* and *Only admins can add people*. The creator is always an admin and can tap **Make admin** next to a member. See *Group admins* below |
| Browser notifications | **Settings > Notifications** turns them on for this browser. See *Notifications* below |
| CAPTCHA | reCAPTCHA gate at `/verify`. Every page, API route and WebSocket needs the signed "human" cookie it sets |
| Hidden keys and endpoints | See below |

## Read receipts and typing indicators

- **Friend chats:** under the last message you sent, a small line says **Sent**, then **Seen 3:04 PM** once your friend has opened the chat (`dm:read`, using the existing `messages.read_at`).
- **Group chats:** the same line says **Sent**, **Seen by Ana**, **Seen by Ana, Ben +1** or **Seen by everyone**, based on how far each member has read (`group_members.last_read_id`, pushed live with `group:read`).
- **Typing:** "Ana is typing…" (also "Ana and Ben are typing…", "Several people are typing…") in friend chats, group chats and the in-call chat. Typing is never stored: the browser sends `typing` at most every 2.5 s while keys are pressed and `on: false` when you stop, send, close the chat or click away. Other people hide it after 5 s of silence.
- **Privacy:** Settings > *Chat privacy* has one switch (`users.chat_activity`, on by default). Off means you neither show nor see receipts and typing. Between two people it only works when both have it on, they are friends of each other and neither blocked the other, and this is enforced on the server (`shareActivity` in `server/db.js`). Someone who isn't your friend never learns whether you read their message.
- Opening a chat (or "Mark all as read") is what counts as reading. Spam-tab messages never send a receipt.

## Message tools

- **Edit** (`PATCH /api/messages/:id`, `PATCH /api/groups/:id/messages/:mid`): sender only, text and picture captions (a picture with no caption has nothing to edit). The bubble shows *Edited*. There is no time limit, and the earlier wording is not kept.
- **Delete** (`DELETE` on the same URLs): sender only, for everyone. The chat shows *This message was deleted* in its place; its reactions, pin and picture are removed and it stops counting as unread. The text itself stays in the database and is never sent to a browser again, so a report can still quote it (`npm run reports` marks such lines `[deleted by sender later]`). Deleting still works if the other person has blocked you; they are just not told.
- **Pins** (`PUT .../pin`): up to 10 per chat. In a friend chat either person can pin or unpin; in a group any member can. A bar under the chat header shows the newest pin (and `+N`); tap it for the list with **Show** and **Unpin**.
- **Search** (`GET /api/messages/with/:id/search?q=`, `GET /api/groups/:id/messages/search?q=`): at least 2 letters, newest 30 hits, deleted messages and group notes are skipped, and in a group only messages from after you joined are searched. Tapping a hit loads the stretch of conversation around it (`?around=<message id>`) and highlights it. While you are looking at older messages a **Jump to latest** bar appears and new messages wait behind it. Matching is case-insensitive for English letters only (SQLite `LIKE`).
- Live updates arrive as a `message:changed` event to both people (or the whole group); someone with a block between you is never sent one.

## Group admins

- Roles are **creator**, **admin** and **member**. The creator is always an admin and is the only person who can change roles or rules (`PUT /api/groups/:id/members/:userId/admin`, `PUT /api/groups/:id/settings`). Both leave a note in the chat.
- Two rules, both off by default (so existing groups behave exactly as before): *Only admins can change the group name* and *Only admins can add people*. When on, everyone else gets `admins_only` from the server and the info card hides the controls.
- Admins get past those two rules. Removing members is still creator-only, and anyone can still leave, chat, react, pin and change the group picture.
- If the creator leaves, an existing admin becomes the creator before anyone else does; otherwise the longest-standing member, as before.

## Notifications

- **Settings > Notifications** asks the browser for permission and turns them on **for that browser** (the choice is kept in `localStorage`, like the browser's own permission). Code: `public/js/notify.js`, `public/sw.js`, served at `/sw.js`.
- A notification appears for a new friend message or group message only when you are **not looking at a Knock tab**: the tab is in the background, minimised, or another window has focus. If another Knock tab of yours is in front, nothing pops up. Each chat's notifications replace one another, so a busy chat does not stack up. Tapping one brings the tab forward and opens that chat.
- Never notified: Spam-tab messages, your own messages, and group notes (*Sam left*). *Show the message text* can be switched off (then it just says *New message*).
- It works while Knock is open in a tab or window. It does **not** wake a closed browser; that needs real Web Push (a VAPID key pair and the `web-push` package), which is not included.
- Needs `localhost` or HTTPS, like camera and mic.

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

## Blocking and reporting

**Block** (`POST /api/blocks/:id`, `DELETE` to unblock, `GET /api/blocks`). Quiet: the other person gets no notice.
- Unfriends both sides and cancels pending friend requests either way.
- They can't message you (they get "You can't contact this person"), friend requests from them are silently dropped (like a decline), they can't find you in search or open your profile (it looks like it doesn't exist), and they can't join a call you're in (either way round).
- You can't message or friend someone you've blocked until you unblock them. **Unblocking does not bring a friendship back.**
- Their old messages are hidden from your bell but stay in the database, in case a report needs them.
- People who blocked each other can't be put in the same new group (`cannot_add_member`).

**Report** (`POST /api/reports`). Category and reason are validated against `public/js/report-categories.js`, which the server and the dialog share. To change the presets, edit that one file (never change an `id`, only labels; ids are stored in the database). "Something else" requires details. Details are capped at 500 characters, a person can send 10 reports an hour, and the same report sent twice in a day is stored once. The reported person is never told.
- Where it came from (`context`) is checked, not trusted. From a **chat**, the last 20 messages are copied into the report; from a **group**, the last 20 messages since the reporter joined; from a **call**, the session code is kept only if both people were really in that call. The dialog tells the reporter that chat and group messages are included.
- "Also block" is a checkbox on the details step, and the confirmation screen offers it again.

**Reviewing reports.** There is no admin web page (nothing extra to secure). Use the terminal:

```powershell
npm run reports                          # open reports, oldest first
npm run reports -- show 12               # one report in full, with the saved messages
npm run reports -- resolve 12 "warned"   # mark actioned
npm run reports -- dismiss 12            # mark dismissed
npm run reports -- all                   # everything
```

What this does not do yet: guests can't be reported or blocked (they have no account, so only the signed-in profile cards have these buttons); blocking someone who is already in your current call doesn't remove them (leave and rejoin, or the host can end the session); messages from a blocked person inside a group you share are still shown; and nothing is done automatically about a person who gets many reports.

## Behavior worth knowing

- **Friendships are mutual.** A friend request does nothing until the other person accepts. Only then do you appear in each other's lists, see each other's online status, and skip each other's Spam tab. If two people ask each other, they become friends straight away. **Declining is silent**: the sender isn't told (they keep seeing "Request sent") and can't ask again for 7 days. Cancelling a request or unfriending is immediate. Upgrading from an older version converts old one-way adds into pending requests (people who had added each other stay friends), so nobody's presence is exposed without a yes.
- Calls are peer-to-peer mesh, comfortable up to about 6 people (`MAX_PEOPLE` in `server/realtime.js`). A screen share is sent separately to every other person, so it uses more upload bandwidth than a camera does. Larger rooms need an SFU such as LiveKit.
- A "call" for the dashboard is a session where you were present with at least one other person.
- Run a single server process; presence and live rooms are kept in memory.
- **Groups.** Anyone in a group can rename it and add *their own* friends (up to 20 people), unless the creator limited that to admins (see *Group admins*). Anyone can leave. Only the creator can remove other people. If the creator leaves, an admin (or else the longest-standing member) becomes the creator; when the last person leaves, the group is deleted. People see only messages from after they joined, and "X added Y" / "X left" notes appear in the chat. Unread counts show on each group row and in the bell badge; your own messages and those notes never count.
- Not included yet: editing or skipping a single call of a repeating series, a live calendar subscription feed (`webcal://`), account deletion, linking Google from Settings (it links automatically the first time you use Google with the same email), email/SMS cost controls beyond rate limits.
