# Google login — live verification

Date: 2026-10-01 (Asia/Ho_Chi_Minh).

## Services and scope

- Actual Google OAuth Web client registered for RealView; official GIS button.
- Actual Google-issued credential received after the user's interactive sign-in.
- Production verification code and `google-auth-library`, with Google's live
  certificates; no replacement certificate provider in this run.
- Actual Redis REST service configured for the linked Vercel project. The two
  selected Redis configuration values were kept in process memory, not exported
  to a file. No unrelated SMTP/Apify/LLM secrets were retrieved.
- Local-only test server on the already authorized `http://localhost:3137` origin.
- All Redis data isolated under random `realview:e2e:<UUID>:*` namespaces. No
  production accounts or history keys changed. No production deployment made.

## Interactive Google + Redis flow — passed

1. Backend issued a browser-bound challenge and saved it in actual Redis.
2. Google sign-in returned a real ID token; the backend verified it with the
   official library and created a Google-only account in the test namespace.
3. Browser received an HttpOnly/SameSite session cookie.
4. The browser's subsequent session request loaded the account from actual Redis
   and reported `authenticated: true`.
5. Resubmitting the same credential/challenge returned HTTP 401,
   `INVALID_GOOGLE_REQUEST`; the page reported `replayRejected: true`.
6. Logout deleted the Redis session and cleared the session cookie. A subsequent
   browser session request reported `authenticated: false`.

## Actual Redis store integration — 20 checks passed

PING; challenge persistence; challenge TTL; browser binding; atomic concurrent
challenge consumption; concurrent account creation without duplicate IDs;
no implicit marketing opt-in; session lookup; logout invalidation; explicit
legacy-link requirement; wrong-password rejection; linking preserves account
ID/password provider; linking preserves history; pending proof consumption;
third-party mailbox proof requirement; wrong OTP rejection; Redis KEEPTTL for
OTP; atomic account creation after OTP; OTP replay rejection; consent updates
preserve Google linkage.

These store-level cases use disposable synthetic identities, not Google-issued
credentials. Their Redis operations and Lua scripts are real, not mocks.

## Actual HTTP + live Google certificates — 10 checks passed

Public-only configuration response; cross-origin rejection; missing-Origin
rejection; unsupported method rejection; malformed JSON rejection; browser-cookie
attributes; missing-browser-cookie rejection; forged signature rejected against
actual Google certificates; errors do not disclose credentials/claims; invalid
tokens do not consume a valid challenge.

## Remaining boundary

The second interactive sign-in with the same Google account is awaiting the
user's account-selection step. It is not yet counted as passed. The local
harness is kept running for that step. Its current isolated namespace is
`realview:e2e:1b0dde81-a6bd-4532-802c-83ee14ffd97c:*`; created test keys are given
a 30-minute expiration. The earlier setup namespace and the separate 20-check
store-suite namespace were cleaned up and confirmed empty. Stop the harness
with SIGINT/SIGTERM after completion to remove the remaining test keys.

Welcome email and guest-history migration were deliberately disabled in the
local harness to avoid external mail and production guest-data side effects.
Store-level OTP checks did not test real mailbox delivery. This report does not
claim end-to-end verification of those separate flows or of Vercel deployment.

## Previously skipped test

`test/contact-acknowledgement-email.test.mjs` intentionally skips an obsolete
email-layout snapshot. Its replacement test for the current email design passes.
It is unrelated to Google login. A targeted regression run across Google auth,
account storage and contact email had 45 tests: 44 passed, 0 failed, 1 intentional
obsolete-layout skip. The 34 Google-auth tests themselves have no skips.

Reproduction: see `docs/google-login-backend.md` and the local-only scripts in
`tools/google-login-e2e.mjs` and `tools/google-login-http-test.mjs`.
