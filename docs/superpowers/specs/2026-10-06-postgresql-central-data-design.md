# PostgreSQL Central Data Design

## Goal

Move CCTV Grid Map from browser-only storage to one PostgreSQL database on the local server computer. Every authorized browser on the airport LAN reads the same CCTV inventory, reports, history, and settings. The deployment starts with an empty CCTV inventory, reports list, and activity history.

## Deployment boundary

- PostgreSQL runs on the same Windows computer as the Node.js service during development and the future airport deployment.
- PostgreSQL accepts connections only from localhost. It is never exposed directly to the airport LAN.
- The Node.js service remains the only LAN-facing component on port 8080.
- pgAdmin is an administration tool for TI staff on the server computer. It is not a requirement for ordinary users.
- The application uses a dedicated database role with only the permissions required by the application. PostgreSQL's superuser account is not used by the web service.

## Data model

| Table | Purpose |
| --- | --- |
| `users` | Named application accounts, role, division, password hash, active state, timestamps. |
| `cameras` | CCTV inventory, area, location, hardware details, IP address, position, direction, status, and update time. |
| `camera_streams` | One encrypted RTSP URL per camera. The URL is never returned by ordinary camera-list endpoints. |
| `reports` | CCTV issue reports and resolution status. |
| `activity_history` | Immutable user-visible activity events. |
| `settings` | Shared configuration such as NVR address and customized floor-plan markup. |
| `sessions` | Expiring server-side login sessions. |

The first schema creates these tables empty, except for one bootstrap administrator created from environment variables. Demo camera, report, and activity data are not migrated.

## Security model

- Browser passwords are verified by the server; password hashes never reach the browser.
- Login uses an `HttpOnly`, `SameSite=Lax` session cookie rather than browser-managed demo identity.
- The RTSP URL is encrypted at rest with an `RTSP_ENCRYPTION_KEY` that exists only in the server environment.
- RTSP credentials are not shown in the UI after saving. The live-stream bridge receives the decrypted value only for the active stream process.
- Configuration secrets are placed in an ignored `.env` file. A committed `.env.example` names required variables without values.
- Database, pgAdmin, and web-service credentials are distinct.

## Application interface

The frontend reads and writes data through same-origin JSON endpoints. The server authorizes every endpoint before performing database access.

- Authentication: session bootstrap, login, logout, current profile.
- Cameras: list, create, update, delete, and live-stream session creation.
- Reports: list, create, update status, and delete when authorized.
- Activity: list and CSV export.
- Settings: read and update shared settings.

The existing empty states remain visible when no rows exist. User-facing pages no longer use `localStorage` as their source of truth.

## Initialization and migration

1. Install PostgreSQL and pgAdmin locally.
2. Create database `cctv_grid_map` and the restricted application role.
3. Supply the database URL, encryption key, and bootstrap-admin credentials through environment variables.
4. Run a schema initializer that creates tables and the first administrator if no user exists.
5. Start the Node.js server and verify a clean inventory from a second browser profile.

No browser CCTV data is imported. Existing `localStorage` CCTV, reports, and history data are removed by a one-time client migration so a stale browser cannot show old demo inventory.

## Failure handling

- Server startup fails clearly when mandatory environment variables or the database connection are unavailable.
- API requests return a safe error message without exposing SQL, RTSP URLs, passwords, or connection strings.
- A database outage leaves the browser in an error state and does not silently fall back to local-only storage.
- RTSP playback continues to require a valid, authorized camera record.

## Verification

- Unit tests cover validation, authorization boundaries, and encryption helpers.
- Integration tests run schema initialization against a test database and verify empty initial inventory.
- Browser tests verify login, camera creation, shared data visibility from another session, and safe handling of failed API calls.
- Manual verification confirms PostgreSQL is bound locally, pgAdmin can inspect the empty tables, and another LAN browser reaches the web service but not PostgreSQL.
