# Production packaging

The first Google-login deployment built successfully but was rejected at the
deployment step: `exceeded_serverless_functions_per_deployment`. Vercel Hobby
allows 12 functions per deployment, and a separate Google endpoint made 13.

The public URL remains `/api/auth-google`. Vercel rewrites it to
`/api/auth.mjs?authProvider=google`, which loads `src/google-auth-route.mjs`.
The ordinary account endpoint and the Google handler retain separate request
validation, origin checks, rate limits, nonce verification and session handling.
No scopes, account permissions or storage namespaces are expanded by this change.

Only `api/auth.mjs` is deployed for both paths, with a 30-second timeout. Other
functions are unchanged; the project remains on the existing Hobby plan.
The Google SDK is still loaded only when the login dialog opens.

`test/google-deployment.test.mjs` verifies the function count, rewrite, actual
handler dispatch, ordinary account session lookup and cross-origin rejection.
