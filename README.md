# Knock

Knock is a video calling and messaging website I made, a bit like Zoom and Discord. You start a call, share a 10-character code, and your friend joins. Guests only need to pick a nickname, while people who sign up with their email and password get friends requests, direct and group messages, notifications, and a dashboard with scheduled calls and call recaps. 

The live site is at https://knock-0rsz.onrender.com/.

It is built with Node.js and Express on the backend, with Socket.IO for the messages and who is online, and SQLite as the database. Video and audio are handled using WebRTC., the site is protected by Helmet, rate limits and Google reCAPTCHA, and login codes are sent by email through EmailJS. The front end is HTML, CSS and JavaScript, and the site is hosted on Render.

To run it on your computer, install Node.js 22.13 or newer, open PowerShell in the `knock` folder, run `npm install` and then `npm start`, and open http://localhost:3000. You don't need any keys for testing. The "I'm not a robot" page has a dev mode button, and the codes that would be emailed show up in the PowerShell window instead. To try a call by yourself, open a second incognito window and join with the code.

Accounts are saved in `data/knock.db` if run locally, so keep a backup if you want that account saved.
