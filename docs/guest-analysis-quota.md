# Guest analysis quota

- A guest browser receives an opaque, one-year `realview_guest` cookie. Its Redis
  completed counter is limited to three and deliberately has no expiry. Clearing
  browser cookies resets the browser identity; no cookie/IP approach prevents
  deliberate identity resets entirely.
- Both `/api/analyze` and `/api/analyze-stream` reserve a slot before analysis.
  Pending slots have a 120-second lease, refreshed every 30 seconds. Expired
  slots are removed atomically on the next status or reserve check; their Redis
  key also expires. Success confirms one slot. Failed analyses refund it.
- Repeating the same direct product link within five days does not consume
  another slot. A cache hit for a *new* product does consume one slot.
- More than 20 newly seen guest devices from one IP in a 24-hour window
  requires login. The IP is HMAC-hashed before it is used in Redis. Registered
  accounts have no three-use quota.
- `GUEST_QUOTA_EXHAUSTED` and `GUEST_IP_DEVICE_LIMIT` use HTTP 429 on JSON API.
  The SSE API emits an `error` event with the same JSON payload and
  `statusCode: 429`. Successful results include `remainingGuestQuota` (`null`
  when signed in) and `guestQuotaLimit: 3`.
- Completed guest reports are retained for 30 days to support optional claim
  into a newly registered account on the same browser. Registration presents a
  checked consent box. Account history retains up to 50 reports, with ten
  fetched per page.
- Redis being unavailable fails closed for guests before Actor start; it does
  not make anonymous analysis unlimited. Login/session storage uses Redis too.
