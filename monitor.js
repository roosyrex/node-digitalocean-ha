// Dependencies.

var http    = require('http');
var Q       = require('q');
var request = require('request');
var moment  = require('moment');

// Constants.

var REQUEST_TIMEOUT_MS     = 15000;
var HEARTBEAT_INTERVAL_MS  = 20000;
var ACQUIRE_AFTER_MS       = 60000;
var ACQUIRE_DELAY_MS       = 60000;

var FIP_ACTIVE_URL  = 'http://169.254.169.254/metadata/v1/floating_ip/ipv4/active';
var FIP_ACQUIRE_URL = 'https://api.digitalocean.com/v2/floating_ips/$floatingIP/actions';

// Variables.

var config;
var server;

var lastHeartbeat   = moment();
var lastAcquisition = moment();
var acquireFailures = 0;

// Functions.

function log (message) {
  console.log(moment().format('HH:mm:ss') + ': ' + message);
}

function panic () {
  log('PANIC!');
}

function makeRequest (method, url, headers, body, code) {

  code = code || 200;

  var deferred = Q.defer();
  var timeout  = false;

  var options = {
    url: url,
    followRedirect: false
  };

  if (headers)
    options.headers = headers;
  if (body)
    options.body = body;

  // Set timeout for request.

  setTimeout(function () {
    timeout = true;
    return deferred.reject(500);
  }, REQUEST_TIMEOUT_MS);

  request[method](options, function (err, res, body) {

    // If timed out, return immediately.

    if (timeout)
      return;

    // Resolve if code matches, else reject.

    if (!err && res.statusCode === code)
      return deferred.resolve(body);
    else
      return deferred.reject(err || res.statusCode);

  });

  return deferred.promise;

}

function acquireIP () {

  // Only attempt to acquire the floating IP if we haven't recently.

  if (moment().diff(lastAcquisition) < ACQUIRE_DELAY_MS)
    return;

  log('Too many heartbeats missed, acquiring IP...');

  lastAcquisition = moment();

  // Check if the floating IP is already assigned to us.

  makeRequest('get', FIP_ACTIVE_URL)
  .then(function (body) {

    if (body === 'true') {
      lastHeartbeat = moment();
      acquireFailures = 0;
      return log('IP is already assigned to us');
    }

    // Attempt to acquire the floating IP.

    var url     = FIP_ACQUIRE_URL.replace('$floatingIP', config.floatingIP);
    var data    = { type: 'assign', droplet_id: config.dropletId };
    var headers = {
      'Authorization' : 'Bearer ' + config.apiToken,
      'Content-Type'  : 'application/json'
    };

    makeRequest('post', url, headers, JSON.stringify(data), 201)
    .then(function () {

      lastHeartbeat = moment();
      acquireFailures = 0;
      return log('Successfully acquired IP');

    }, function (err) {

      acquireFailures++;
      log('Failed to acquire IP: ' + err);

      if (acquireFailures >= 3) {
        panic();
        return process.exit();
      }

    });
  
  });

}

function heartbeatSuccess () {

  lastHeartbeat = moment();

  log('Heartbeat OK');

}

function heartbeatFailure (reason) {

  log('Heartbeat failed: ' + reason);

  if (moment().diff(lastHeartbeat) >= ACQUIRE_AFTER_MS)
    return acquireIP();

}

function doHeartbeat () {

  // Set timeout for next heartbeat.

  setTimeout(doHeartbeat, HEARTBEAT_INTERVAL_MS);

  // Make heartbeat request.

  var promise = makeRequest('get', 'http://' + config.peerAddress + ':' + config.bindPort)
  .then(heartbeatSuccess, heartbeatFailure);

}

// Setup.

try {
  config = require('./config/config.js');
} catch (err) {
  console.error('Unable to read config.js file! Exiting...');
  process.exit();
}

// Start the heartbeat server.

server = http.createServer(function (req, res) {
  return res.end('OK');
});

server.listen(config.bindPort, config.bindAddress);

// Start heartbeat requests.

doHeartbeat();

console.log('Heartbeat server started OK');
