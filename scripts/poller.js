var poller = require('../lib/poller')
  , Twitter = require('twitter')
  , twit = new Twitter({
        consumer_key: 'DROXwWEJw3tXjU4YJpZLw',
        consumer_secret: 'pwv1Nvlvi3PcQ9fwkojiUd933prElu60Iu8FNAonwcI',
        access_token_key: '9881092-BZ6uQiCxPvq4qKhsNu4ptEl2jDXbH9O2HKfVnFDCkA',
        access_token_secret: '6LNRCRMdg6LE2egHAZLFLcVUWxBDIvgaafG6LKCtec4'
    })
  , links     = require('../lib/links_parser').Parser
  , mongodb = require('mongodb')
  , Db = mongodb.Db
  , Connection = mongodb.Connection
  , Server = mongodb.Server
  ;

// start polling
var db = new Db('twalks', new Server('staff.mongohq.com', 10090, {}));
db.open(function(err, client) {
    if (err) {
        throw err;
    }

    db.authenticate('user', '111111', function() {
        db.collectionNames(function(err, names) {
            if (err) {
                throw err;
            }

            var callback = function(job, collection) {
                var events = new mongodb.Collection(client, 'events');
                events.findOne({_id: job.id}, function(err, event) {
                    if (err) {
                        throw err;
                    }

                    processEvent(job, collection, event, events);
                });
            };
            if (names.indexOf('jobs') === -1) {
                db.createCollection("jobs", {capped:true, size:100000}, createJob(callback));
            } else {
                db.selectCollection("jobs", createJob(callback));
            }
        });
    });
})

function mapper(field) {
    return function(object) {
        return object[field];
    }
}

function processEvent(job, collection, event, eventsCollection) {
    var poll = poller.createPoller(twit, event.hash);

    poll.on('data', function(res) {
        if (typeof res.results !== "undefined") {
            res.results.forEach(function(json) {
                var tweet = {
                    tweetId   : json.id_str
                  , tweet     : json.text
                  , postedAt  : new Date(json.created_at)
                  , user      : json.from_user
                  , avatarUrl : json.profile_image_url
                  , hashes    : json.text
                                 .split(' ')
                                 .filter(function(word) {
                                     return word[0] === "#";
                                 })
                                 .map(function(candidate) {
                                     return candidate.replace(/^[^A-z0-9]|[^A-z0-9]$/g, '');
                                 })
                                 .filter(function(hash) {
                                     return hash === job.hash
                                 })
                };

                if (event.tweets.map(mapper('tweetId')).indexOf(tweet.tweetId) !== -1) {
                    return;
                }

                if (event.participants.indexOf(tweet.user) === -1) {
                    event.participants.push(tweet.user);
                }

                event.tweets.push(tweet);

                eventsCollection.save(event);

                var relevantTalks = [];
//                event.talks.forEach(function(talk) {
//                    if (talk.tweets.map(mapper('tweetId')).indexOf(tweet.tweetId) !== -1 ||
//                        tweet.hashes.indexOf(talk.hash) === -1) {
//                        console.log('tweet exists in the talk');
//                        return;
//                    }
//
//                    if (talk.participants.indexOf(tweet.user) === -1) {
//                        talk.participants.push(tweet.user);
//                    }
//
//                    talk.tweets.push(tweet);
//
//                    eventsCollection.save(event);
//
//                    relevantTalks.push(talk);
//                });
                links.parse(tweet.tweet, function(media) {
                    if (media.type === "error" ||
                        event.assets.map(mapper('url')).indexOf(media.url) !== -1) {
                        return;
                    }

                    var asset = {
                        author       : tweet.user
                      , type         : media.type
                      , asset_author : (media.author_name || '')
                      , provider     : (media.provider_name || '')
                      , provider_url : (media.provider_url || '')
                      , title        : (media.title || '')
                      , description  : (media.description || '')
                      , url          : (media.url || '')
                      , height       : (media.height || '')
                      , width        : (media.width || '')
                      , html         : (media.html || '')
                    };

                    event.assets.push(asset);
                    relevantTalks.forEach(function(talk) {
                        talk.assets.push(asset);
                    });

                    eventsCollection.save(event);
                });

                eventsCollection.save(event);
            });
        }
    });

    poll.startPolling();
}

function createJob(callback) {
    return function (err, collection) {
        if (err) {
            throw err;
        }

        var lastCreatedAt;
        collection.find({status: 'old'})
            .sort({'$natural': 1})
            .limit(1)
            .nextObject(function(err, lastJob) {
                if (err) {
                    throw err;
                }

                lastCreatedAt = ((lastJob || {}).createdAt || new Date(0));


                var cursor = collection.find({status: 'new', 'createdAt': {'$gte': lastCreatedAt}}, {tailable: true, timeout: false});

                cursor.each(function(err, job) {
                    if (err) {
                        throw err;
                    }

                    job.status = 'run';

                    collection.save(job);

                    callback(job, collection);
                });
            });
    }
}
