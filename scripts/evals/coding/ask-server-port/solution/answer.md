With nothing configured the server listens on **8443**: `defaultPort()` in
src/config/defaults.js returns `BASE_PORT` (8000) plus the https offset (443),
because `DEFAULTS.tls` is true. The README's "port 3000" is stale.

Set the `VY_LISTEN_PORT` environment variable to override it (src/server.js,
`resolvePort`). `PORT` is not read by the server.
