# SENE Licensing API (Cloudflare Workers + D1)

Backend scaffold for SENE PATRÓN / SENE VENTAS. Target: Workers Free + D1 Free; no Firebase Blaze and no payment method should be enabled for this project.

## Current implemented slice

- `GET /health`: health check.
- `POST /admin/licenses`: protected by `Authorization: Bearer <ADMIN_TOKEN>`; creates one pending package with exactly 3 device slots and returns a one-time activation code. Only the SHA-256 hash is stored.
- Database schema for licenses, devices, one-time QR pairing tokens, proof-of-possession challenges, correction requests and one-use grants.

## Not implemented yet (do not connect production APKs to this scaffold)

- Patron activation-code redemption and device proof-of-possession.
- QR token issuance and atomic two-device claim.
- 30-day activation/expiry enforcement and signed offline lease.
- Correction request, owner approval/rejection and atomic one-use grant consumption.
- Replacement of a lost device.
- Admin dashboard / protected operator workflow.

The mobile apps must fail closed for remote authorization decisions while preserving all local sales, inventory and cash data. Never let a client app write license counters or approve its own correction grant.

## Setup (after reviewing and completing the API)

1. Create a Cloudflare account on the Free plan. Do not upgrade to Workers Paid.
2. Create a D1 database named `sene-licensing`.
3. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.toml`.
4. Apply the migration: `npx wrangler d1 migrations apply sene-licensing --remote`.
5. Set the secret: `npx wrangler secret put ADMIN_TOKEN`.
6. Deploy: `npx wrangler deploy`.
7. Verify `GET /health`.

Do not deploy or distribute APKs as production-ready until all endpoints above are implemented, security-reviewed and tested.

## Free-tier planning limits

- Workers: 100,000 requests/day.
- D1 Free: 5 million rows read/day, 100,000 rows written/day, 5 GB total account storage; per-database size limit is 500 MB.
- Daily quotas reset at 00:00 UTC. Storage is cumulative and does not reset.
- D1 quota exhaustion causes queries to fail; handle that as unavailable, not as permission granted.

See official Cloudflare docs:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/reference/faq/
- https://developers.cloudflare.com/d1/platform/limits/
