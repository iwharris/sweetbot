var Botkit = require('botkit');
var _ = require('lodash');

var token = process.env.SLACK_TOKEN;

var controller = Botkit.slackbot({
  // reconnect to Slack RTM when connection goes bad
  retry: Infinity,
  debug: false,
  //json_file_store: 'resources/test.json'
});

// Assume single team mode if we have a SLACK_TOKEN
if (token) {
  console.log('Starting in single-team mode');
  controller.spawn({
    token: token
  }).startRTM(function (err, bot, payload) {
    if (err) {
      throw new Error(err);
    }

    console.log('Connected to Slack RTM');
  });
// Otherwise assume multi-team mode - setup beep boop resourcer connection
} else {
  console.log('Starting in Beep Boop multi-team mode');
  require('beepboop-botkit').start(controller, { debug: true });
}

controller.on('bot_channel_join', function (bot, message) {
  bot.reply(message, "I'm here!");
});

controller.hears(['hello', 'hi'], ['direct_mention'], function (bot, message) {
  bot.reply(message, 'Hello.');
})

controller.hears(['hello', 'hi'], ['direct_message'], function (bot, message) {
  bot.reply(message, template('Hello, <@${user}>!', message));
})

controller.hears('.*', ['mention'], function (bot, message) {
  bot.reply(message, 'You really do care about me. :heart:');
})

controller.hears('help', ['direct_message', 'direct_mention'], function (bot, message) {
  var help = 'I will respond to the following messages: \n' +
      '>>>`@${name}> beginscrum` to start a scrum.\n' +
      '`<@${name}> endscrum` to finish a scrum once it is started.\n' +
      '`<@${name}> status` to see my current status.\n' +
      '`<@${name}> about` to learn more about me.\n' +
      '`<@${name}> help` to see this again.'
  bot.reply(message, template(help, { name: bot.identity.name }));
});

controller.hears('about', ['direct_message', 'direct_mention'], function (bot, message) {
  var about = '>`${name} v${version}`\n' +
      '> Created for *AppCarousel #hackday2016* by Spiro F, Tom S, and Ian H. :raised_hands:\n' +
      '> Open-sourced under *GPLv3*.\n' +
      'Feel free to fork my code and improve me! https://github.com/iwharris/sweetbot';
  bot.reply(message, template(about, { name: bot.identity.name, version: '0.1' }));
});

function template(template_str, values) {
  var compiled = _.template(template_str);
  return compiled(values);
}

// Expects to receive a channel object
function isChannelScrumStarted(channel_data) {
  return channel_data && channel_data.isScrumStarted;
}

function getChannelFromStorage(channel_id) {
  var channel = {};
  controller.storage.channels.get(channel_id, function(err, channel_data) {
    channel = channel_data;
  });
  return channel;
}

var checkStatusLength = function(resp, convo) {
  if(_.size(resp.text) > 140) {
    convo.say('Keep it short and sweet! Your status update is too long! (' + (_.size(resp.text) - 140) + ' over)');
    return true;
  }

  return false;
};

var createScrumNotesConversation = function(channel, user) {
  return function (err, convo) {
    if(err) {
      return console.error(err);
    }

    data = {
      user: user,
      channel: channel.id,
      ready: false
    };

    convo.say(template('Hey! It\'s time to enter your scrum status for *${name}*!', channel));
    askYesterday(data, convo);
    return convo.next();
  };
}

var askYesterday = function(data, convo) {
  return convo.ask('What did you do yesterday?', function(resp, convo) {
    if(checkStatusLength(resp, convo)) {
      askYesterday(data, convo);
      return convo.next();
    } else {
      data.yesterday = resp.text;
      askToday(data, convo);
      return convo.next();
    }
  });
};

var askToday = function(data, convo) {
  return convo.ask('What are you going to do today?', function(resp, convo) {
    if(checkStatusLength(resp, convo)) {
      askToday(data, convo);
      return convo.next();
    } else {
      data.today = resp.text;
      askBlocked(data, convo);
      return convo.next();
    }
  });
};

var askBlockers = function(data, convo) {
  return convo.ask('How are you blocked?', function(resp, convo) {
    if(checkStatusLength(resp, convo)) {
      askBlockers(data, convo);
      return convo.next();
    } else {
      data.blockers = resp.text;
      finishStatus(data, convo);
      return convo.next();
    }
  });
};

var askBlocked = function(data, convo) {
  return convo.ask('Are you blocked?', [
    {
      pattern: convo.task.bot.utterances.yes,
      callback: function(response, convo) {
        convo.say('Oh no! :worried:');
        data.blocked = true;
        askBlockers(data, convo);
        convo.next();
      }
    },
    {
      pattern: convo.task.bot.utterances.no,
      callback: function(response, convo) {
        convo.say('Great! :thumbsup:');
        data.blocked = false;
        finishStatus(data, convo);
        convo.next();
      }
    }
  ]);
};

var finishStatus = function(data, convo) {
  data.ready = true;
  console.log('finishing status', data);
  saveStatus(data, function (err) {
    if (err) {
      return console.error(err);
    }

    convo.say('Status updated! Thanks! :white_check_mark:');
    convo.next();
  });
};

var saveStatus = function(data, cb) {
  controller.storage.channels.get(data.channel, function (err, savedData) {
    if(err) {
      return cb(err);
    }

    if(_.isNil(savedData)) {
      savedData = { id: data.channel, statuses: [] };
    }

    var statuses = savedData.statuses;
    _.remove(statuses, function(status) { return status.user == data.user});
    statuses = _.concat(statuses, data);
    _.assign(savedData, { statuses: statuses });

    return controller.storage.channels.save(savedData, cb);
  });
};

// GET SCRUM STATUS
controller.hears(['status'], ['direct_mention'], function (bot, message) {
  var channel_data = getChannelFromStorage(message.channel);
  if (isChannelScrumStarted(channel_data)) {
    var total = _.size(channel_data.statuses);
    var submitted = _(channel_data.statuses).filter(function(status) { return status.ready; }).size();
    var text = 'Scrum is *Active*, started by <@${initiator}>! :sunny:\n' +
      (total == submitted ? ':white_check_mark: All ${total}' : '${count} of ${total}') + ' users have submitted a scrum update.\n' +
      'Type `<@${name}> endscrum` at any time to end the scrum.';
    bot.reply(message, template(text, { initiator: channel_data.scrumStartedBy, count: submitted, total: total, name: bot.identity.name }));
  }
  else {
    bot.reply(message, template('Scrum is *Inactive*. :zzz:\nTo start a scrum, type `<@${name}> beginscrum`.', { name: bot.identity.name }));
  }
});

// START SCRUM
controller.hears(['b', 'beginscrum', 'startscrum'], ['direct_mention'], function (bot, message) {
  function setScrumStarted(channel_data, channel_instance) {
    var recipients = _(channel_instance.members)
      .filter(function(id) { return id != bot.identity.id })  // omit own bot ID
      .value();
    console.log('recipients: ', recipients);ƒ
    
    channel_data.statuses = _(recipients).map(function(iƒd) { return { user: id, channel: message.channel, ready: false }; }).value();

    channel_data.isScrumStarted = true;
    channel_data.scrumStartedBy = message.user;
    channel_data.scrumStartedAt = message.ts;
    console.log('savedata', channel_data)
    controller.storage.channels.save(channel_data, function(err) {});

    bot.reply(message, "Scrum started in *" + channel_instance.name + "*");ƒ
    // Launch direct messages to each user
    _.forEach(recipients, function (user) {
        bot.startPrivateConversation({ user: user }, createScrumNotesConversation(channel_instance, user));
    });
  }

  var createChannelInfoHandler = function(property, channel_data) {
    return function (err, result) {
      if(err) {
        console.error(err);
      }ƒ
      setScrumStarted(channel_data, result[property]);
    };
  };

  var channel_data = getChannelFromStorage(message.channel);
  if (!channel_data) {
    channel_data = { id: message.channel };
  }
  if (isChannelScrumStarted(channel_data)) {
    return bot.reply(message, template('Scrum is already *Active* :sunny: (started by <@${scrumStartedBy}>). Type `@${bot_name} endscrum` to end it.', { scrumStartedBy: channel_data.scrumStartedBy, bot_name: bot.identity.name }));
  }
  else {
    // Call correct channel handler for public channel or private channel/group
    switch (message.channel[0]) {
      case 'C':
        return bot.api.channels.info({ channel: message.channel }, createChannelInfoHandler('channel', channel_data));
      case 'G':
        return bot.api.groups.info({ channel: message.channel }, createChannelInfoHandler('group', channel_data));
      default:
        return bot.reply(message, 'Can\'t retrieve channel details for unknown channel type');  
    }
  }
});

// END SCRUM
controller.hears(['e', 'endscrum', 'end scrum', 'stopscrum'], ['direct_mention'], function (bot, message) {
  function setScrumEnded(channel_data) {
    channel_data.isScrumStarted = false;
    channel_data.scrumStartedBy = null;
    channel_data.scrumStartedAt = null;
    channel_data.statuses = [];
    controller.storage.channels.save(channel_data, function(err) {});
  }

  function getReadyStatuses(statuses) { return _(statuses).filter(function(status) { return status.ready; }).value(); }
  function getUnreadyStatuses(statuses) { return _(statuses).filter(function(status) { return !status.ready; }).value(); }

  function formatScrumUpdateList(ready_statuses) {
    return _.join(
      _.map(ready_statuses, function(status) {
        return template(
          '<@${user}>:\n' +
          '> Yesterday: ${yesterday}\n' +
          '> Today: ${today}\n' +
          '> ' + (!status.blocked ? 'No blockers! :thumbsup:' : 'Blocked by: ${blockers}') + '\n',
          status
        );
      }), '\n');
  }

  function formatScrumMissedList(unready_statuses) {
    return _.join(_.map(unready_statuses, function(status) { return template('<@${user}>', status); }), ', ');
  }

  var channel_data = getChannelFromStorage(message.channel);

  console.log(channel_data);
  if (!isChannelScrumStarted(channel_data)) {
    bot.reply(message, template('No scrum is currently active. :zzz: Start one by typing `@${bot_name} beginscrum`!', { bot_name: bot.identity.name }));
  }
  else if (message.user != channel_data.scrumStartedBy) {
    bot.reply(message, template('A scrum is currently active, but only <@${scrumStartedBy}> can end the scrum by typing `@${bot_name} endscrum`.', { scrumStartedBy: channel_data.scrumStartedBy, bot_name: bot.identity.name }))
  }
  else {
    var text = 'Hi team, here is your scrum update: :mega:\n\n';

    var ready_statuses = getReadyStatuses(channel_data.statuses);
    text += _.size(ready_statuses) != 0 ? formatScrumUpdateList(ready_statuses) : 'No one submitted a scrum update! :fearful:';
    
    text += '\n\n';

    var unready_statuses = getUnreadyStatuses(channel_data.statuses);
    text += _.size(unready_statuses) != 0 ? 'The following users did not submit an update:\n> ' + formatScrumMissedList(unready_statuses) : 'Everyone submitted an update! :tada:';

    bot.reply(message, text);

    // Clear out scrum vars
    setScrumEnded(channel_data);
  }
});

controller.hears('.*', ['direct_message', 'direct_mention'], function (bot, message) {
  bot.reply(message, template('Sorry <@${user}>, I didn\'t understand that. Try typing `<@${name}> help` for help.\n', { user: message.user, name: bot.identity.name }));
});
