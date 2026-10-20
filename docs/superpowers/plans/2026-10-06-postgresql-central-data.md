# PostgreSQL Central Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser-only CCTV data with a secure, empty PostgreSQL database shared by every authorized LAN user.

**Architecture:** PostgreSQL and pgAdmin run on the local Windows server, while the Node.js process is the only component exposed to the LAN. The Node.js server owns authentication, database access, RTSP decryption, and all JSON APIs; browsers store only an HttpOnly session cookie and transient interface state.

**Tech Stack:** Node.js 22+, PostgreSQL 17+, pgAdmin 4, `pg`, Node.js `crypto`, native `node:test`, Playwright/Edge.

**Spec:** `docs/superpowers/specs/2026-10-06-postgresql-central-data-design.md`

## Global Constraints

- PostgreSQL listens only on localhost; port 5432 is never opened to the LAN.
- The web service remains the LAN-facing component on port 8080.
- Database, pgAdmin, and web-service credentials are distinct.
- No demo CCTV, reports, or activity history is inserted.
- RTSP URLs are encrypted at rest and never returned by ordinary camera APIs.
- Secrets live in ignored `.env`; only `.env.example` is committed.
- Browser storage is never a fallback data source after the migration.

---

### Task 1: Install local database administration tools

**Files:**
- Create: `.env.example`
- Modify: `.gitignore`
- Modify: `README.md`

**Interfaces:**
- Consumes: Windows package manager and local administrator approval.
- Produces: `psql`, PostgreSQL Windows service, pgAdmin 4, and a documented local-only database deployment.

- [ ] **Step 1: Check that neither PostgreSQL nor pgAdmin is already installed**

Run:

```powershell
Get-Service -Name '*postgres*','*pgadmin*' -ErrorAction SilentlyContinue
where.exe psql
where.exe pgAdmin4
```

Expected: no active PostgreSQL service and no matching executables.

- [ ] **Step 2: Install PostgreSQL and pgAdmin interactively**

Run the following from an elevated PowerShell. Set the PostgreSQL superuser password in the installer prompt; do not place it in a command, source file, or chat log.

```powershell
winget install --id PostgreSQL.PostgreSQL --exact --interactive
winget install --id PostgreSQL.pgAdmin --exact --interactive
```

- [ ] **Step 3: Verify installation and local-only listener**

Run:

```powershell
Get-Service -Name 'postgresql*' | Select-Object Name, Status
psql --version
Get-NetTCPConnection -LocalPort 5432 -State Listen | Select-Object LocalAddress, LocalPort
```

Expected: PostgreSQL is running and its listener is `127.0.0.1` or `::1`, not `0.0.0.0`.

- [ ] **Step 4: Add ignored runtime configuration and its public template**

Create `.env.example` with exactly these variable names and empty values:

```dotenv
DATABASE_URL=
SESSION_SECRET=
RTSP_ENCRYPTION_KEY=
BOOTSTRAP_ADMIN_EMAIL=
BOOTSTRAP_ADMIN_PASSWORD=
```

Add `.env` to `.gitignore`. Document that `.env` belongs only on the server and must be backed up through the organization’s approved secret-management process.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .env.example README.md
git commit -m "docs: describe local PostgreSQL deployment"
```

### Task 2: Add configuration and database connection boundaries

**Files:**
- Create: `config.js`
- Create: `db/client.js`
- Modify: `package.json`
- Modify: `tests/config.test.js`

**Interfaces:**
- Consumes: `DATABASE_URL`, `SESSION_SECRET`, `RTSP_ENCRYPTION_KEY`, `BOOTSTRAP_ADMIN_EMAIL`, and `BOOTSTRAP_ADMIN_PASSWORD` from `.env` or process environment.
- Produces: `loadConfig(env): AppConfig` and `createPool(connectionString): import('pg').Pool`.

- [ ] **Step 1: Write failing configuration tests**

```js
test('rejects a production configuration without database or encryption secrets', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /DATABASE_URL/);
});

test('loads mandatory server-only database settings', () => {
  const config = loadConfig(validEnvironment);
  assert.equal(config.databaseUrl, 'postgres://cctv_app:secret@127.0.0.1:5432/cctv_grid_map');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/config.test.js`

Expected: FAIL because `loadConfig` does not exist.

- [ ] **Step 3: Add `pg` and dotenv, then implement the minimal boundary**

Run:

```powershell
npm install pg dotenv
```

Implement `loadConfig` to load `.env`, require nonempty values in database mode, require a 32-byte base64 RTSP key, and return frozen config values. Implement `createPool` with `max: 10`, `host` validation through the connection string, and an application name of `cctv-grid-map`.

- [ ] **Step 4: Run configuration tests and existing tests**

Run: `npm test; node --test tests/config.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json config.js db/client.js tests/config.test.js
git commit -m "feat: add database configuration boundary"
```

### Task 3: Create the empty PostgreSQL schema and bootstrap administrator

**Files:**
- Create: `db/schema.sql`
- Create: `db/migrate.js`
- Create: `db/bootstrap.js`
- Create: `lib/passwords.js`
- Test: `tests/database-schema.test.js`

**Interfaces:**
- Consumes: `createPool`, `AppConfig`, and an empty `cctv_grid_map` database.
- Produces: `migrate(pool): Promise<void>`, `bootstrapAdmin(pool, config): Promise<void>`, and `hashPassword(password): Promise<string>` / `verifyPassword(password, hash): Promise<boolean>`.

- [ ] **Step 1: Write failing schema and bootstrap tests**

```js
test('migration creates empty camera, report, and activity tables', async () => {
  await migrate(testPool);
  assert.equal((await testPool.query('SELECT count(*) FROM cameras')).rows[0].count, '0');
});

test('bootstrap creates one administrator only when users is empty', async () => {
  await bootstrapAdmin(testPool, testConfig);
  await bootstrapAdmin(testPool, testConfig);
  assert.equal((await testPool.query('SELECT count(*) FROM users')).rows[0].count, '1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/database-schema.test.js`

Expected: FAIL because migration functions and schema are absent.

- [ ] **Step 3: Define schema and initialization scripts**

Create `users`, `cameras`, `camera_streams`, `reports`, `activity_history`, `settings`, and `sessions` tables with UUID primary keys, UTC timestamps, foreign keys, and indexes for camera ID, report camera ID, activity creation time, and session expiry. Use `pgcrypto` only if available; otherwise generate UUIDs in Node.js with `crypto.randomUUID()`.

Implement password storage with `crypto.scrypt`, a random salt, and `timingSafeEqual`. `bootstrapAdmin` must insert the account only when `users` has zero rows, with role `admin`; it must never log the supplied password.

- [ ] **Step 4: Add package scripts and run migrations against a test database**

Add:

```json
{
  "db:migrate": "node db/migrate.js",
  "db:bootstrap": "node db/bootstrap.js"
}
```

Run: `node --test tests/database-schema.test.js`

Expected: PASS with zero CCTV, report, and history records plus one administrator.

- [ ] **Step 5: Commit**

```bash
git add db lib/passwords.js package.json tests/database-schema.test.js
git commit -m "feat: add empty CCTV database schema"
```

### Task 4: Add encrypted RTSP and server-side session helpers

**Files:**
- Create: `lib/rtsp-secrets.js`
- Create: `lib/sessions.js`
- Test: `tests/rtsp-secrets.test.js`
- Test: `tests/sessions.test.js`

**Interfaces:**
- Consumes: `config.rtspEncryptionKey`, `config.sessionSecret`, the `camera_streams` and `sessions` tables.
- Produces: `encryptRtsp(url, key): string`, `decryptRtsp(ciphertext, key): string`, `createSession(pool, userId): Promise<{ token, expiresAt }>`, and `getSessionUser(pool, token): Promise<User | null>`.

- [ ] **Step 1: Write failing encryption and session tests**

```js
test('RTSP encryption round-trips without leaving the URL in ciphertext', () => {
  const ciphertext = encryptRtsp('rtsp://viewer:password@192.168.1.64/live', key);
  assert.doesNotMatch(ciphertext, /viewer|password|192\.168\.1\.64/);
  assert.equal(decryptRtsp(ciphertext, key), 'rtsp://viewer:password@192.168.1.64/live');
});

test('expired sessions do not return a user', async () => {
  const { token } = await createSession(testPool, userId);
  await testPool.query('UPDATE sessions SET expires_at = now() - interval \'1 second\'');
  assert.equal(await getSessionUser(testPool, token), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/rtsp-secrets.test.js tests/sessions.test.js`

Expected: FAIL because the helpers do not exist.

- [ ] **Step 3: Implement AES-256-GCM encryption and hashed session tokens**

Use a fresh 12-byte IV per RTSP value, store `iv.tag.ciphertext` in base64url form, and authenticate before returning plaintext. Generate a 32-byte session token, store only its SHA-256 digest in PostgreSQL, expire it after 12 hours, and delete expired sessions during lookup.

- [ ] **Step 4: Run helper tests**

Run: `node --test tests/rtsp-secrets.test.js tests/sessions.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib tests/rtsp-secrets.test.js tests/sessions.test.js
git commit -m "feat: secure RTSP and user sessions"
```

### Task 5: Build authenticated database repositories and HTTP APIs

**Files:**
- Create: `repositories/users.js`
- Create: `repositories/cameras.js`
- Create: `repositories/reports.js`
- Create: `repositories/activity.js`
- Create: `repositories/settings.js`
- Modify: `server.js`
- Test: `tests/api-auth.test.js`
- Test: `tests/api-cameras.test.js`
- Test: `tests/api-reports.test.js`

**Interfaces:**
- Consumes: `Pool`, repository functions, session helpers, and existing `runPing` / FFmpeg helpers.
- Produces: same-origin `/api/auth/*`, `/api/cameras`, `/api/reports`, `/api/history`, `/api/settings`, `/api/ping`, and `/api/streams` endpoints.

- [ ] **Step 1: Write failing authorization tests**

```js
test('rejects a camera list request without a session', async () => {
  const response = await fetch(`${base}/api/cameras`);
  assert.equal(response.status, 401);
});

test('allows an admin to create a camera but does not return streamUrl', async () => {
  const response = await authenticatedFetch('/api/cameras', { method: 'POST', body: cameraPayload });
  const camera = await response.json();
  assert.equal(response.status, 201);
  assert.equal('streamUrl' in camera, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/api-auth.test.js tests/api-cameras.test.js tests/api-reports.test.js`

Expected: FAIL because the endpoints and authorization middleware do not exist.

- [ ] **Step 3: Implement repositories and API routes**

Implement parameterized SQL only. Require authenticated sessions for all API routes, require the `admin` role for camera/settings mutation, and record activity rows in the same transaction as each mutation. Return `401` for missing sessions, `403` for disallowed roles, `404` for absent records, `409` for duplicate camera IDs, and `400` for invalid input.

Move the RTSP bridge to `POST /api/cameras/:id/stream-session`: fetch the encrypted RTSP URL internally, decrypt it in memory, and create the opaque stream session. Remove the public URL-accepting stream endpoint.

- [ ] **Step 4: Run all API tests**

Run: `npm test; node --test tests/api-auth.test.js tests/api-cameras.test.js tests/api-reports.test.js`

Expected: PASS with no API response containing an RTSP URL or password.

- [ ] **Step 5: Commit**

```bash
git add repositories server.js tests/api-auth.test.js tests/api-cameras.test.js tests/api-reports.test.js
git commit -m "feat: serve CCTV data from PostgreSQL APIs"
```

### Task 6: Replace browser-local state with server data and clear old CCTV data

**Files:**
- Modify: `app.js`
- Modify: `index.html`
- Modify: `sha256.js`
- Test: `tests/empty-data-ui.spec.js`
- Test: `tests/login_lan.spec.js`

**Interfaces:**
- Consumes: authenticated API endpoints from Task 5.
- Produces: `loadApplicationData(): Promise<void>`, `apiFetch(path, options): Promise<Response>`, and UI state populated exclusively from server responses.

- [ ] **Step 1: Write failing browser tests for empty centralized data**

```js
test('shows an empty CCTV inventory after server login', async ({ page }) => {
  await loginAsBootstrapAdmin(page);
  await page.getByRole('button', { name: 'Perangkat' }).click();
  await expect(page.getByText('Belum ada perangkat CCTV')).toBeVisible();
});

test('removes legacy local CCTV state after loading server data', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cctv-map-state-v2', JSON.stringify({ cameras: [{ id: 'OLD' }] })));
  await loginAsBootstrapAdmin(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cctv-map-state-v2'))).toBeNull();
});
```

- [ ] **Step 2: Run the browser test to verify it fails**

Run: `node tests/empty-data-ui.spec.js`

Expected: FAIL because the app still uses demo arrays and localStorage.

- [ ] **Step 3: Implement API-backed state and empty-state copy**

Remove `ACCOUNTS`, demo records, client-side password hashing, and all `saveState` data writes. On application startup, remove legacy CCTV storage keys, load the current session from `/api/auth/session`, then load database data. Change the device empty copy to `Belum ada perangkat CCTV. Tambahkan perangkat pertama untuk memulai.` Keep the existing no-results copy for active filters.

Use `POST /api/cameras/:id/stream-session` when opening a live view. Do not put a saved RTSP URL into the browser’s camera list state.

- [ ] **Step 4: Run UI and LAN login tests**

Run:

```powershell
$env:NODE_PATH='C:\Users\Naufal Ghani\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node tests/empty-data-ui.spec.js
node tests/login_lan.spec.js
```

Expected: PASS with a genuinely empty device page and server-backed login.

- [ ] **Step 5: Commit**

```bash
git add app.js index.html sha256.js tests/empty-data-ui.spec.js tests/login_lan.spec.js
git commit -m "feat: load centralized CCTV data in the web app"
```

### Task 7: Initialize local database, validate pgAdmin, and document airport migration

**Files:**
- Modify: `README.md`
- Create: `docs/database-backup-restore.md`
- Modify: `package.json`
- Test: `tests/database-smoke.js`

**Interfaces:**
- Consumes: `.env`, local PostgreSQL service, schema/bootstrapping scripts, and the web server.
- Produces: a running empty local system and repeatable backup/restore commands for the airport device.

- [ ] **Step 1: Write a failing database smoke test**

```js
test('local database starts empty and the bootstrap administrator can authenticate', async () => {
  const response = await fetch(`${base}/api/cameras`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});
```

- [ ] **Step 2: Run it to verify the local setup is not ready**

Run: `node tests/database-smoke.js`

Expected: FAIL before `.env`, migration, and bootstrap are complete.

- [ ] **Step 3: Create local secrets and initialize database**

Generate the two application secrets without printing them:

```powershell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Create `.env` from `.env.example`, enter the dedicated application database URL and a bootstrap administrator email/password, then run:

```powershell
npm run db:migrate
npm run db:bootstrap
npm start
```

Use pgAdmin on `localhost` to confirm that `cameras`, `reports`, and `activity_history` contain zero rows and `users` contains exactly one administrator.

- [ ] **Step 4: Verify remote browser behavior without exposing PostgreSQL**

From another browser profile or LAN computer, open `http://SERVER_IP:8080`, sign in as the bootstrap administrator, and confirm it sees the empty inventory. Confirm `Test-NetConnection SERVER_IP -Port 5432` fails from another LAN computer.

- [ ] **Step 5: Document backup and restore procedures**

Document these commands, with host, username, and file names replaced by the airport values at deployment time:

```powershell
pg_dump --format=custom --file cctv_grid_map.backup --dbname cctv_grid_map
pg_restore --clean --if-exists --dbname cctv_grid_map cctv_grid_map.backup
```

Document that the `.env` file is transferred separately through the approved secret-management channel and is never included in a database backup.

- [ ] **Step 6: Run the full verification suite and commit**

Run:

```powershell
npm test
node --test tests/config.test.js tests/database-schema.test.js tests/rtsp-secrets.test.js tests/sessions.test.js tests/api-auth.test.js tests/api-cameras.test.js tests/api-reports.test.js
node tests/database-smoke.js
git diff --check
```

Expected: all automated tests pass, the web system shows no demo CCTV data, and pgAdmin confirms a clean centralized schema.

Commit:

```bash
git add README.md docs/database-backup-restore.md package.json tests/database-smoke.js
git commit -m "docs: add airport database migration guide"
```
