var path = require('path')
var EventEmitter = require('events')
var spawn = require('child_process').spawn
var async = require('async')
var AWS = require('aws-sdk')
var utils = require('../utils')
var log = require('../utils/log')
var config = require('../utils/config')
var db = require('../db')
var github = require('../sources/github')
var slack = require('../notifications/slack')
var sns = require('../notifications/sns')

module.exports = runBuild

AWS.config.update({accessKeyId:process.env.AWS_ACCESS_KEY_ID, secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY});
AWS.config.update({region:process.env.AWS_REGION});


function runBuild(buildData, context, cb) {
    var build = new BuildInfo(buildData, context)

    build.config = config.initConfig(buildData, build)

    config.initSync(build.config)

    cloneAndBuild(build, cb)
}

function BuildInfo(buildData, context) {
    this.startedAt = new Date()
    this.endedAt = null

    this.status = 'pending'
    this.statusEmitter = new EventEmitter()

    // Any async functions to run on 'finish' should be added to this array,
    // and be of the form: function(build, cb)
    this.statusEmitter.finishTasks = []

    this.project = config.FUNCTION_NAME;
    this.buildNum = config.FUNCTION_BUILDNUM || 0;

    this.repo = buildData.repo || 'Undefined repository';

    if (buildData.trigger) {
        var triggerPieces = buildData.trigger.split('/')
        this.trigger = buildData.trigger
        this.eventType = triggerPieces[0] == 'pr' ? 'pull_request' : 'push'
        this.prNum = triggerPieces[0] == 'pr' ? +triggerPieces[1] : 0
        this.branch = triggerPieces[0] == 'push' ? triggerPieces[1] : (buildData.branch || 'master')
    } else {
        this.eventType = buildData.eventType
        this.prNum = buildData.prNum
        this.branch = buildData.branch
        this.trigger = this.prNum ? `pr/${this.prNum}` : `push/${this.branch}`
    }

    this.event = buildData.event
    this.isPrivate = buildData.isPrivate
    this.isRebuild = buildData.isRebuild

    this.branch = buildData.branch || 'master'
    this.cloneRepo = buildData.cloneRepo || this.repo
    this.checkoutBranch = buildData.checkoutBranch || this.branch
    this.commit = buildData.commit
    this.baseCommit = buildData.baseCommit
    this.comment = buildData.comment
    this.user = buildData.user

    this.isFork = this.cloneRepo != this.repo

    this.committers = buildData.committers

    this.config = null
    this.cloneDir = path.join(config.BASE_BUILD_DIR, this.repo)

    this.requestId = context.awsRequestId
    this.logGroupName = context.logGroupName
    this.logStreamName = context.logStreamName

    this.token = ''
    this.logUrl = ''
    this.lambdaLogUrl = ''
    this.buildDirUrl = ''
    this.error = null
}

function cloneAndBuild(build, cb) {

    clone(build, function(err) {
        if (err) return cb(err)

        console.log(build);
        // Now that we've cloned the repository we can check for config files
        build.config = config.prepareBuildConfig(build)

        if (!build.config.build) {
            log.info('config.build set to false – not running build')
            return cb()
        }

        db.initBuild(build, function(err, build) {
            if (err) return cb(err)

            log.info('')
            log.info(`Build #${build.buildNum} started...\n`)

            build.logUrl = log.initBuildLog(build)

            log.info(`Build log: ${build.logUrl}\n`)

            if (build.token) {
                github.createClient(build)
            }

            //TODO: To implement slack notification
            // if (build.config.notifications.slack && build.config.secretEnv.SLACK_TOKEN) {
            //     slack.createClient(build.config.secretEnv.SLACK_TOKEN, build.config.notifications.slack, build)
            // }

            //TODO: To implement SNS
            // if (build.config.notifications.sns) {
            //     sns.createClient(build.config.notifications.sns, build)
            // }

            var done = patchUncaughtHandlers(build, cb)

            build.statusEmitter.emit('start', build)

            // TODO: must be a better place to put this?
            build.config.env.LAMBCI_BUILD_NUM = build.buildNum

            console.log("before lambdaBuild");
            if (build.config.docker) {
                //dockerBuild(build, done)
            } else {
                lambdaBuild(build, done)
            }
        })
    })
}

function patchUncaughtHandlers(build, cb) {
    var origListeners = process.listeners('uncaughtException')
    var done = utils.once(function(err) {
        process.removeListener('uncaughtException', done)
        origListeners.forEach(listener => process.on('uncaughtException', listener))
        build.error = err
        buildDone(build, cb)
    })
    process.removeAllListeners('uncaughtException')
    process.on('uncaughtException', done)
    return done
}

function buildDone(build, cb) {

    // Don't update statuses if we're doing a docker build and we launched successfully
    if (!build.error && build.config.docker) return cb()

    log.info(build.error ? `Build #${build.buildNum} failed: ${build.error.message}` :
        `Build #${build.buildNum} successful!`)

    build.endedAt = new Date()
    build.status = build.error ? 'failure' : 'success'
    build.statusEmitter.emit('finish', build)

    var finishTasks = build.statusEmitter.finishTasks.concat(db.finishBuild)

    async.forEach(finishTasks, (task, cb) => task(build, cb), function(taskErr) {
        log.logIfErr(taskErr)
        cb(build.error)
    })
}

function clone(build, cb) {
    console.log("clone");

    // Just double check we're in tmp!
    if (build.cloneDir.indexOf(config.BASE_BUILD_DIR) !== 0) {
        return cb(new Error(`clone directory ${build.cloneDir} not in base directory ${config.BASE_BUILD_DIR}`))
    }

    build.token = build.config.secretEnv.GITHUB_TOKEN

    var cloneUrl = `https://github.com/${build.cloneRepo}.git`, maskCmd = cmd => cmd
    if (build.isPrivate && build.token) {
        cloneUrl = `https://${build.token}@github.com/${build.cloneRepo}.git`
        maskCmd = cmd => cmd.replace(new RegExp(build.token, 'g'), 'XXXX')
    }

    var depth = build.isRebuild ? '' : `--depth ${build.config.git.depth}`
    var cloneCmd = `git clone ${depth} ${cloneUrl} -b ${build.checkoutBranch} ${build.cloneDir}`
    // var checkoutCmd = `cd ${build.cloneDir} && git checkout -qf ${build.commit}`

    // Bit awkward, but we don't want the token written to disk anywhere
    if (build.isPrivate && build.token && !build.config.inheritSecrets) {
        cloneCmd = [
            `mkdir -p ${build.cloneDir}`,
            `cd ${build.cloneDir} && git init && git pull ${depth} ${cloneUrl} ${build.checkoutBranch}`,
        ]
    }

    // No caching of clones for now – can revisit this if we want to – but for now, safer to save space
    //var cmds = [`rm -rf ${config.BASE_BUILD_DIR}`].concat(cloneCmd, checkoutCmd)
    var cmds = [`rm -rf ${config.BASE_BUILD_DIR}`].concat(cloneCmd)

    var env = prepareLambdaConfig({}).env
    var runCmd = (cmd, cb) => runInBash(cmd, {env: env, logCmd: maskCmd(cmd)}, cb)

    console.log(cmds.length);
    console.log(env);

    async.forEachSeries(cmds, runCmd, cb)
}

function lambdaBuild(build, cb) {

    console.log("lambdaBuild");
    build.config = prepareLambdaConfig(build.config)

    console.log('cloneDir = ' + build.cloneDir);
    var opts = {
        cwd: build.cloneDir,
        env: config.resolveEnv(build.config),
    }

    var child_process = require('child_process');
    console.log(child_process.execSync('find /usr -name npm -type f', {encoding: 'utf-8'}));

    var cmds = ['npm install -d', "./node_modules/mocha/bin/mocha test"];
    var runCmd = (cmd, cb) => runInBash(cmd, opts, cb)

    async.forEachSeries(cmds, runCmd, cb)
    // runInBash(build.config.cmd, opts, cb)
}

function runInBash(cmd, opts, cb) {
    // Would love to create a pseudo terminal here (pty), but don't have permissions in Lambda
    /*
     var proc = require('pty.js').spawn('/bin/bash', ['-c', config.cmd], {
     name: 'xterm-256color',
     cwd: cloneDir,
     env: env,
     })
     proc.socket.setEncoding(null)
     if (proc.socket._readableState) {
     delete proc.socket._readableState.decoder
     delete proc.socket._readableState.encoding
     }
     */
    console.log("runInBash");
    var logCmd = opts.logCmd || cmd
    delete opts.logCmd

    console.log('bok--------1 ' + logCmd);
    log.info(`$ ${logCmd}`)
    var proc = spawn('/bin/bash', ['-c', cmd ], opts)
    proc.stdout.pipe(utils.lineStream(log.info))
    proc.stderr.pipe(utils.lineStream(log.error))
    // proc.on('error', cb)
    proc.on('error', function (err) {
        console.log(err)
        cb(err);
    });

    proc.on('close', function(code) {
        var err
        console.log("bok 1");
        if (code) {
            console.log("bok 2: code = " + code);
            err = new Error(`Command "${logCmd}" failed with code ${code}`)
            err.code = code
            err.logTail = log.getTail()
        }
        cb(err)
    })
}

// For when executing under Lambda (but not ECS/Docker)
function prepareLambdaConfig(buildConfig) {

    var vendorDir = path.join(__dirname, '../vendor')
    var pythonDir = path.join(vendorDir, 'python')
    var usrDir = path.join(config.HOME_DIR, 'usr')
    var defaultLambdaConfig = {
        env: {
            HOME: config.HOME_DIR,
            SHELL: '/bin/bash',
            PATH: [
                path.join(config.HOME_DIR, '.local/bin'),
                path.join(usrDir, 'bin'),
                path.join(pythonDir, 'bin'),
                path.join(__dirname, '../node_modules/.bin'),
                process.env.PATH,
            ].join(':'),
            LD_LIBRARY_PATH: [
                path.join(usrDir, 'lib64'),
                process.env.LD_LIBRARY_PATH,
            ].join(':'),
            NODE_PATH: process.env.NODE_PATH,
            PYTHONPATH: path.join(pythonDir, 'lib/python2.7/site-packages'),
            GIT_TEMPLATE_DIR: path.join(usrDir, 'share/git-core/templates'),
            GIT_EXEC_PATH: path.join(usrDir, 'libexec/git-core'),

            // To try to get colored output
            TERM: 'xterm-256color',
            FORCE_COLOR: true,
            NPM_CONFIG_COLOR: 'always',
            MOCHA_COLORS: true,
        },
        secretEnv: {
            AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
            AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
            AWS_REGION: process.env.AWS_REGION,
        },
    }

    // Treat PATH variables specially
    var pathEnvVars = ['PATH', 'LD_LIBRARY_PATH', 'NODE_PATH']
    pathEnvVars.forEach(key => {
        if (buildConfig.env && buildConfig.env[key]) {
        buildConfig.env[key] = [buildConfig.env[key], defaultLambdaConfig[key]].join(':')
    }
})

    return utils.merge(defaultLambdaConfig, buildConfig)
}
