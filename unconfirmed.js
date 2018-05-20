var ReconWs = require('recon-ws')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var debug = require('debug')('bitcoin-gateway:unconfirmed')
var assert = require('assert')

function Unconfirmed(open) {
	if (open === false) return
	this.open()
}

inherits(Unconfirmed, EventEmitter)

Unconfirmed.prototype.open = function() {
	if (this.socket) throw new Error('Already open')
	this.socket = new ReconWs('wss://ws.blockchain.info/inv')
	this.socket.on('open', this.socketOpen.bind(this))
	this.socket.on('message', this.socketMessage.bind(this))
}

Unconfirmed.prototype.socketOpen = function() {
	this.socket.send(JSON.stringify({ op: 'unconfirmed_sub' }))
}

Unconfirmed.prototype.socketMessage = function(msg) {
	msg = JSON.parse(msg)
	if (msg.op != 'utx') return debug('ignoring op %s', msg.op)
	var inner = msg.x
	if (inner.ver != 1) return debug('ignoring tx ver %s', inner.ver)
	if (inner.lock_time !== 0) return debug('ignoring lock time %s', inner.lock_time)

	inner.out.forEach(function(out) {
		if (out.type !== 0) return debug('ignoring out type %s', out.type)
		if (!out.addr) return

		assert.equal(typeof out.addr, 'string')
		assert.equal(typeof out.value, 'number')
		assert((out.value % 1) === 0, out.value)

		this.emit('output', {
			address: out.addr,
			value: (out.value / 1e8).toFixed(8)
		})
	}.bind(this))
}

Unconfirmed.prototype.close = function() {
	if (!this.socket) return
	this.socket.close()
	this.socket = null
}

module.exports = Unconfirmed
