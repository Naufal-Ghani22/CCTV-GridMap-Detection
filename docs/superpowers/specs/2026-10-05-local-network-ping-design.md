# Local Network CCTV Ping Design

## Goal

Run CCTV Grid Map as a local-network web service and let an operator test whether a configured CCTV IPv4 address responds to a real ICMP ping. A successful result must be shown as evidence with latency and check time, while failures must provide an actionable next step.

## Scope

This change will:

- serve the existing static application from a Node.js process bound to the local network;
- add a validated JSON API for one ICMP ping operation;
- add a `Ping IP` control beside the selected camera network configuration;
- render idle, loading, success, timeout, invalid-input, and server-error states;
- store the most recent successful or failed ping result for each camera;
- document how to start the service and open it from another LAN device.

This change will not:

- discover cameras automatically;
- configure router, switch, VLAN, Windows Firewall, or CCTV credentials;
- proxy RTSP video;
- treat an ICMP response as proof that the video stream or camera authentication works;
- run continuous background monitoring.

## Selected Approach

Use one dependency-free Node.js process for both static files and the ping API.

Alternatives considered:

- A PowerShell helper would be more Windows-specific and harder to operate as one web service.
- Express would provide routing conveniences but would add a dependency without enough benefit for this small API.

The selected approach keeps installation small, matches the existing dependency-free project, and gives the browser a safe server-side boundary for ICMP.

## Runtime Architecture

`server.js` will:

1. bind to `0.0.0.0` on port `8080` by default;
2. serve only an allowlisted set of application files and directories from the repository;
3. expose `POST /api/ping`;
4. validate the JSON request and IPv4 address before starting a process;
5. invoke `ping.exe` with fixed arguments and the validated address as a separate argument;
6. enforce a server-side timeout;
7. normalize the result into JSON without exposing raw command output to the browser.

The port may be overridden with `PORT`. The host remains LAN-accessible by default. Startup output will show the loopback URL and detected private IPv4 URLs where possible.

## Ping API

### Request

`POST /api/ping`

```json
{
  "ip": "192.168.1.64"
}
```

Requirements:

- `Content-Type` must be `application/json`.
- The request body is limited to 1 KB.
- `ip` must be a canonical IPv4 address with four decimal octets from 0 through 255.
- Hostnames, IPv6, CIDR notation, ports, URLs, whitespace, and shell metacharacters are rejected.

### Success response

HTTP `200`:

```json
{
  "status": "online",
  "ip": "192.168.1.64",
  "latencyMs": 2,
  "checkedAt": "2026-10-05T10:00:00.000Z"
}
```

### Offline response

HTTP `200`:

```json
{
  "status": "offline",
  "ip": "192.168.1.64",
  "latencyMs": null,
  "checkedAt": "2026-10-05T10:00:00.000Z"
}
```

### Validation and server errors

- HTTP `400`: malformed JSON, missing IP, or invalid IPv4 address.
- HTTP `404`: unknown API route or static asset.
- HTTP `405`: unsupported method.
- HTTP `413`: request body exceeds 1 KB.
- HTTP `500`: ping process could not start or another internal failure occurred.

Errors return a stable `error` code and a short Indonesian message. Internal command details are logged on the server only.

## Security Boundaries

- Use `spawn` or `execFile`, never a shell command string.
- Pass the validated IP as one process argument.
- Do not provide a generic command-execution endpoint.
- Do not expose directory listings, `.git`, tests, documentation, or arbitrary filesystem paths.
- Normalize and verify static paths remain within the allowed public file set.
- Accept same-origin browser requests only; no permissive CORS header is required.
- Limit one active ping request per browser action by disabling the button while a request is running.

The service is intended only for a trusted local network. It does not add authentication beyond the existing client-side demo login and must not be exposed directly to the public internet.

## UI Placement and States

The ping control will live in the existing **Tayangan kamera** settings card because that card already owns the selected camera and IP input.

The action row will contain:

- `Ping IP`, a normal button that tests the current input without first requiring a save;
- `Simpan konfigurasi`, the existing primary action.

A dedicated status region directly below the form fields will use `role="status"` with `aria-live="polite"`.

States:

- **Idle:** neutral text, “Masukkan alamat IP lalu tekan Ping IP.”
- **Loading:** neutral state, “Menguji 192.168.1.64...” The button is disabled and renamed `Menguji...`.
- **Online:** green status indicator labeled `Aktif`, followed by the measured latency and local check time.
- **Offline:** red status indicator labeled `Tidak merespons`, followed by “Periksa daya CCTV, kabel jaringan, subnet, dan alamat IP.”
- **Invalid:** red error text explaining the accepted IPv4 format. No request is sent.
- **Server error:** red state explaining that the local ping service could not complete the check and suggesting retrying or checking the server terminal.

The result must distinguish “last checked” from a continuous live status. Returning to a camera displays its stored result and timestamp with wording such as “Terakhir diuji”.

## Persistence Model

Each camera may receive an optional `lastPing` object:

```json
{
  "status": "online",
  "latencyMs": 2,
  "checkedAt": "2026-10-05T10:00:00.000Z"
}
```

The object is saved through the existing local storage state. Existing cameras without `lastPing` migrate to the idle state. Editing a camera IP clears a result for the previous address. If the operator tested a new IP before saving it, that matching result remains available after saving.

An ICMP result does not automatically change the camera's operational `normal`, `warning`, or `offline` status. Those statuses represent operational workflow and reports, while `lastPing` represents one network observation.

## Visual Direction

Design Read: operational CCTV dashboard for airport staff, using the project's compact teal utility language, with `ENERGY 1 / RHYTHM 1 / MOTION 1`.

Major decisions and reasons:

- **Green only for a successful result:** it communicates measured reachability and does not fabricate status.
- **Red for offline and errors:** it matches the existing failure language and makes the required operator action easy to locate.
- **Inline status region:** it keeps the evidence next to the IP and action that produced it.
- **No glow, pulse, or looping animation:** this is an operational signal, so persistent motion would distract and imply live monitoring.
- **Existing typography and spacing:** the feature belongs to the current dense dashboard rather than introducing a second visual system.
- **Small status dot plus text:** color is reinforced with a written label, so meaning does not rely on color alone.

The status component will use the existing palette and radius system, meet WCAG AA contrast, retain visible keyboard focus, and preserve a minimum 44px tap target on narrow screens.

## Data Flow

1. Operator selects a camera.
2. The form loads its saved IP and last ping result.
3. Operator edits the IP if needed and presses `Ping IP`.
4. Client validates basic IPv4 shape, enters the loading state, and posts JSON to `/api/ping`.
5. Server performs strict validation and runs one bounded ICMP check.
6. Server returns normalized JSON.
7. Client renders the result, stores `lastPing` on the selected camera, and records a history entry.
8. If the IP is later changed and saved, the stored ping evidence is cleared.

## Testing Strategy

### Server tests

- valid reachable IPv4 returns normalized online data;
- valid unreachable IPv4 returns normalized offline data;
- malformed IPv4 and injection-shaped input return `400` without spawning ping;
- oversized body returns `413`;
- unsupported routes and methods return the correct status;
- static traversal attempts do not expose files;
- server binds successfully and serves the application.

Ping execution will be injected behind a small function boundary so automated tests can use deterministic success, offline, timeout, and start-failure results. A separate integration probe will exercise the real `192.168.1.64` address when running on the user's LAN.

### Browser tests

- empty or invalid IP shows validation and sends no request;
- loading state disables the control;
- online response produces the green `Aktif` label, latency, and timestamp;
- offline response produces the red label and troubleshooting instruction;
- server failure produces the service-error instruction;
- switching cameras displays the correct stored result;
- saving a changed IP clears stale ping evidence;
- keyboard activation and visible focus work;
- layout has no horizontal overflow at 375, 768, 1024, and 1440 pixels;
- browser console remains free of errors.

### Manual LAN verification

- start the server;
- verify the local machine can open the loopback URL;
- verify another device on the same LAN can open the detected private IPv4 URL, subject to Windows Firewall permission;
- ping `192.168.1.64` from the web control and confirm that the result matches a direct system ping.

## Operation

`package.json` will provide a `start` script. The README will document:

1. run `npm start`;
2. allow Node.js on the private network if Windows Firewall asks;
3. open the printed LAN URL;
4. sign in as an administrator;
5. open **Pengaturan sistem**, select a CCTV, enter its IPv4 address, and press `Ping IP`.

The server will remain a foreground process. Stopping the terminal stops the local web service, which keeps operation explicit and avoids silently installing a background Windows service.
