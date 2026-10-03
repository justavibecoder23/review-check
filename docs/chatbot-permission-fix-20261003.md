# Chatbot permission routing fix

## Scope and evidence

The production smoke test on commit `6155149` returned two Google HTTP 403 responses. Its old logs did not identify the credential, so those requests cannot be attributed to a particular key retroactively. A separate, limited local `generateContent` check found one existing chatbot credential returning `PERMISSION_DENIED` with “Your project has been denied access” and another returning HTTP 200. The model metadata GET returned 200 for both; it is not a generation health check.

This patch changes chatbot routing only. It does not create Google projects/keys, modify provider permissions, borrow review-analysis credentials, change blogs or alter production environment variables.

## Behavior

* Existing chatbot health records with last status 401/403 are ineligible, even after their old cooldown ends.
* New 401/403 results persist `permissionDisabled`, a fixed-vocabulary reason and timestamp in the existing chatbot Redis health namespace. Lua checks eligibility atomically before reserving a provider call. Midnight quota reset and late successful telemetry do not clear the flag.
* A new permission denial stops that request without retrying another credential. On subsequent requests an already-disabled primary is skipped before any Google call; the existing eligible chatbot backup pool can be selected. This is not permission recovery for the denied project.
* The primary key is excluded from the backup list by key equality, regardless of its stored ID. A transient primary error cannot call the same key twice through two routes.
* HTTP 429 still stops retry; the current time budget and maximum of two provider attempts are unchanged. FAQ and private-context/idempotency behavior remain unchanged.
* Shared health/router changes are opt-in. The review pipeline uses its existing namespace and default behavior.

Quarantine is credential/model scoped. There is no verified Google project-ID mapping in the current pool, so this patch does not claim project-wide quarantine across multiple keys. Do not add replacement keys to evade a project denial; restore access with Google support. A missing/failed Redis write cannot guarantee persistent quarantine: the request still stops and telemetry records `persisted:false` for investigation.

## Safe telemetry

Server-only provider events contain `source` (`dedicated` or `chatbot_pool`), a SHA-256 key fingerprint truncated to 16 hexadecimal characters, HTTP status/duration and a fixed reason such as `project_denied`. They never contain keys, raw provider error text, prompts, review content or account IDs. Permission persistence is recorded separately as `permission_quarantine` with a boolean `persisted`. Public responses do not expose fingerprints or provider text.

## Explicit recovery

After Google access is genuinely restored, verify a small authenticated **generateContent POST**, not a model metadata GET. The existing authenticated admin endpoint supports:

```json
{
  "action": "restore-permission",
  "credentialId": "<ID from authenticated admin status>",
  "model": "gemini-3.5-flash-lite",
  "confirmedProviderAccess": true
}
```

Send this body to `PUT /api/chatbot-gemini-config` using the existing admin authentication. The function requires a currently configured permission-disabled route. Atomic Lua refuses recovery while its stored in-flight counter is nonzero; investigate a stranded reservation rather than deleting health/usage records. Recovery clears permission fields and a legacy 401/403 status, but preserves quota counters, cooldown and usage history. Importing/appending pool keys does not unblock a route.

## Verification and release status

Regression tests execute the actual Lua with an in-memory Redis adapter, covering persistent quarantine across midnight/cooldown/late success, legacy 403 selection, no immediate permission retry, duplicate primary exclusion, all sources disabled, secret redaction, failed persistence, admin authentication/recovery and quota preservation. Existing tests cover 429, retry budgets, concurrent idempotency, private result authorization and generic analysis routing.

Final local results: 76/76 focused tests passed. Full `test/*.test.mjs` suite: 874 tests, 870 passed, 3 pre-existing blog failures, 1 skipped. The three failing test names match the baseline: blog hub nine-article expectation, streamlined blog library layout and dynamic sitemap precedence. `git diff --check` passed; no blog, media or deployment configuration files were modified.

This is a local implementation. No production push/deployment is included in this patch; production recovery must be verified after an explicitly authorized release.
