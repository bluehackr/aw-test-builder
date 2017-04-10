var config = require('../utils/config')

exports.version = function(event, context, cb) {
    return cb(null, config.VERSION)
}

exports.build = require('./build')

exports.rebuild = require('./rebuild')
