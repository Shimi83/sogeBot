'use strict'

const _ = require('lodash')

const constants = require('./constants')
import { debug } from './debug';

class Parser {
  constructor (opts) {
    opts = opts || {}

    this.started_at = new Date().getTime()
    this.message = opts.message || ''
    this.sender = opts.sender || null
    this.skip = opts.skip || false

    if (!_.isNil(this.sender) && opts.quiet) this.sender.quiet = opts.quiet

    this.isCommand = this.message.startsWith('!')
    this.list = this.populateList()
  }

  time () {
    return parseInt(new Date().getTime(), 10) - parseInt(this.started_at, 10)
  }

  async isModerated () {
    if (this.skip) return false

    const parsers = await this.parsers()
    for (let parser of parsers) {
      if (parser.priority !== constants.MODERATION) continue // skip non-moderation parsers
      const opts = {
        sender: this.sender,
        message: this.message.trim(),
        skip: this.skip
      }
      const isOk = await parser['fnc'].apply(parser.this, [opts])
      if (!isOk) {
        debug('parser.isModerated', 'Moderation failed ' + JSON.stringify(parser['fnc']))
        return true
      }
    }
    return false // no parser failed
  }

  async process () {
    debug('parser.process', 'PROCESS START of "' + this.message + '"')

    const parsers = await this.parsers()
    for (let parser of parsers) {
      if (parser.priority === constants.MODERATION) continue // skip moderation parsers
      if (
        _.isNil(this.sender) // if user is null -> we are running command through a bot
        || this.skip
        || (await global.permissions.check(this.sender.userId, parser.permission, false)).access
      ) {
        const opts = {
          sender: this.sender,
          message: this.message.trim(),
          skip: this.skip
        }

        debug('parser.process', 'Processing ' + parser.name)
        if (parser.fireAndForget) {
          parser['fnc'].apply(parser.this, [opts])
        } else {
          const status = await parser['fnc'].apply(parser.this, [opts])
          if (!status) {
            // TODO: call revert on parser with revert (price can have revert)
            return false
          }
        }
      }
    }
    if (this.isCommand) {
      this.command(this.sender, this.message.trim(), this.skip)
    }
  }

  populateList () {
    const list = [
      global.configuration,
      global.currency,
      global.events,
      global.users,
      global.permissions,
      global.twitch
    ]
    for (let system of Object.entries(global.systems)) {
      list.push(system[1])
    }
    for (let overlay of Object.entries(global.overlays)) {
      list.push(overlay[1])
    }
    for (let game of Object.entries(global.games)) {
      list.push(game[1])
    }
    for (let integration of Object.entries(global.integrations)) {
      list.push(integration[1])
    }
    return list
  }

  /**
   * Return all parsers
   * @constructor
   * @returns object or empty list
   */
  async parsers () {
    let parsers = []
    for (let i = 0, length = this.list.length; i < length; i++) {
      if (_.isFunction(this.list[i].parsers)) {
        parsers.push(this.list[i].parsers())
      }
    }
    parsers = _.orderBy(_.flatMap(await Promise.all(parsers)), 'priority', 'asc')
    return parsers
  }

  /**
   * Find first command called by message
   * @constructor
   * @param {string} message - Message from chat
   * @param {string} cmdlist - Set of commands to check, if null all registered commands are checked
   * @returns object or null if empty
   */
  async find (message, cmdlist) {
    debug('parser.find', JSON.stringify({message, cmdlist}))
    if (!cmdlist) {
      cmdlist = await this.getCommandsList();
    }
    for (let item of cmdlist) {
      let onlyParams = message.trim().toLowerCase().replace(item.command, '')
      let isStartingWith = message.trim().toLowerCase().startsWith(item.command)

      if (isStartingWith && (onlyParams.length === 0 || (onlyParams.length > 0 && onlyParams[0] === ' '))) {
        const customPermission = await global.permissions.getCommandPermission(item.id)
        if (typeof customPermission !== 'undefined') {
          item.permission = customPermission
        }
        return item
      }
    }
    return null
  }

  async getCommandsList () {
    let commands = []
    for (let i = 0, length = this.list.length; i < length; i++) {
      if (_.isFunction(this.list[i].commands)) {
        commands.push(this.list[i].commands())
      }
    }
    commands = _(await Promise.all(commands)).flatMap().sortBy(o => -o.command.length).value()
    for (let command of commands) {
      let permission = await global.db.engine.findOne(global.permissions.collection.commands, { key: command.id })
      if (!_.isEmpty(permission)) command.permission = permission.permission // change to custom permission
    }
    return commands
  }

  async command (sender, message, skip) {
    if (!message.startsWith('!')) return // do nothing, this is not a command or user is ignored
    let command = await this.find(message)
    if (_.isNil(command)) return // command not found, do nothing
    if (command.permission === null) return // command is disabled
    if (
      _.isNil(this.sender) // if user is null -> we are running command through a bot
      || this.skip
      || (await global.permissions.check(this.sender.userId, command.permission, false)).access
    ) {
      var text = message.trim().replace(new RegExp('^(' + command.command + ')', 'i'), '').trim()
      let opts = {
        sender: _.isNil(sender) ? { username: global.oauth.settings.bot.username.toLowerCase() } : sender,
        command: command.command,
        parameters: text.trim()
      }

      if (_.isNil(command.id)) throw Error(`command id is missing from ${command['fnc']}`)

      if (typeof command.fnc === 'function' && !_.isNil(command.id)) {
        command['fnc'].apply(command.this, [opts])
      } else global.log.error(command.command + ' have wrong undefined function ' + command._fncName + '() registered!', { fnc: 'Parser.prototype.parseCommands' })
    } else {
      // user doesn't have permissions for command
      sender['message-type'] = 'whisper'
      commons.sendMessage(global.translate('permissions.without-permission').replace(/\$command/g, message), sender)
    }
  }
}

module.exports = Parser
