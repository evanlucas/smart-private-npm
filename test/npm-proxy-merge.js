var common = require('./fixtures/common')
  , request = require('request')
  , url = require('url')
  , http = require('http')
  , server

var Proxy = process.env.SPNPM_COV
  ? require('../lib-cov').Proxy
  : require('../lib').Proxy

// noop log
var log = {
  info: function() {},
  warn: function() {},
  error: function() {}
}

var options = {
  npm: url.parse(common.public.url),
  policy: {
    npm: url.parse(common.private.url),
    private: {
      'priv-basic-ok': 1,
      'priv-invalid': 1
    },
    blacklist: {},
    transparent: false
  },
  log: log
}

var proxy = new Proxy(options)

describe('merge', function() {
  before(function(done) {
    server = http
                .createServer(proxy.merge.bind(proxy))
                .listen(common.port, done)
  })

  after(function(done) {
    server.on('close', done)
    server.close()
  })

  describe('json', function() {
    it('should merge the two json responses', function(done) {
      var opts = {
        uri: common.host + '/merge/json',
        json: true
      }
      request.get(opts, common.mergeOk(done))
    })
  })

  describe('text', function() {
    it('should merge the two text responses', function(done) {
      var opts = {
        uri: common.host + '/merge/txt'
      }
      request.get(opts, common.mergeOkTxt(done))
    })
  })
})
