var debug = require('debug')('bitcoin-gateway:confirmed');
var lodash = require('lodash');
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var async = require('async');
var Bitcoin = require('bitcoin').Client;

function Confirmed(opts) {
  this.opts = lodash.defaults(opts, {
    bitcoin: {},
    minConf: 1,
    interval: 10e3,
    loadHeight: null,
    persistHeight: null,
  });

  this.bitcoin = new Bitcoin(this.opts.bitcoin);

  this.opts.loadHeight(
    function(err, height) {
      if (err) {
        this.emit('error', new Error('Failed to load height: ' + err.message));
        return;
      }
      debug('scanned height loaded: %s', height);
      this.scannedHeight = height;
      this.scan();
    }.bind(this)
  );
}

inherits(Confirmed, EventEmitter);

Confirmed.prototype.schedule = function() {
  if (this.stopRequested) return;
  debug('scanning again in %ss', this.opts.interval / 1e3);
  this.scanTimer = setTimeout(this.scan.bind(this), this.opts.interval);
};

Confirmed.prototype.stop = function() {
  if (this.scanTimer) {
    clearTimeout(this.scanTimer);
    return;
  }
  this.stopRequested = true;
};

Confirmed.prototype.scanHeight = function(n, cb) {
  async.waterfall(
    [
      this.bitcoin.getBlockHash.bind(this.bitcoin, n),
      function(hash, headers, cb) {
        this.bitcoin.getBlock(hash, cb);
      }.bind(this),
      function(block, headers, cb) {
        this.processBlock(block, cb);
      }.bind(this),
      this.opts.persistHeight.bind(this, n),
    ],
    function(err) {
      if (err) return cb(err);
      debug('Finished with block #%d', n);
      this.scannedHeight = n;
      cb();
    }.bind(this)
  );
};

Confirmed.prototype.scan = function() {
  this.scanTimer = null;

  this.bitcoin.getBlockCount(
    function(err, networkHeight) {
      if (err) {
        this.emit('error', new Error('Failed to get block count from bitcoind: ' + err.message));
        this.schedule();
        return;
      }

      debug('network height: %s', networkHeight);

      var n = this.scannedHeight + 1;

      async.whilst(
        function() {
          return n + (this.opts.minConf - 1) <= networkHeight;
        }.bind(this),
        function(cb) {
          this.scanHeight(n++, cb);
        }.bind(this),
        function(err) {
          if (err) {
            this.emit('error', new Error('Failed to scan: ' + err.message + err.stack));
            this.schedule();
            return;
          }
          this.schedule();
        }.bind(this)
      );
    }.bind(this)
  );
};

Confirmed.prototype.fetchTx = function(txid, cb) {
  this.bitcoin.getRawTransaction(
    txid,
    function(err, raw) {
      if (err) return cb(err);
      this.bitcoin.decodeRawTransaction(raw, cb);
    }.bind(this)
  );
};

Confirmed.prototype.processTx = function(tx, cb) {
  if (!tx.txid) {
    return cb(new Error('txid missing'));
  }

  if (tx.version !== 1 && tx.version !== 2) {
    debug('ignoring tx %s with version %s', tx.txid, tx.version);
    return cb();
  }

  if (tx.locktime < 0) {
    return cb(new Error('unexpected locktime ' + tx.locktime));
  }

  async.each(
    tx.vout,
    function(o, cb) {
      this.processOutput(tx.txid, o, function(err) {
        if (!err) return cb();
        cb(new Error('failed to process output #' + o.n + ': ' + err.message));
      });
    }.bind(this),
    cb
  );
};

Confirmed.prototype.processBlock = function(block, cb) {
  debug('processing %d transactions', block.tx.length);

  async.eachLimit(
    block.tx,
    3,
    function(txid, cb) {
      this.fetchTx(
        txid,
        function(err, tx) {
          if (err) return cb(err);

          this.processTx(tx, function(err) {
            if (!err) return cb();
            cb(
              new Error(
                format(
                  'failed to process %s: %s:\n%s',
                  txid,
                  err.message,
                  util.inspect(tx, { depth: null })
                )
              )
            );
          });
        }.bind(this)
      );
    }.bind(this),
    cb
  );
};

Confirmed.prototype.processOutput = function(txid, o, cb) {
  if (typeof o.n != 'number') {
    return cb(new Error('output index missing'));
  }

  if (o.n < 0) {
    return cb(new Error('output index < 0'));
  }

  if (typeof o.value != 'number') {
    return cb(new Error('output value missing'));
  }

  if (o.value < 0) {
    return cb(new Error('output value < 0'));
  }

  var scp = o.scriptPubKey;

  if (!scp) {
    return cb(new Error('scriptPubKey missing'));
  }

  if (scp.type != 'pubkeyhash') {
    debug('ignoring non-pubkeyhash (%s) of %s:%s', scp.type || '<none>', txid, o.n);
    return cb();
  }

  if (!scp.asm) {
    return cb(new Error('script missing'));
  }

  if (!scp.asm.match(/^OP_DUP OP_HASH160 [a-z0-9]{40} OP_EQUALVERIFY OP_CHECKSIG$/)) {
    return cb(new Error('unstandard transaction ' + scp.asm));
  }

  if (!scp.addresses) {
    return cb(new Error('addresses missing from scriptPubKey'));
  }

  if (scp.addresses.length != 1) {
    return cb(new Error('unexpected number of addresses ' + scp.addresses.length));
  }

  var address = o.scriptPubKey.addresses[0];

  debug('%s to %s', o.value, address);

  this.emit('output', {
    hash: txid,
    address: address,
    value: o.value.toString(),
    outputNumber: o.n,
  });

  cb();
};

module.exports = Confirmed;

// new Confirmed({
// 	bitcoin: {
// 		host: '54.154.39.233',
// 		user: 'user',
// 		pass: 'password'
// 	},

// 	persistHeight: function(x, cb) {
// 		require('fs').writeFileSync('confirmed.json', JSON.stringify({ height: x }, null, 4), 'utf8')
// 		cb()
// 	},

// 	loadHeight: function(cb) {
// 		if (!require('fs').existsSync('confirmed.json')) return cb(null, null)
// 		cb(null, require('./confirmed.json').height)
// 	}
// })
