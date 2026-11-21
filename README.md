#AIS CII SEEMP BE

## Phase 0 hardening

The MVP stays in production while platform v2 is built. Phase 0 makes it safe
and cheaper to run without changing its API for existing clients, except where
a fix requires it. All variables are listed in `.env.example`.

### Authentication

- `POST /api/v1/auth/login` `{ "email", "password" }` returns
  `{ data: { accessToken, tokenType: "Bearer", expiresIn } }` for the single
  bootstrap admin `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` (bcrypt; generate with
  `pnpm exec bcrypt '<password>' 12`). Tokens are signed with `JWT_SECRET`
  (`src/utils/jwt.ts`). The body is checked by `loginValidation`, and attempts
  are rate limited per client IP (`LOGIN_RATE_LIMIT_*`; set `TRUST_PROXY` behind
  a reverse proxy).
- Every `POST`, `PUT`, `PATCH` and `DELETE` under `/api/v1` (41 routes) needs
  `Authorization: Bearer <token>`, otherwise `401`.
- Decision: `GET` endpoints stay public, for backwards compatibility with the
  dashboards and other existing readers. The exception is
  `GET /api/v1/cii/data/:mmsi`, which is not a read: each call recomputes the
  CII and appends it to the daily CII (and may call the weather API).
- `TRUST_FORWARD_AUTH=true` also accepts requests carrying the `X-User-Id`
  header (plus `X-Org-Id`, `X-Roles`) set by the v2 gateway `forwardAuth`.
  Only enable it when this service is reachable exclusively through the
  gateway (no published port) and the gateway overwrites these headers;
  otherwise anyone can authenticate by sending `X-User-Id`.

### Ingest socket and CORS

- The socket.io ingest server (`WEBSOCKET_SERVER_PORT`, event `ais:data`)
  requires `INGEST_SOCKET_TOKEN`, sent as `io(url, { auth: { token } })` or
  `Authorization: Bearer <token>`. Without it production refuses every
  connection; development logs a warning and accepts them. Payloads are
  validated and rate limited per connection (`INGEST_SOCKET_RATE_*`).
- Browsers may only call the API from `ALLOWED_ORIGINS` (dashboard origins and
  the gateway's public origin); other origins get `403`. Requests without an
  `Origin` header (servers, curl, health checks) are not affected.

### Behaviour changes

1. Duplicate filter: a fix that moved less than 0.1 m from the **latest**
   stored position is skipped (it compared with the oldest, ~24 h old, fix).
   `GET /ships/data/secondary/mmsi/:mmsi` likewise returns the latest position.
2. No fabricated CII: the hard-coded "Default CII values" (grade E) are gone.
   The first CII uses the current segment only; if nothing can be computed
   (no distance covered) nothing is stored. `GET /cii/daily/:mmsi`,
   `/latest`, `/attained` and `GET /seemp/:mmsi` answer
   `404 { code: "CII_NOT_AVAILABLE" }` when there is no CII (before:
   `200 { data: null }` or `500`).
3. Automatic CII updates run for the MMSIs in `CII_ENABLED_MMSIS` (empty =
   disabled, the previous behaviour).
4. First fuel formulas are evaluated by a safe arithmetic evaluator
   (`src/utils/cii/safe-formula.ts`): numbers, `speedKnot`, `+ - * / ** ^ ( )`,
   `Math.<fn>` and `exp log ln sqrt pow abs min max`. Valid formulas give the
   same results; anything else gives the 0.5 fallback. `^` now means power
   (it was JavaScript's bitwise XOR).
5. Telemetry counts as active for 1 minute after the last fuel entry
   (`FuelDataRepository.isActive` divided by 10 000, i.e. 10 seconds).
6. EWS geometry (`data/*.json`) is loaded once instead of on every message.
7. New MongoDB indexes (declared in the schemas, created at startup):
   `Ais` `{ isBatam }`, `{ positions.timestamp }`; transhipment queue and
   result; `DailyCII` `{ mmsi }`; `FuelData` `{ mmsi, createdAt }`. The result
   index `{ ship1MMSI, ship2MMSI }` became `{ ship1MMSI, ship2MMSI, detectedAt }`;
   existing databases keep the old one until it is dropped manually.

### Run and test

```bash
pnpm install && pnpm build && pnpm lint && pnpm test   # pnpm typecheck checks the tests
docker build -t seemp-legacy-be .
docker run --env-file .env -p 3020:3020 -p 3004:3004 seemp-legacy-be
```

The image runs `node dist/bin/www.js` as the `node` user on `PORT=3020` with a
health check on `GET /`.
