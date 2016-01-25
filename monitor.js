// Dependencies.

var http    = require('http');
var Q       = require('q');
var _       = require('lodash');
var request = require('request');
var moment  = require('moment');
var config  = require('./config/defaults');

// Constants.

var DROPLET_ID_URL  = 'http://169.254.169.254/metadata/v1/id';
var FIP_ACTIVE_URL  = 'http://169.254.169.254/metadata/v1/floating_ip/ipv4/active';
var FIP_ACQUIRE_URL = 'https://api.digitalocean.com/v2/floating_ips/$floatingIPAddress/actions';

// Variables.

var lastHeartbeat   = null;
var lastAcquisition = null;
var acquireFailures = 0;

// Functions.

function log (message) {
  console.log(moment().format('HH:mm:ss') + ': ' + message);
}

function logError (err) {
  console.error(moment().format('HH:mm:ss') + ': ' + err);
}

function panic () {
  logError('PANIC!');
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
    return deferred.reject('request timed out');
  }, config.httpRequestTimeoutMs);

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

  if (lastAcquisition &&
      moment().diff(lastAcquisition) < config.acquireIPDelayMs)
    return;

  log('Too many heartbeats missed, checking floating IP assignment...');

  lastAcquisition = moment();

  // Check if the floating IP is already assigned to us.

  makeRequest('get', FIP_ACTIVE_URL)
  .then(function (body) {

    if (body === 'true') {
      lastHeartbeat = moment();
      acquireFailures = 0;
      return log('Floating IP is already assigned to us, no action required');
    }

    // Attempt to acquire the floating IP.

    log('Attempting to acquire floating IP...');

    var url     =
        FIP_ACQUIRE_URL.replace('$floatingIPAddress', config.floatingIPAddress);
    var data    = { type: 'assign', droplet_id: config.dropletId };
    var headers = {
      'Authorization' : 'Bearer ' + config.apiToken,
      'Content-Type'  : 'application/json'
    };

    makeRequest('post', url, headers, JSON.stringify(data), 201)
    .then(function () {

      lastHeartbeat = moment();
      acquireFailures = 0;
      return log('Successfully acquired floating IP');

    }, function (err) {

      acquireFailures++;
      logError('Failed to acquire floating IP: ' + err);

      if (acquireFailures >= 3) {
        panic();
        return process.exit();
      }

    });
  
  });

}

function heartbeatSuccess () {

  lastHeartbeat = moment();

  log('Received heartbeat response from peer (' + config.peerIPAddress + ')');

}

function heartbeatFailure (reason) {

  log('WARN: No heartbeat response received from peer (' +
      config.peerIPAddress + '): ' + reason);

  if (moment().diff(lastHeartbeat) >= config.acquireIPAfterMs)
    return acquireIP();

}

function doHeartbeat () {

  // Ensure last heartbeat date is initialised.

  lastHeartbeat = lastHeartbeat || moment();

  // Set timeout for next heartbeat.

  setTimeout(doHeartbeat, config.heartbeatIntervalMs);

  // Make heartbeat request.

  var promise = makeRequest(
      'get', 'http://' + config.peerIPAddress + ':' + config.bindPort)
  .then(heartbeatSuccess, heartbeatFailure);

}

// Setup.

(function () {

  // Load configuration and run setup activities.

  Q().then(function () {
    locals = require('./config/config.js');
    _.assign(config, locals);
  })
  .catch(function (err) {
    logError(err);
    logError('Unable to read config.js file, exiting...');
    return process.exit();
  })
  .then(function () {

    // Check the config is valid.

    var message = null;

    if (!config.bindIPAddress)
      message = 'Missing bindIPAddress';
    else if (!config.peerIPAddress)
      message = 'Missing peerIPAddress';
    else if (!config.floatingIPAddress)
      message = 'Missing floatingIPAddress';
    else if (!config.apiToken)
      message = 'Missing apiToken';

    if (message) {
      logError(message + ' parameter in configuration, exiting...');
      return process.exit();
    }

  })
  .then(function () {

    // Get droplet id.

    return makeRequest('get', DROPLET_ID_URL)
    .catch(function (err) {
      logError(err);
      logError('Failed to get droplet id, exiting...');
      return process.exit();
    });

  })
  .then(function (response) {

    // Store droplet id.

    config.dropletId = response;

    // Create a new server to listen for heartbeats.

    var deferred = Q.defer();

    http.createServer(function (req, res) {
      res.end('OK');
      log('Responded to heartbeat request from peer (' + req.ip + ')');
    }).listen(config.bindPort, config.bindIPAddress, function (err) {

      if (!err)
        return deferred.resolve();

      // Problem starting server - log error and exit.

      logError(err);
      logError('Failed to start heartbeat server, exiting...');
      return process.exit();

    });

    return deferred.promise;

  })
  .then(function () {

    // Set timeout for initial heartbeat with delay.

    var delaySeconds = config.heartbeatInitialDelayMs / 1000;

    log('Heartbeat server started OK');
    log('First heartbeat will be sent in ' + delaySeconds + 's...');

    setTimeout(doHeartbeat, config.heartbeatInitialDelayMs);

  })
  .catch(function (err) {
    logError(err);
    logError('Setup failed, exiting...');
    return process.exit();
  });

})();
