# Google login — backend contract

Backend and the approved account-dialog frontend are now connected. See
`google-login-implementation.md` for password recovery, migration and QA details.
No production environment changes or deployment were performed in this step.

## Configuration

- `GOOGLE_CLIENT_ID`: the public Web OAuth client ID. Example value is in
  `.env.example`. Never supply a Client Secret for this ID-token callback flow.
- `GOOGLE_LOGIN_ENABLED=false`: disables every POST action. Missing/invalid client
  ID also disables the feature. Existing password login remains independent.
- `GOOGLE_AUTH_ALLOWED_ORIGINS`: optional comma-separated exact origins for a
  controlled preview host. Root/www production origins are included by default.
  Non-Vercel local development additionally accepts `http://localhost:<port>`.
- The current Redis and transactional-email settings remain required. No Google
  access tokens, refresh tokens, or ID tokens are persisted.

Google Console must authorize the same origins as the browser actually uses.
No authorized redirect URI is needed for the planned JavaScript callback flow.
Review published Privacy Policy/branding and verify the domain before launch.
Environment changes on Vercel require a new deployment; none were made here.

## Live integration test harness (local only)

`tools/google-login-e2e.mjs` serves a temporary test page outside `public/`.
It verifies real Google credentials with the production verification library and
executes the production storage functions/Lua against a real Redis REST service.
Every account/challenge/session/history key is translated to a unique
`realview:e2e:<UUID>:*` namespace by a trusted test-only transport. Test keys get
an expiration and are removed on orderly shutdown; production keys are untouched.
Credential values are never printed, passed to the browser, or written to disk.

Provide the Redis URL/token to the process using the usual local environment,
then start on an origin already authorized in Google Console:

```sh
GOOGLE_E2E_PORT=3137 node tools/google-login-e2e.mjs
```

For this linked RealView project only, `--vercel-redis` reads the two selected
Redis environment variable IDs into memory through Vercel CLI. It does **not**
pull the entire production environment. Do not reuse those project/variable IDs
for another project. `--redis-only` runs store-level integration checks and
cleans up immediately, without opening a browser.

Open `http://localhost:3137` and sign in using Google's official button. The
page verifies the session and attempts replay of the same credential/challenge.
Log out and sign in again with the same Google account to verify account reuse.
Do not commit real Google ID tokens or Redis credentials into test fixtures.

While that server is running, execute negative HTTP/signature checks:

```sh
node tools/google-login-http-test.mjs
```

The harness deliberately suppresses welcome email and guest-history migration.
Store-level OTP tests do not send real email. Those are separate flows and must
not be described as verified by the live Gmail sign-in test.

## API: `/api/auth-google`

All responses use `Cache-Control: no-store`. POST requests must use same-origin
JSON and include browser cookies (`credentials: 'same-origin'`). Cross-origin,
missing-Origin and mismatched-scheme requests are rejected. This endpoint does
not implement Google's form-post/redirect mode or its `g_csrf_token` contract.
Instead it implements a browser-bound, one-time challenge for the JS callback.

### 1. Discover config only when opening the sign-in dialog

`GET` returns `{ enabled, clientId }`. This never starts a session or creates a
challenge. Do not call it on homepage startup. Client ID is public information.

### 2. Begin login

```json
{ "action": "begin" }
```

Returns `{ clientId, challengeId, nonce, expiresIn: 600 }` and sets
`realview_google_browser` (HttpOnly, SameSite=Lax, Secure on HTTPS, 10-minute TTL).
Existing RealView sessions are not cleared by this step. Reuses an existing
browser binding to permit multiple challenges without sharing a nonce.

Pass `nonce` and `clientId` to `google.accounts.id.initialize`, use the official
Google-rendered button, and keep `challengeId` only in the current dialog's
memory. Initialize GIS once. Refresh the challenge if it expires. Initial UI
should not enable One Tap/automatic sign-in. Load GIS from Google's hosted URL
only after the dialog opens; reserve button height to avoid layout shifts.

### 3. Submit credential from GIS JavaScript callback

```json
{
  "action": "authenticate",
  "challengeId": "value_from_begin",
  "credential": "GIS_response.credential",
  "claimGuestHistory": false
}
```

Server checks RSA signature with `google-auth-library`, `aud`, `iss`, `exp`,
`iat`, subject/email validity, `email_verified` and the exact nonce. Google's
certificate request has a five-second timeout. Library errors are not exposed.
Challenge is atomically consumed before account resolution.

Possible responses:

| Status | Meaning / frontend next step |
|---|---|
| `signed_in` | Session cookie set; close dialog and update existing auth/history UI. |
| `link_required` | Same email already has a password account; show confirmation form. |
| `email_required` | New third-party email; ask permission to send a mailbox verification code. |

Pending responses contain only `{ status, pendingId, expiresIn }`, not a password
hash, Google subject, OTP, or session. The random pending ID is browser-bound and
expires after ten minutes. Do not store it in localStorage or include it in URLs.

### 4a. Confirm a legacy password account

```json
{
  "action": "link_account",
  "pendingId": "value_from_authenticate",
  "password": "existing_RealView_password"
}
```

Maximum five password attempts per pending flow. The server-selected account ID
and email cannot be replaced by request fields. A correct password proves access;
the final atomic link also checks that its hash did not change meanwhile.
Preserves the same internal ID, username, history, marketing consent and roles.
No automatic merge based solely on matching email. A subject/email already bound
to another Google account is rejected. Explicit linking to an account with a
different RealView email, unlinking Google, and adding a password are not exposed
in this phase.

### 4b. Verify a new third-party email

```json
{ "action": "request_email_verification", "pendingId": "value_from_authenticate" }
```

Sends a six-digit code through the existing email provider, never returns the code
to the browser. Returns `{ status: "email_code_sent", expiresIn }`.
Then submit:

```json
{
  "action": "verify_email",
  "pendingId": "value_from_authenticate",
  "code": "123456",
  "claimGuestHistory": false
}
```

Five attempts per code. Resending is separately limited to five requests/IP per
15 minutes. Sending a new code invalidates the previous one. Verification and
final account creation preserve the original pending expiry, not a sliding TTL.
Gmail and verified Google Workspace identities skip this extra mailbox proof;
existing linked identities continue to use Google `sub`, not mutable email.

### Successful response

```json
{
  "status": "signed_in",
  "user": {
    "id": "same_RealView_id",
    "username": "rv_generated_or_existing_username",
    "email": "stored_RealView_email",
    "displayName": "name_or_existing_username",
    "authProviders": ["google"],
    "hasPassword": false,
    "createdAt": "ISO_timestamp",
    "emailMarketingConsent": { "status": "not_subscribed", "source": "google_signup", "consentedAt": null }
  },
  "created": true,
  "claimedGuestHistory": 0,
  "showOfflineConsentNotice": false
}
```

HTTP 201 for creation, 200 otherwise. Session uses the existing
`realview_session` cookie, and a presented previous session is invalidated.
New accounts have a unique generated username and `passwordHash: null`.
Frontend should prefer `displayName` when displaying a Google account.
No marketing consent is assumed. Guest history is transferred only when the
request explicitly has `claimGuestHistory: true`; apply it on the completing
request if linking or email verification is required.

Existing `/api/auth` GET/logout, history APIs and blog authorization continue to
work with the same account/session. Forgot-password does not create a password
for Google-only accounts, including old outstanding reset records. A future
password-addition feature must require explicit reauthentication.

## Storage / concurrency

- `realview:google-auth:v1`: hashed challenge/pending IDs, hashed browser binding,
  short-lived verified identity metadata, OTP salt/hash, attempts/rate limits.
- `realview:account:v1:google:<SHA256(sub)>`: maps Google identity to existing user ID.
- Existing account records acquire `googleSubject` and `googleLinkedAt` only
  after verified creation/linking. The public user payload omits the subject/hash.
- Atomic Redis Lua scripts create/link accounts, update indexes and consume proof
  together. Simultaneous first sign-ins for a subject create one account. If a
  competing legacy registration owns the email, Google login fails closed and
  asks the user to restart/confirm instead of merging.
- Consent/password-reset writes update only their own fields atomically, so they
  cannot overwrite a newly added Google link. Legacy consent fallback is derived
  on read without rewriting stale account JSON.
- Changed Google email is not automatically copied to the RealView account; this
  also prevents implicit changes to email-based administrative permissions.

## Errors and UI handling

- `GOOGLE_LOGIN_DISABLED`: hide Google option; retain password form.
- `INVALID_GOOGLE_TOKEN`, `INVALID_GOOGLE_REQUEST`, `GOOGLE_REQUEST_USED`: clear
  dialog credentials/pending state and begin a fresh Google login.
- `INVALID_CREDENTIALS`: allow password retry within the pending attempt limit.
- `INVALID_EMAIL_CODE`: show inline code error.
- `RATE_LIMITED`: wait or restart after cooldown; do not auto-retry rapidly.
- `GOOGLE_REQUEST_CHANGED`, `GOOGLE_ACCOUNT_CONFLICT`, `ACCOUNT_BUSY`: no silent
  merge/retry; prompt to restart or use existing password account.
- `EMAIL_DELIVERY_FAILED`, `GOOGLE_AUTH_UNAVAILABLE`: clear wait state, explain
  temporary failure; password login remains available.

## Verification and release gate

Run `node --test test/google-auth.test.mjs test/account-store.test.mjs` and the
full suite. Tests verify real RSA signatures with the official library and an
offline test certificate provider; actual production Lua executes in Fengari
with an in-memory Redis-command adapter (development dependency only).

Still required before production activation: approved frontend, real Google
account login on authorized origins, real Redis/transactional-mail integration,
Chrome/Safari/mobile testing, canceled popup/error states, logout/legacy linking,
and mobile/desktop PageSpeed regression checks. No claim of live Google sign-in
or real Redis integration is made from isolated unit tests alone.

Official references:
- https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
- https://developers.google.com/identity/gsi/web/reference/js-reference
- https://developers.google.com/identity/gsi/web/guides/display-button
