# Knock

Knock is a video calling and messaging website that I built. It is a bit like Zoom and Discord mixed together. You start a call, share a code, and the other person joins. Guests don't even need an account.

Live site: https://knock-0rsz.onrender.com/

## What it can do

- Start a call and get a 10-character code. Anyone with the code can join.
- Guests have to pick a nickname first. If you are logged in, you join with your display name.
- Create an account with your email and a password. We email a code to check the email is real.
- Dashboard with your calls from yesterday, your scheduled calls, and recaps of past calls.
- Schedule calls (they can repeat) and add them to your calendar as a `.ics` file.
- Recaps: during a call you can write down what was decided and who has to do what after.
- Friends: send a friend request, the other person accepts or declines. Online friends show a green dot and offline ones show a gray dot.
- Messages: chat with friends, make group chats, send pictures, react with emojis, edit, delete and pin messages.
- Notification bell with an Inbox, plus a Spam tab for messages from people who aren't your friends.
- In a call you can mute, turn the camera off, share your screen and use the call chat.
- Block and report people, and change your theme and profile in Settings.

## What I used

- Node.js and Express for the server
- Socket.IO for the live parts (messages, who is online)
- WebRTC for the video, which goes straight between the browsers
- SQLite for the database (it comes built into Node, so nothing to install)
- Plain HTML, CSS and JavaScript on the front end, no framework

## How to run it (Windows)

1. Install Node.js version 22.13 or newer. You can check with `node -v`.
2. Open PowerShell inside the `knock` folder.
3. Run these:

```powershell
npm install
npm start
```

4. Open http://localhost:3000 in your browser.

To test a call by yourself, open a second window in incognito and join with the code.

While you are testing on your own computer you don't need any keys:

- The "I'm not a robot" page shows a **Continue (dev mode)** button.
- The email codes get printed in the PowerShell window instead of being emailed.

Camera and mic only work on `localhost` or on a site with HTTPS.

## Putting it online (how mine is set up)

My site is hosted on [Render](https://render.com) and uses [EmailJS](https://www.emailjs.com) to send the login codes. On Render I add these under **Environment**:

```
NODE_ENV=production
COOKIE_SECRET=some-long-random-text-at-least-32-characters
TRUST_PROXY=1
RECAPTCHA_SITE_KEY=your-site-key
RECAPTCHA_SECRET=your-secret-key
EMAILJS_SERVICE_ID=your-service-id
EMAILJS_TEMPLATE_ID=your-template-id
EMAILJS_PUBLIC_KEY=your-public-key
EMAILJS_PRIVATE_KEY=your-private-key
```

- **COOKIE_SECRET**: make one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- **RECAPTCHA keys**: get them at google.com/recaptcha/admin and pick "reCAPTCHA v2 (I'm not a robot)". Add your Render address as a domain there.
- **EmailJS**: connect your Gmail as a service, then make a template. The template should send to `{{to_email}}` and show `{{code}}` (or `{{message}}`). The private key is the one under Account > API keys. If EmailJS blocks the request, turn on "Allow EmailJS API for non-browser applications" in Account > Security.
- **TRUST_PROXY=1** is needed on Render so the rate limits see the real visitor.
- Using something else to send email? `SMTP_URL` + `MAIL_FROM` or `BREVO_API_KEY` also work.
- Optional: `TURN_URL` and `TURN_SECRET` help people on strict networks join calls. `VAPID_*` keys turn on push notifications.

When `NODE_ENV=production`, the server won't start unless COOKIE_SECRET and the reCAPTCHA keys are set. This is on purpose.

**Important:** accounts live in the file `data/knock.db`. On Render's free plan the disk is wiped every time the site redeploys or restarts, which deletes all accounts. To keep them, add a Render **Disk** and set `DB_PATH` to a file on it (for example `DB_PATH=/var/data/knock.db`). Free sites also fall asleep when nobody visits, so the first load can be slow.

## Folders

```
server/   the backend. index.js starts it, auth.js is login, api.js has the routes,
          realtime.js runs the calls and live stuff, db.js is the database
public/   the JavaScript and CSS the browser loads
views/    the HTML pages
```

The database file is made by itself at `data/knock.db` the first time you run it.

## Security

- Secret keys stay in `.env` and only the server uses them. The browser only talks to the site's own `/api`.
- Passwords are saved as hashes, never as normal text.
- Too many wrong passwords locks that email for 15 minutes.
- The reCAPTCHA check and rate limits help against bots.
- Names and messages are shown as plain text so nobody can sneak in HTML.

## Things to know

- Calls work best with up to about 6 people, because everyone connects to everyone. For bigger calls it would need a media server like LiveKit.
- Run only one copy of the server, because who is online and the live calls are kept in its memory.
- Back up `knock.db` once in a while, since that one file has all the accounts and messages.
- Accounts made before passwords existed have no password yet. They can use **Forgot password?** on the login page.
- Not done yet: deleting your account, and editing just one call in a repeating series.
- I only tested it on a couple of browsers, so some things might still be buggy.
