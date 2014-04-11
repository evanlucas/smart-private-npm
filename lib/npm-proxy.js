/*
 * npm-proxy.js: Smart, prototypal proxy for routing traffic between _the_ public npm and _a_ private npm.
 *
 * (C) 2013, Nodejitsu Inc.
 *
 */

var httpProxy = require('http-proxy'),
    request = require('request').defaults({ strictSSL: false }),
    JSONStream = require('JSONStream'),
    util = require('util'),
    url_ = require('url');

//
// ### function NpmProxy (options)
// #### @options {Object} Options for initializing the proxy
// ####   @npm     {Array|string} Public npm CouchDBs we are proxying against.
// ####   @policy  {Object} Default policy
// ####     - npm         {url.parse} Private npm CouchDB we are proxying against.
// ####     - transparent {boolean}   If true: always behaves as a pass-thru to public npm(s).
// ####     - private     {Object}    Set of initial private modules.
// ####     - blacklist   {Object}    Set of initial blacklisted modules.
// ####     - whitelist   {Object}    Set of iniitial whitelisted modules.
// ####   @writePrivateOk {function}  **Optional** Predicate for writing new private packages.
// ####   @log            {function}  **Optional** Log function. Defaults to console.
//
// Constructor function for the NpmProxy object responsible for
// making proxy decisions between multiple npm registries.
//
var NpmProxy = module.exports = function (options) {
  var self = this;

  //
  // URL to CouchDB and the proxy instance to use.
  //
  this.npm = options.npm;
  this.log = options.log || console;

  //
  // Remark: if we dont have a specific read/write url,
  // assume we either have an array or an url.parsed object
  //
  this.interval   = options.interval || 60 * 15 * 1000;
  this.currentNpm = this.npm && this.npm.read || this.npm;
  this.isUrlArray(this.npm.read || this.npm);
  //
  // Default these values if there is no read/write
  //
  this.writeNpm = this.npm.write || this.currentNpm;

  //
  // Setup the http-proxy instance to handle bad respones
  // and allow lax SSL.
  //
  this.proxy  = httpProxy.createProxyServer({ secure: false });
  this.proxy.on('error', this.onProxyError.bind(this));

  //
  // Handler for decoupling any authorization logic
  // for new private packages from the proxy itself.
  //
  this.writePrivateOk = options.writePrivateOk;

  //
  // Set the policy
  //
  if (options.policy) {
    this.setPolicy(options.policy);
  }
};

//
// ### function isUrlArray(urls)
// Handles the case where we have an array of urls so its reusable
//
NpmProxy.prototype.isUrlArray = function (urls) {
  //
  // Begin cycling public npm URLs only if it is an Array
  // we can cycle through.
  //
  if (Array.isArray(urls)) {
    if (urls.length === 1) {
      this.currentNpm = urls[0]
    }
    else {
      this.currentNpm = null;
      this.nextPublicNpm(urls);
      this.intervalId = setInterval(
        this.nextPublicNpm.bind(this, urls),
        this.interval
      );
    }
  }
};

//
// ### function setPolicy (policy)
// Sets the specified `policy` on this instance
//
NpmProxy.prototype.setPolicy = function (policy) {
  //
  // Remark: Pre-transformed the policy Arrays into Objects
  // for fast lookup.
  //
  this.policy           = policy;
  this.policy.blacklist = this.policy.blacklist || {};
  if (this.policy.transparent) {
    this.private =
    this.decide  =
    this.merge   =
      this.public;
  }
};

//
// ### function nextPublicNpm ()
// Sets the current public npm to a random
// selection (without replacement).
//
NpmProxy.prototype.nextPublicNpm = function (urls) {
  var index   = Math.random() * urls.length | 0,
      lastNpm = this.currentNpm;

  this.currentNpm = urls.splice(index, 1)[0];
  this.log.info('[public npm] %s --> %s', (lastNpm && lastNpm.href) || 'none', this.currentNpm.href);
  if (lastNpm) {
    urls.push(lastNpm);
  }
};

//
// ### function public (req, res, policy)
// #### @req {ServerRequest}  Incoming Request to the npm registry
// #### @res {ServerResponse} Outgoing Response to the npm client
//
// Make a proxy request to `url` against the public
// npm registry and stream the response back to the `res`.
//
NpmProxy.prototype.public = function (req, res) {
  var address = req.connection.remoteAddress || req.socket.remoteAddress,
      method = req.method.toLowerCase(),
      host,
      npm;

  npm = method !== 'put' && method !== 'delete'
    ? this.currentNpm
    : this.writeNpm;

  host = npm.vhost || npm.hostname;

  this.log.info('[public] %s - %s %s %s %j', address, req.method, req.url, host, req.headers);
  req.headers.host = host;

  this.proxy.web(req, res, {
    target: npm.href
  });
};

//
// ### function private (req, res, policy)
// #### @req {ServerRequest}  Incoming Request to the npm registry
// #### @res {ServerResponse} Outgoing Response to the npm client
// #### @policy {Object} Policy info with admin and private npm dbs.
//
// Make a proxy request to `url` against the private
// npm registry and stream the response back to the `res`.
//
NpmProxy.prototype.private = function (req, res, policy) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;
  if (policy.transparent) {
    return this.public(req, res);
  }

  var address = req.connection.remoteAddress || req.socket.remoteAddress,
      host = policy.npm.vhost || policy.npm.hostname;

  this.log.info('[private] %s - %s %s %s %j', address, req.method, req.url, host, req.headers);
  req.headers.host = host;

  this.proxy.web(req, res, {
    target: policy.npm.href
  });
};

//
// ### function decide (req, res, policy)
// #### @req {ServerRequest}  Incoming Request to the npm registry
// #### @res {ServerResponse} Outgoing Response to the npm client
// #### @policy {Object} Policy info with admin and private npm dbs.
//
// For the `pkg` requested, based on the:
//
// * Whitelist policy
// * Blacklist policy
// * Known private packages
//
// decide whether to proxy to the public or private npm
// registry and then stream the response back to the res
// from whatever registry was selected.
//
NpmProxy.prototype.decide = function (req, res, policy) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;
  if (policy.transparent) {
    return this.public(req, res);
  }

  var address  = req.connection.remoteAddress || req.socket.remoteAddress,
      url      = req.url,
      method   = req.method.toLowerCase(),
      pkg      = url.slice(1).split('?').shift().split('/').shift(),
      proxy    = this.proxy,
      self     = this,
      decideFn;

  //
  // Proxy or serve not found based on the decision
  //
  function onDecision(err, target) {
    //
    // If there was no target then this is a 404 by definition
    // even if it exists in the public registry because of a
    // potential whitelist.
    //
    if (err || !target) {
      return self.notFound(req, res, err || { message: 'Unknown pkg: ' + pkg });
    }
    //
    // If we get a valid target then we can proxy to it
    //
    self.log.info('[decide] %s - %s %s %s %j', address, req.method, req.url, target.vhost || target.hostname, req.headers);
    req.headers.host = target.vhost || target.hostname;
    proxy.web(req, res, {
      target: target.href
    });
  }

  //
  // Calculate the decision function based on the HTTP
  // method. We could potentially optimize this by having two
  // deicison functions since the readUrl method(s) do not
  // have an async-nature.
  //
  // The choice of `standard{Read,Write}Url` vs `whitelist{Read,Write}Url`
  // is an important distinction here because the logic is
  // so drastically different between whitelist and not.
  //
  if (method === 'get' || method === 'head') {
    return policy.whitelist
      ? this.whitelistReadUrl(pkg, policy, onDecision)
      : this.standardReadUrl(pkg, policy, onDecision);
  }

  return policy.whitelist
    ? this.whitelistWriteUrl(pkg, policy, onDecision)
    : this.standardWriteUrl(pkg, policy, onDecision);
};

//
// ### function notFound (req, res)
// Simple 404 handler.
//
NpmProxy.prototype.notFound = function (req, res, err) {
  var address = req.connection.remoteAddress || req.socket.remoteAddress,
      code    = err ? 400 : 404,
      json;

  if (!err) { global.console.trace(); }
  err = err || { message: 'Unknown error' };
  this.log.error('[not found] %s - %s %s %s %j', address, req.method, req.url, err.message, req.headers);

  res.writeHead(code, { 'content-type': 'application/json' });
  json = { error: 'not_found', reason: err.message };
  res.end(JSON.stringify(json));
};

//
// ### function standardReadUrl (pkg, policy, callback)
// #### @pkg {string} npm package to get the read URL for.
// #### @policy {Object} Policy info with admin and private npm dbs.
// Calculates the target read (i.e. GET or HEAD) URL based on the
// `pkg`, `this.policy` and `this.npm` targets.
//
NpmProxy.prototype.standardReadUrl = function (pkg, policy, callback) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;

  //
  // There **IS NO WHITELIST** so if it is already a known private package
  // or part of a blacklist then proxy directly to the private npm.
  //
  if (policy.private[pkg] || policy.blacklist[pkg]) {
    return callback(null, policy.npm);
  }

  //
  // Otherwise send it to the public npm
  //
  return callback(null, this.currentNpm);
};

//
// ### function standardWriteUrl (pkg, callback)
// #### @pkg {string} npm package to get the read URL for.
// #### @policy {Object} Policy info with admin and private npm dbs.
// Calculates the target read (i.e. PUT or POST) URL based on the
// `pkg`, `this.policy` and `this.npm` targets..
//
NpmProxy.prototype.standardWriteUrl = function (pkg, policy, callback) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;

  var writeOk = this.writePrivateOk,
      self    = this,
      err;

  //
  // There **IS NO WHITELIST** so if it is already a known private package
  // or part of a blacklist then proxy directly to the private npm.
  //
  if (policy.private[pkg] || policy.blacklist[pkg]) {
    return callback(null, policy.npm);
  }

  //
  // Otherwise we need to look this package in the public registry
  // - if it does not exist we proxy to the private registry
  // - if it does exist then we proxy to the public registry
  //
  request({ url: this.writeNpm.href + '/' + pkg })
    .on('error', callback)
    .on('response', function (res) {
      if (res.statusCode == 404) {
        if (writeOk) {
          err = writeOk(policy, self);
          if (err) {
            return callback(err);
          }
        }

        policy.private[pkg] = true;
        return callback(null, policy.npm);
      }

      return callback(null, self.writeNpm);
    });
};

//
// ### function whitelistReadUrl (pkg, callback)
// #### @pkg {string} npm package to get the read URL for.
// #### @policy {Object} Policy info with admin and private npm dbs.
// Calculates the target read (i.e. GET or HEAD) URL based on the
// `pkg`, `this.policy` and `this.npm` targets.. Assumes there is
// a whitelist by default.
//
NpmProxy.prototype.whitelistReadUrl = function (pkg, policy, callback) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;

  //
  // There **IS A WHITELIST** so if it is in the whitelist proxy to the
  // public registry
  //
  if (policy.whitelist[pkg]) {
    return callback(null, this.currentNpm);
  }

  //
  // If it is already a known private package or part of a blacklist
  // then proxy directly to the private npm.
  //
  if (policy.private[pkg] || policy.blacklist[pkg]) {
    return callback(null, policy.npm);
  }

  //
  // Otherwise it is FORBIDDEN!
  //
  return callback(new Error('Your whitelist policy prevents you from getting ' + pkg));
};

//
// ### function whitelistWriteUrl (pkg, callback)
// #### @pkg {string} npm package to get the read URL for.
// #### @policy {Object} Policy info with admin and private npm dbs.
// Calculates the target read (i.e. GET or HEAD) URL based on the
// `pkg`, `this.policy` and `this.npm` targets.. Assumes there is
// a whitelist by default.
//
NpmProxy.prototype.whitelistWriteUrl = function (pkg, policy, callback) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;

  var writePrivateOk = this.writePrivateOk,
      limits         = policy && policy.limits,
      self           = this;

  //
  // There **IS A WHITELIST** so if it is in the whitelist proxy to the
  // public registry
  //
  if (policy.whitelist[pkg]) {
    return callback(null, this.writeNpm);
  }

  //
  // If it is already a known private package or part of a blacklist
  // then proxy directly to the private npm.
  //
  if (policy.private[pkg] || policy.blacklist[pkg]) {
    return callback(null, policy.npm);
  }

  //
  // Otherwise we need to look this package in the public registry
  // - if it does not exist we proxy to the private registry
  // - if it does exist then we 404
  //
  request({ url: this.writeNpm.href + '/' + pkg })
    .on('error', callback)
    .on('response', function (res) {
      if (res.statusCode == 404) {
        if (limits && limits.private && Object.keys(policy.private).length >= limits.private) {
          return callback(new Error('Out of private packages. Have you considered upgrading?'));
        }

        policy.private[pkg] = true;
        return callback(null, policy.npm);
      }

      //
      // Otherwise it is FORBIDDEN.
      //
      return callback(new Error('Your whitelist policy prevents you from writing ' + pkg));
    });
};

//
// ### function merge (req, res)
// #### @req {ServerRequest}  Incoming Request to the npm registry
// #### @res {ServerResponse} Outgoing Response to the npm client
// #### @policy {Object} Policy info with admin and private npm dbs.
//
// Concurrently request `/url` against the public
// and private npm registry and stream the JSON
// merged responses back to `res` as a single
// JSON object.
//
NpmProxy.prototype.merge = function (req, res, policy) {
  //
  // Always default to a set policy. This enables the
  // the enterprise case only one policy enforced.
  //
  policy = policy || this.policy;

  var address = req.connection.remoteAddress || req.socket.remoteAddress,
      method  = req.method,
      url     = req.url,
      self    = this,
      contentTypes = {},
      responses    = {},
      body;

  //
  // ### function fixSearch (u)
  // Strips the querystring from `u`. This makes
  // private searches always do a full search.
  // This must be done because the startkey will be cached by npm
  // from the response from the public registry
  //
  function fixSearch(u) {
    if (/\?stale=update_after&startkey=([\d]+)/.test(u)) {
      var idx = u.indexOf('?');
      if (~idx) return u.substr(0, idx);
    }
    return u;
  }

  //
  // ### function makeRequest (target)
  // Makes a request to `req.url` to the
  // specified target.
  //
  function makeRequest(target) {
    var headers = Object.keys(req.headers)
      .reduce(function (all, key) {
        all[key] = req.headers[key];
        return all;
      }, {});

    //
    // Set the correct host header.
    //
    headers.host = target.host;

    self.log.info('[merge] %s - %s %s %s %j', address, req.method, req.url, target.host, req.headers);
    var u = url_.resolve(target.href, url);
    if (target.href === policy.npm.href) u = fixSearch(u);
    return request({
      url:     u,
      method:  method,
      headers: headers
    });
  }

  //
  // ### function onResponse (type, pRes)
  // Sets the content type from the proxy
  // response.
  //
  function onResponse(type, pRes) {
    contentTypes[type] = pRes.headers['content-type'].split(';')[0];
    responses[type]    = pRes,
    isJson = contentTypes[type] === 'application/json';

    if (isJson) {
      var jsonStream = JSONStream.parse();
      pRes.pipe(jsonStream);
      jsonStream.on('error', function(err) {
        // TODO
        // handle error
        self.log.error('json error', err);
      });

      jsonStream.on('data', function(d) {
        if (!body) body = {};
        if (type === 'private') {
          body = util._extend(body, d);
        } else {
          body = util._extend(d, body);
        }
      });

      jsonStream.on('end', function() {
        if (responses.public && responses.private) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        }
      });
    } else {
      if (!body) body = '';
      pRes.on('data', function(d) {
        body += d+'\n';
      });
      pRes.on('end', function() {
        if (responses.public && responses.private) {
          res.writeHead(200, { 'content-type': contentTypes['public']});
          res.end(body);
        }
      });
    }

    //
    // If we have both a public and a private
    // response.
    //
    if (responses.public && responses.private) {
      if (contentTypes.public !== contentTypes.private) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Content-Type mismatch: ' + JSON.stringify(contentTypes));
      }
    }
  }

  makeRequest(policy.npm)
    .on('response', onResponse.bind(null, 'private'));

  makeRequest(this.currentNpm)
    .on('response', onResponse.bind(null, 'public'));
};

//
// ### function onProxyError (err, req, res)
// `http-proxy` "error" event handler
//
NpmProxy.prototype.onProxyError = function (err, req, res) {
  var address = req.connection.remoteAddress || req.socket.remoteAddress,
      code    = res.statusCode || 500,
      json;

  this.log.error('[proxy error] %s - %s %s %s %j', address, req.method, req.url, err.message, req.headers);

  if (!res.headersSent) {
    res.writeHead(code, { 'content-type': 'application/json' });
  }

  json = { error: 'proxy_error', reason: err.message };
  res.end(JSON.stringify(json));
};
