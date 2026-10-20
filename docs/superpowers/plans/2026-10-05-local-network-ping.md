# Local Network Ping Implementation Plan

> **For agentic workers:** Implement inline in this chat. Steps use checkbox syntax for tracking.

**Goal:** Serve CCTV Grid Map on the LAN and show a measured camera ping result in the settings form.

**Architecture:** A dependency-free Node server serves allowlisted static assets and runs a bounded Windows ICMP probe behind `POST /api/ping`. The existing browser app posts the selected IPv4 address and stores only the latest observation for that camera.

**Tech Stack:** Node.js built-ins, Windows `ping.exe`, existing HTML/CSS/JavaScript, Node test runner, Playwright browser checks.

**Spec:** `docs/superpowers/specs/2026-10-05-local-network-ping-design.md`

## Global Constraints

- Bind to `0.0.0.0:8080` by default; support `PORT` override.
- Validate canonical IPv4; bound request body to 1 KB and ping duration.
- Keep the service local-network oriented and avoid dependencies.
- Preserve current camera data and clear stale ping evidence when its IP changes.
- Follow the existing compact teal dashboard style and provide text labels for all result colors.

## Files

- `server.js`: HTTP routing, static file allowlist, IPv4 validation, and ping process boundary.
- `tests/server.test.js`: server behavior, input validation, static file access, and deterministic ping results.
- `index.html`: Ping IP button and accessible status region.
- `app.js`: ping request and status rendering, result persistence, stale result handling.
- `styles.css`: responsive result region using existing color tokens.
- `tests/ping_ui.spec.js`: browser flow and state checks.
- `package.json`, `README.md`: start command and LAN operation instructions.

## Task 1: Local HTTP and ping boundary

- [x] Write failing Node tests for online, offline, invalid IPv4, oversized body, method handling, and static allowlist.
- [x] Run the Node tests and confirm they fail due to missing server implementation.
- [x] Implement `createServer({ ping })`, `isValidIpv4(ip)`, and `runPing(ip)` in `server.js` with `spawn('ping.exe', ['-n','1','-w','1500',ip])` and an overall timeout.
- [x] Run tests until they pass and inspect the response shape against the spec.

## Task 2: Browser control and status

- [x] Write a failing Playwright check that opens settings, enters `192.168.1.64`, and expects `Aktif` plus a check time after a successful API response.
- [x] Add `Ping IP` beside save and an `aria-live` result region in `index.html`.
- [x] Implement idle, loading, online, offline, invalid, and service error rendering in `app.js`.
- [x] Persist `lastPing` on the selected camera and clear it when either edit form changes the IP.
- [x] Add CSS for the result region, focus, contrast, and mobile action wrapping.
- [x] Run browser tests for each state, camera switching, stale result removal, keyboard action, and narrow layouts.

## Task 3: Operation and final verification

- [x] Add `package.json` with `npm start` and update README for LAN startup, firewall, and admin workflow.
- [x] Run Node tests, browser checks, and syntax checks.
- [x] Start the service on the host, request the LAN URL, and ping `192.168.1.64` through the real API.
- [x] Review diff, console output, and report the exact test results and any network limitation.

The LAN URL was checked from the server host. A second physical device was not available for the cross-device check.
