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
      throw new Error(err)
    }

    console.log('Connected to Slack RTM')
  });
// Otherwise assume multi-team mode - setup beep boop resourcer connection
} else {
  console.log('Starting in Beep Boop multi-team mode');
  require('beepboop-botkit').start(controller, { debug: true })
}

controller.on('bot_channel_join', function (bot, message) {
  bot.reply(message, "I'm here!")
});

controller.hears(['hello', 'hi'], ['direct_mention'], function (bot, message) {
  bot.reply(message, 'Hello.')
})

controller.hears(['hello', 'hi'], ['direct_message'], function (bot, message) {
  bot.reply(message, 'Hello.')
  bot.reply(message, 'It\'s nice to talk to you directly.')
})

controller.hears('.*', ['mention'], function (bot, message) {
  bot.reply(message, 'You really do care about me. :heart:')
})

controller.hears('help', ['direct_message', 'direct_mention'], function (bot, message) {
  var help = 'I will respond to the following messages: \n' +
      '`bot hi` for a simple message.\n' +
      '`bot attachment` to see a Slack attachment message.\n' +
      '`@<your bot\'s name>` to demonstrate detecting a mention.\n' +
      '`bot help` to see this again.'
  bot.reply(message, help)
})

controller.hears(['attachment'], ['direct_message', 'direct_mention'], function (bot, message) {
  var text = 'Beep Beep Boop is a ridiculously simple hosting platform for your Slackbots.'
  var attachments = [{
    fallback: text,
    pretext: 'We bring bots to life. :sunglasses: :thumbsup:',
    title: 'Host, deploy and share your bot in seconds.',
    image_url: 'https://storage.googleapis.com/beepboophq/_assets/bot-1.22f6fb.png',
    title_link: 'https://beepboophq.com/',
    text: text,
    color: '#7CD197'
  }]

  bot.reply(message, {
    attachments: attachments
  }, function (err, resp) {
    console.log(err, resp)
  })
})

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
    convo.say('Be succinct! Your status update is too long! (' + (_.size(resp.text) - 140) + ' over)');
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
      channel: channel.id
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
        convo.say('Oh no!');
        data.blocked = true;
        askBlockers(data, convo);
        convo.next();
      }
    },
    {
      pattern: convo.task.bot.utterances.no,
      callback: function(response, convo) {
        convo.say('Great!');
        data.blocked = false;
        finishStatus(data, convo);
        convo.next();
      }
    }
  ]);
};

var finishStatus = function(data, convo) {
  console.log(data);
  saveStatus(data, function (err) {
    if (err) {
      return console.error(err);
    }

    convo.say('Status updated! Thanks!')
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

    var statuses = _.concat(savedData.statuses, data);
    _.assign(savedData, { statuses: statuses });

    return controller.storage.channels.save(savedData, cb);
  });
};

controller.hears(['b', 'beginscrum', 'startscrum'], ['direct_mention'], function (bot, message) {
  function setScrumStarted(channel_data) {
    if (!channel_data) {
      channel_data = { id: message.channel };
    }
    channel_data.isScrumStarted = true;
    channel_data.scrumStartedBy = message.user;
    channel_data.scrumStartedAt = message.ts;
    channel_data.statuses = [];
    controller.storage.channels.save(channel_data, function(err) {});
  }

  var createChannelInfoHandler = function(property) {
    return function (err, result) {
      if(err) {
        console.error(err);
      }

      var channel = result[property];

      bot.reply(message, "Scrum started in *" + channel.name + "*");

      _.forEach(channel.members, function (user) {
        bot.startPrivateConversation({ user: user }, createScrumNotesConversation(channel, user))
      })
    };
  };

  var channel_data = getChannelFromStorage(message.channel);
  if (isChannelScrumStarted(channel_data)) {
    return bot.reply(message, template('Scrum is already in progress (started by <@${scrumStartedBy}>). Type `@${bot_name} endscrum` to end it.', { scrumStartedBy: channel_data.scrumStartedBy, bot_name: bot.identity.name }));
  }
  else {
    setScrumStarted(channel_data)
    switch (message.channel[0]) {
    case 'C':
      return bot.api.channels.info({ channel: message.channel }, createChannelInfoHandler('channel'));
    case 'G':
      return bot.api.groups.info({ channel: message.channel }, createChannelInfoHandler('group'));
    default:
      return bot.reply(message, 'Can\'t retrieve channel details for unknown channel type');
    }
  }
});

controller.hears(['e', 'endscrum', 'end scrum', 'stopscrum'], ['direct_mention'], function (bot, message) {
  function setScrumEnded(channel_data) {
    channel_data.isScrumStarted = false;
    channel_data.scrumStartedBy = null;
    channel_data.scrumStartedAt = null;
    channel_data.statuses = [];
    controller.storage.channels.save(channel_data, function(err) {});
  }

  function formatScrumUpdateList(statuses) {
    return _.join(_.map(statuses, function(status) {
        return template(
          '<@${user}>:\n' +
          '> Yesterday: ${yesterday}\n' +
          '> Today: ${today}\n' +
          '> ' + (!status.blocked ? 'No blockers! :thumbsup:' : 'Blocked by: ${blockers}') + '\n',
          status
        );
      }), '\n');
  }

  var channel_data = getChannelFromStorage(message.channel);
  if (!isChannelScrumStarted(channel_data)) {
    bot.reply(message, template('No scrum is currently active. :zzz: Start one by typing `@${bot_name} beginscrum`!', { bot_name: bot.identity.name }));
  }
  else if (message.user != channel_data.scrumStartedBy) {
    bot.reply(message, template('A scrum is currently active, but only <@${scrumStartedBy}> can end the scrum by typing `@${bot_name} endscrum`.', { scrumStartedBy: channel_data.scrumStartedBy, bot_name: bot.identity.name }))
  }
  else {
    var text = 'Here is the scrum update! :mega:\n\n';
    text += formatScrumUpdateList(channel_data.statuses);
    // console.log(text);

    bot.reply(message, text);

    // Clear out scrum vars
    setScrumEnded(channel_data);
  }
});

controller.hears('.*', ['direct_message', 'direct_mention'], function (bot, message) {
  bot.reply(message, 'Sorry <@' + message.user + '>, I don\'t understand. \n')
});
