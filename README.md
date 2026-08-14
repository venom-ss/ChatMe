# ChatMe v1

A privacy-first, anonymous, random 1-to-1 text chat designed for Koyeb.

## What is included

- Random 1-to-1 matchmaking
- User gender: Girl / Boy / Other
- Partner preference: Girls / Boys / Anyone
- Mutual preference matching
- 18+ self-confirmation gate
- No accounts or usernames
- No application database
- No chat-history persistence
- Live online count from active WebSocket connections
- Text messages encrypted in the browser with an ephemeral ECDH P-256 / AES-GCM session key
- Photo/file transfer up to 6 MB
- File contents encrypted in the browser and relayed as small WebSocket chunks; the server never buffers a complete file
- Accept / Decline before a file is transferred
- Next and End Chat actions
- Typing indicator
- Connection heartbeat plus text/binary rate limits
- Security headers and no application-level request/message/IP logging
- Docker runtime under the unprivileged `node` user
- GitHub Actions CI for syntax and protocol tests

## Privacy model

ChatMe intentionally stores matchmaking/session state only in process RAM. A disconnect, instance restart, or deployment destroys that state. The application does not write messages, files, IP addresses, user profiles, or chat history to a database or filesystem.

While a person waits in the queue, the server temporarily needs their gender choice, partner preference, and ephemeral public key. Those matching fields and public keys are cleared from the server-side client object immediately after a match is formed.

Message bodies and accepted file contents are encrypted in the browser before relay. The server still sees connection-level metadata needed to operate the service, such as active socket count, file transfer IDs/sizes, and traffic timing.

This v1 does **not** provide cryptographic identity verification. Because the web application and key exchange are served by the same deployment, this design should not be described as protection from a malicious or compromised ChatMe server. Its goal is data minimization and preventing ordinary server-side content retention.

Koyeb may retain infrastructure/platform telemetry outside the application. This repository deliberately writes no request, user, message, file-content, or IP logs to stdout/stderr.

## Requirements

- Node.js 22.x
- npm

## Run locally

```bash
npm install --ignore-scripts --no-audit --no-fund
npm start
```

Open `http://localhost:8000` in two separate browser windows. For deterministic matching, choose complementary preferences, for example Girl -> Boys and Boy -> Girls.

Health check:

```bash
curl http://localhost:8000/health
```

## Check and test

```bash
npm run check
npm test
```

The test suite covers the health endpoint, the 18+ requirement, compatible and incompatible matchmaking, `Next` rematching, secure JSON relay, and accepted binary file relay.

A GitHub Actions workflow is included at `.github/workflows/ci.yml`. It runs these checks on pushes to `main` and pull requests using Node.js 22.

## Deploy to Koyeb

For v1, use the included **Dockerfile**. It pins the Node major version, installs the exact `ws` dependency declared in `package.json`, disables install scripts/audit output, and runs the service as the non-root `node` user.

### GitHub -> Koyeb checklist

1. Create a GitHub repository and place the contents of this folder at the repository root.
2. Push the repository to the `main` branch and confirm the included GitHub Actions CI passes.
3. In Koyeb, create a **Web Service** from that GitHub repository.
4. Choose the **Dockerfile** builder.
5. Expose the service over HTTP on port `8000`. The app also reads Koyeb's `PORT` environment variable and binds to `0.0.0.0`.
6. Set the public route to `/`.
7. Configure an HTTP health check on `/health`.
8. Keep the service at **exactly one instance** for v1 and use one region.
9. Do not add a database, object-storage bucket, or application logging service for this architecture.
10. After deployment, open the public HTTPS URL in two separate/private browser sessions and test matching, messaging, `Next`, and a small file transfer.

### Why only one instance?

The queue, pairings, and online count intentionally live only in RAM. Multiple instances would each have an independent queue and count. Scaling beyond one instance requires a shared coordination layer, which would change the current no-database/no-external-state architecture.

### Koyeb references

- Services and WebSocket support: https://www.koyeb.com/docs/reference/services
- Deploying from GitHub: https://www.koyeb.com/docs/deploy/github
- Node.js deployment: https://www.koyeb.com/docs/build-and-deploy/build-from-git/nodejs
- Exposing services and `PORT`: https://www.koyeb.com/docs/build-and-deploy/exposing-your-service
- Health checks: https://www.koyeb.com/docs/run-and-scale/health-checks

## File transfer protocol

The browser asks the partner to accept first. After acceptance, the sender splits the file into 48 KiB pieces. Each piece is encrypted independently with AES-GCM using a fresh random IV and authenticated metadata containing the transfer ID and sequence number. The server validates transfer size/order limits and forwards ciphertext directly to the matched partner without buffering a complete file.

Maximum plaintext file size: `6 * 1024 * 1024` bytes (6 MiB).

## Important production notes

1. The 18+ gate is self-attestation. Privacy-preserving age verification is a separate product/security decision.
2. Anonymous file sharing can be abused. The receiver must explicitly accept every file, and files are never auto-opened.
3. There is no persistent banning/reporting system because that would require durable identifiers or state. If moderation becomes a requirement, define that privacy trade-off explicitly before implementing it.
4. Horizontal scaling is intentionally disabled for v1.
5. Platform-level telemetry is controlled by the hosting provider, not by this application. Review Koyeb's current logging/retention settings before calling the overall service "no logs" without qualification.
