// Dependencies.

var http    = require('http');
var os      = require('os');
var Q       = require('q');
var _       = require('lodash');
var request = require('request');
var moment  = require('moment');
var colors  = require('colors');
var config  = require('./config/defaults');

// Constants.

var HOSTNAME        = '(' + os.hostname() + ')';
var PUSHOVER_URL    = 'https://api.pushover.net/1/messages.json';
var DROPLET_ID_URL  = 'http://169.254.169.254/metadata/v1/id';
var FIP_ACTIVE_URL  = 'http://169.254.169.254/metadata/v1/floating_ip/ipv4/active';
var FIP_ACQUIRE_URL = 'https://api.digitalocean.com/v2/floating_ips/$floatingIPAddress/actions';

// Variables.

var lastHeartbeat   = null;
var lastAcquisition = null;
var acquireFailures = 0;

// Functions.

function log (message) {
  console.log(moment().format('[[]HH:mm:ss[] ]').white, message.green);
}

function logEmphasis (message) {
  console.log(moment().format('[[]HH:mm:ss[] ]').white, message.bold.cyan);
}

function logWarning (message) {
  message = 'Warning: ' + message;
  console.log(moment().format('[[]HH:mm:ss[] ]').white, message.yellow);
}

function logError (err) {
  console.error(moment().format('[[]HH:mm:ss[] ]').white, err.toString().red);
}

function makeRequest (method, url, options, code) {

  code = code || 200;

  var deferred = Q.defer();
  var timeout  = false;

  options = _.assign(options, {
    url: url,
    followRedirect: false
  });

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
      return deferred.reject(err || ('Invalid status code: ' + res.statusCode));

  });

  return deferred.promise;

}

function sendPushoverAlert(options, retries) {

  if (typeof retries !== 'number')
    retries = 5;

  options = _.assign(options, {
    token : config.pushoverToken,
    user  : config.pushoverUserGroupKey
  });

  makeRequest('post', PUSHOVER_URL, { form: options })
  .then(function () {
    logEmphasis('Successfully sent pushover notification');
  })
  .catch(function (err) {

    logWarning('Failed to send pushover notification');

    if (err instanceof Error)
      logError(err);
    else
      logWarning(err);

    if (retries !== 0) {
      logEmphasis('Re-attempting to send pushover notification in 30s...');
      setTimeout(sendPushoverAlert, 30000, options, retries - 1);
    } else {
      logError('Ran out of attempts to send pushover notification');
    }

  });

}

function panicAlert () {
  logEmphasis('Sending pushover alert for panic event');
  sendPushoverAlert({
    title    : 'Load balancer alert ' + HOSTNAME,
    message  : 'FATAL: Unable to acquire floating IP address from peer',
    priority : 2,
    retry    : 180,
    expire   : 3600
  });
}

function acquireAlert () {
  logEmphasis('Sending pushover alert for acquisition event');
  sendPushoverAlert({
    title   : 'Load balancer alert ' + HOSTNAME,
    message : 'Failover event - acquired floating IP address from peer',
    priority : 2,
    retry    : 180,
    expire   : 3600
  });
}

function acquireIP () {

  // Only attempt to acquire the floating IP if we haven't recently.

  if (lastAcquisition &&
      moment().diff(lastAcquisition) < config.acquireIPDelayMs)
    return;

  logEmphasis('Too many heartbeats missed, checking floating IP assignment...');

  lastAcquisition = moment();

  // Check if the floating IP is already assigned to us.

  makeRequest('get', FIP_ACTIVE_URL)
  .then(function (body) {

    if (body === 'true') {
      lastHeartbeat = moment();
      acquireFailures = 0;
      return logEmphasis('Floating IP is already assigned to us, no action required');
    }

    // Attempt to acquire the floating IP.

    logEmphasis('Attempting to acquire floating IP...');

    var url     =
        FIP_ACQUIRE_URL.replace('$floatingIPAddress', config.floatingIPAddress);
    var data    = { type: 'assign', droplet_id: config.dropletId };
    var headers = {
      'Authorization' : 'Bearer ' + config.apiToken,
      'Content-Type'  : 'application/json'
    };

    var options = {
      headers : headers,
      body    : JSON.stringify(data)
    };

    makeRequest('post', url, options, 201)
    .then(function () {

      lastHeartbeat = moment();
      acquireFailures = 0;
      logEmphasis('Successfully acquired floating IP');
      return acquireAlert();

    }, function (err) {

      acquireFailures++;

      logError('Failed to acquire floating IP');

      if (err instanceof Error)
        logError(err);
      else
        logWarning(err);

      if (acquireFailures === 3)
        panicAlert();

    });
  
  });

}

function heartbeatSuccess () {

  lastHeartbeat = moment();

  log('Received heartbeat response from peer (' + config.peerIPAddress + ')');

}

function heartbeatFailure (reason) {

  logWarning('No heartbeat response received from peer (' +
      config.peerIPAddress + ')');
  if (reason instanceof Error)
    logError(reason);
  else
    logWarning(reason);

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
    else if (!config.pushoverToken)
      message = 'Missing pushoverToken';
    else if (!config.pushoverUserGroupKey)
      message = 'Missing pushoverUserGroupKey';

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

      var ip = '(' + req.connection.remoteAddress + ')';

      if (req.connection.remoteAddress === config.peerIPAddress) {
        res.end('OK');
        return log('Responded to heartbeat request from peer ' + ip);
      } else {
        res.statusCode = 403;
        res.end('Forbidden');
        return logWarning('Rejected heartbeat request from unknown peer ' + ip);
      }

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

    logEmphasis('Heartbeat server started OK');
    logEmphasis('First heartbeat will be sent in ' + delaySeconds + 's...');

    setTimeout(doHeartbeat, config.heartbeatInitialDelayMs);

  })
  .catch(function (err) {
    logError(err);
    logError('Setup failed, exiting...');
    return process.exit();
  });

})();
