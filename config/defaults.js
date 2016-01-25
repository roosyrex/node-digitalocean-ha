// NOTE: This is the default configuration file.
//       Server-specific values should be overridden in 'config.js'.

module.exports = {

  // Port on which heartbeats should be listened for / sent to.
  bindPort                : 8080,
  // Local IP address to listen for heartbeats on.
  bindIPAddress           : '',
  // HA peer IP address for sending heartbeats.
  peerIPAddress           : '',
  // Floating IP address.
  floatingIPAddress       : '',
  // (CONFIDENTIAL) DigitalOcean API token.
  apiToken                : '',
  // Timeout for HTTP requests (milliseconds).
  httpRequestTimeoutMs    : 20000,
  // Heartbeat interval (milliseconds).
  heartbeatIntervalMs     : 30000,
  // Initial heartbeat delay (milliseconds).
  heartbeatInitialDelayMs : 30000,
  // Peer downtime before floating IP acquisition (milliseconds).
  acquireIPAfterMs        : 120000,
  // Interval between floating IP acquisition attempts (milliseconds).
  acquireIPDelayMs        : 60000,
  // (CONFIDENTIAL) Pushover application API token.
  pushoverToken           : '',
  // (CONFIDENTIAL) Pushover user or group key.
  pushoverUserGroupKey    : ''

};
