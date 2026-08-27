# Google Calendar setup (manual, one time)

This gets Héctor three values for `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. All three are secrets — **paste them only into your local `.env` file, never into a chat, ticket, or screenshot.** `.env` is already in `.gitignore`, so it never gets committed.

Do this while signed in to the Google account whose calendar will hold the advisor's real availability and appointments (Héctor's own Google account, or a dedicated one used only for Baluarte Capital appointments).

## 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/).
2. Top bar → project selector → **New Project**.
3. Name it something like `baluarte-lead-engine`. Create it.
4. Make sure the new project is selected in the top bar before continuing.

## 2. Enable the Google Calendar API

1. In the left menu: **APIs & Services → Library**.
2. Search for **Google Calendar API**.
3. Open it, click **Enable**.

## 3. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type: **External** (unless Baluarte Capital is on Google Workspace, in which case **Internal** also works and is simpler).
3. Fill in the required fields (app name, your email as support/contact email). Save through the steps.
4. On the **Scopes** step, add `https://www.googleapis.com/auth/calendar` (full calendar access — needed to read free/busy and create events with Google Meet).
5. On the **Test users** step, add the Google account you're authorizing (your own email) as a test user.
6. **Important:** once everything works, go back to the consent screen summary and click **Publish App** to move it from *Testing* to *Production*. Google will show an "unverified app" warning for anyone who authorizes it — that's expected and fine for a single-user internal tool. This step matters because refresh tokens issued while the app is still in *Testing* status expire after 7 days; a *Production* (even if unverified) app issues long-lived refresh tokens.

## 4. Create OAuth 2.0 credentials

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Name it anything.
4. Under **Authorized redirect URIs**, add:
   ```
   https://developers.google.com/oauthplayground
   ```
5. Create. Copy the **Client ID** and **Client Secret** shown — these become `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Save them straight into your local `.env`, not anywhere else.

## 5. Generate the refresh token (OAuth Playground)

1. Go to [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground).
2. Click the gear icon (top right) → check **Use your own OAuth credentials** → paste in the Client ID and Client Secret from step 4. This stays local to your browser session; it isn't sent to us.
3. In the left panel, find **Calendar API v3** and select the scope `https://www.googleapis.com/auth/calendar`.
4. Click **Authorize APIs**. Sign in with the same Google account you set up as a test user in step 3, and accept the "unverified app" warning (Advanced → Go to `baluarte-lead-engine` (unsafe)) — this is your own app.
5. You'll land back on the Playground with an authorization code already exchanged. Click **Exchange authorization code for tokens**.
6. Copy the **Refresh token** value shown — this becomes `GOOGLE_REFRESH_TOKEN`. Save it into `.env`.

## 6. Set the calendar ID

- `GOOGLE_CALENDAR_ID=primary` uses the main calendar of the account you authorized in step 5 — this is almost certainly what you want, and it's already the default in `.env.example`.
- If appointments should go on a *different* calendar (e.g., a shared "Citas Baluarte" calendar), open that calendar's settings in Google Calendar → **Integrate calendar** → copy the **Calendar ID** shown there, and use that value instead.

## 7. Fill in `.env` and restart

```
GOOGLE_CLIENT_ID=<from step 4>
GOOGLE_CLIENT_SECRET=<from step 4>
GOOGLE_REFRESH_TOKEN=<from step 5>
GOOGLE_CALENDAR_ID=primary
```

All three of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` must be set together — the server checks for all three before switching from `FakeCalendarProvider` to the real `GoogleCalendarProvider` (confirmed by `GET /health`, which reports `"calendarProvider": "google"` once it's active). Restart `npm run dev` after editing `.env`.

## First real booking test

Once `.env` is filled in and the server reports `"calendarProvider": "google"` on `/health`, the first live test is:

```bash
curl -s "http://localhost:3000/api/availability?from=2026-03-02T00:00:00Z&to=2026-03-09T00:00:00Z&duration=30"
```

That should return up to 3 real free slots from Héctor's actual Google Calendar (respecting `WORKDAY_START`/`WORKDAY_END`/`BOOKING_MIN_NOTICE_HOURS`). Booking one of those slots for real (creates an actual calendar event + Meet link) is a separate, deliberate step — see the final report for the exact command, and only run it when ready to see a real event appear on the calendar.
