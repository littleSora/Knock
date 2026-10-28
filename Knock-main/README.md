# Knock

Knock is a video calling and messaging website I made, a bit like Zoom and Discord. You start a call, share a 10-character code, and your friend joins. Guests only need to pick a nickname, while people who sign up with their email and password get friends requests, direct and group messages, notifications, and a dashboard with scheduled calls and call recaps. 

The live site is at https://knock-0rsz.onrender.com/.

It is built with Node.js and Express on the backend, with Socket.IO for the messages and who is online, and SQLite as the database. Video and audio are handled using WebRTC., the site is protected by Helmet, rate limits and Google reCAPTCHA, and login is handled by Supabase Auth. The front end is HTML, CSS and JavaScript, and the site is hosted on Render.

To run it on your computer, install Node.js 22.13 or newer, open PowerShell in the `knock` folder, run `npm install` and then `npm start`, and open http://localhost:3000. You need the Supabase keys below, but not the reCAPTCHA keys: the "I'm not a robot" page has a dev mode button. To try a call by yourself, open a second incognito window and join with the code.

Login, sign-up and password reset all run on Supabase Auth, so Knock never stores a password. Knock also keeps each person's profile in a Supabase table, so accounts survive a redeploy (Render's free tier resets the SQLite file on every deploy). You need a free Supabase project to run Knock, even on your own computer. To set it up:

1. Create a project at https://supabase.com.
2. In the dashboard open SQL Editor, paste the contents of `knock/supabase/schema.sql` and run it.
3. Follow `knock/supabase/email-templates.md`: set up email sending (SMTP) and paste the 6-digit-code email templates. Without this, no one can confirm an account or reset a password.
4. Go to Project Settings -> API and copy the Project URL and the `service_role` key.
5. Set `SUPABASE_URL` (just the `https://xxxx.supabase.co` address) and `SUPABASE_SERVICE_ROLE_KEY` as environment variables on Render (Environment tab), or put them in `knock/.env` for local use (see `.env.example`). Never put the service_role key in front-end code or commit it to GitHub.

When the server starts it copies any profile that is missing from SQLite back from Supabase. Chats, friends, calls and profile pictures still live in SQLite only. Accounts made before this change have no Supabase login yet: they use "Forgot password?" once to choose a password.
