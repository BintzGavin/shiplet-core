# Shiplet Core agent instructions

Shiplet Core is a Cloudflare-native artifact review platform.

- Keep the supported default static-first.
- Treat artifact-owned Worker code as an advanced path with a higher security
  burden.
- Add or update behavior-focused tests before changing behavior.
- Run `npm run verify` before proposing a release.
- Keep credentials, live resource identifiers, production routes, deployment
  records, and generated deployment state out of the repository.
- The checked-in Wrangler files are public-safe examples. Production deployment
  requires an explicit user-owned configuration.
