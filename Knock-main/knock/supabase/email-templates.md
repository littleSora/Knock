# Supabase email setup for Knock

Knock asks Supabase to email a **6-digit code** (not a link). Do these in the Supabase dashboard.

## 1. Turn on sending real emails (important)

Supabase's built-in email sender only delivers to people on your Supabase team and allows just a few emails per hour, so it is
only good for trying things out. For real users, set your own SMTP:

**Authentication -> Emails -> SMTP Settings -> Enable custom SMTP.** Brevo (free) works: host `smtp-relay.brevo.com`, port `587`,
and the SMTP login and key from Brevo's "SMTP & API" page. Sender email must be one you verified with the provider.

## 2. Paste the code into each email template

**Authentication -> Emails -> Templates.** In each template below, the important part is `{{ .Token }}`: that is the 6-digit code.
You can change the other words.

**Confirm signup** (subject: `Your Knock verification code`)

```html
<h2>Welcome to Knock</h2>
<p>Your verification code is:</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:bold">{{ .Token }}</p>
<p>If you didn't ask for it, ignore this email.</p>
```

**Reset password** (subject: `Reset your Knock password`)

```html
<h2>Reset your Knock password</h2>
<p>Your reset code is:</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:bold">{{ .Token }}</p>
<p>If you didn't ask to reset your password, ignore this email and your password stays the same.</p>
```

**Change email address** (subject: `Confirm your new Knock email`)

```html
<h2>Confirm your new email</h2>
<p>Your confirmation code is:</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:bold">{{ .Token }}</p>
```

## 3. Other settings

- **Authentication -> Providers -> Email:** keep Email enabled. Keep **Confirm email** on if you want people to prove their email
  with a code. If you turn it off, accounts are created straight away with no code (and anyone can sign up with any address).
- **Turn OFF "Secure email change"** (same page). With it on, changing an email needs a second code from the old address, which
  Knock's change-email screen does not ask for.
