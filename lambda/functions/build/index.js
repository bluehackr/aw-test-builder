var utils = require('./utils')
var log = require('./utils/log')
var config = require('./utils/config')
var actions = require('./actions')

exports.handle = function(event, context, cb) {
    log.init(config.FUNCTION_NAME + ' v' + config.VERSIN + ' triggered \n');

    if (typeof actions[event.action] == 'function') {
        return actions[event.action](event, context, cb)
    }

    log.error('Unknown event, ignoring:\n%j', event)
    return cb(new Error("Unknown event"));
}
