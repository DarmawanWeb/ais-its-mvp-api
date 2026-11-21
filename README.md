# ais-its-mvp-api

MVP API (`/api/v1`, Express + MongoDB) of AIS Maritime Intelligence, formerly
`ais-its-cii-seemp-be`. It stays in production until the cut-over to v2.

## Phase 0 hardening

The MVP stays in production while platform v2 is built. Phase 0 makes it safe
and cheaper to run without changing its API for existing clients, except where
a fix requires it. All variables are listed in `.env.example`.

### Deploying phase 0

Merging to `main` deploys automatically: `ci.yml` → `deploy.yml` → PM2 with
`NODE_ENV=production` and the existing `.env` of the server. Phase 0 makes
several variables mandatory, so before merging:

1. Set in the server's `.env`:
   - `JWT_SECRET`: a new random value of at least 32 characters
     (`openssl rand -hex 32`); rotate it, do not keep the old one. Placeholders
     such as `your_jwt_secret` and, in production, shorter values count as not
     set: login is disabled and every Bearer token is refused.
   - `JWT_EXPIRATION`: a timespan (`1h`, `30m`) or a number of seconds.
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`: the login of the bootstrap admin.
   - `INGEST_SOCKET_TOKEN`: configure it on every `ais:data` pusher first.
   - `TELEMETRY_API_KEYS`: one key per fuel meter, configured on the meters
     first (see Authentication).
   - `ALLOWED_ORIGINS`: the origins of the dashboards (see CORS).
   - `TRUST_PROXY=1` when one reverse proxy runs in front (not `true`).
2. Check it on the server: `pnpm build && NODE_ENV=production pnpm check:env`
   prints the problems and exits with 1 when login, writes or the ingest
   socket would be disabled. `deploy.yml` runs the same check before
   restarting PM2 and stops the deploy when it fails (the running version
   keeps serving).
3. Run `pnpm check:formulas` against the production database: it lists the
   stored first fuel formulas whose results change (behaviour change 4) and
   the ships that use them.

### Authentication

- `POST /api/v1/auth/login` `{ "email", "password" }` returns
  `{ data: { accessToken, tokenType: "Bearer", expiresIn } }` for the single
  bootstrap admin `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` (bcrypt; generate with
  `pnpm exec bcrypt '<password>' 12`). Tokens are signed with `JWT_SECRET`
  (`src/utils/jwt.ts`) and expire after `JWT_EXPIRATION`. The body is checked
  by `loginValidation` (strings only, otherwise `400`), and attempts are rate
  limited per client IP (`LOGIN_RATE_LIMIT_*`; set `TRUST_PROXY` behind a
  reverse proxy). At most two password checks (bcrypt, ~0.3 s of CPU each at
  cost 12) run at once; further attempts answer `503`. Without a usable
  `JWT_SECRET`, a valid `JWT_EXPIRATION` or the admin credentials, login
  answers `503` as well.
- Every `POST`, `PUT`, `PATCH` and `DELETE` under `/api/v1` (41 routes) needs
  `Authorization: Bearer <token>`, otherwise `401`.
- Fuel meters, which cannot log in every hour, send `X-API-Key: <key>` with a
  key from `TELEMETRY_API_KEYS` (comma separated, at least 32 characters in
  production) on `POST /api/v1/ships/fuel-data` and
  `POST /api/v1/telemetry/:mmsi/fuel`. Keys work on these two routes only and
  do not expire: remove a key from the list to revoke it.
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
  `Authorization: Bearer <token>`; the `Origin` header of pushers is ignored
  (Python's websocket-client sends one). Without a token production refuses
  every connection; development logs a warning, accepts them and only refuses
  browsers on other sites. Payloads are validated and rate limited per
  connection (`INGEST_SOCKET_RATE_*`).
- CORS: every origin may read (`GET`, `HEAD`) without credentials, as before
  phase 0. Logging in, writes (and their preflights) and
  `GET /api/v1/cii/data/:mmsi` from a browser need an origin listed in
  `ALLOWED_ORIGINS`, other origins get `403`; listed origins may send
  credentials. Requests without an `Origin` header (servers, devices, curl,
  health checks) are not affected. List origins as the browser shows them
  (`https://dashboard.example.com`, `http://localhost:5173`); case, a trailing
  slash and default ports are ignored, `*` allows every origin (never with
  credentials). Unset, it allows the local dev servers
  (`http://localhost:5173`, `http://localhost:3000`). The allowlist is logged
  at startup, with a warning in production when it lists only localhost.

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
   (`src/utils/cii/safe-formula.ts`) instead of running them as JavaScript:
   numbers, `speedKnot`, `+ - * / ** ^ ( )`, `Math.<fn>` and
   `exp log ln sqrt pow abs min max` (the grammar of the v2 spec). Results
   change for formulas that use
   - `^`: it means power now (it was bitwise XOR);
   - the bare functions above or `Math.ln`: they did not exist, so the
     formula failed and the fuel estimate was the 0.5 fallback; they are
     evaluated now;
   - a line break at the start: such a formula returned nothing (`NaN`);
   - JavaScript outside the grammar (`%`, `? :`, comparisons, comments, hex,
     octal or `1_000` literals, `Infinity`, `Number()`, `parseFloat()`, ...):
     it used to work and now gives the 0.5 fallback.

   Every other formula gives the same results. `pnpm check:formulas` lists
   the stored formulas concerned.
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
pnpm check:env        # configuration check (after pnpm build)
pnpm check:formulas   # stored first fuel formulas whose results change
docker build -t ais-its-mvp-api .
docker run --env-file .env -p 3020:3020 -p 3004:3004 ais-its-mvp-api
```

The image runs `node dist/bin/www.js` as the `node` user on `PORT=3020` with a
health check on `GET /`; `node dist/bin/check-env.js` and
`node dist/bin/check-formulas.js` run the checks inside it.
