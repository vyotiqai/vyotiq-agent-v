import { BASE_PORT, OFFSETS } from './constants.js'

export const DEFAULTS = {
  tls: true,
  host: '0.0.0.0',
  metricsPort: BASE_PORT + OFFSETS.metrics
}

/** The listening port follows the protocol: TLS on, so the https offset. */
export function defaultPort(config = DEFAULTS) {
  return BASE_PORT + (config.tls ? OFFSETS.https : OFFSETS.http)
}
