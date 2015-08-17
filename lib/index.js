'use strict';


var _           = require('lodash');
var async       = require('async');
var yaml        = require('js-yaml');
var path        = require('path');
var requireAll  = require('require-all');
var Cache       = require('./cache');
var fetchers    = require('./fetchers');
var mixins      = require('./mixins');
var mixinsAfter = require('./mixins_after');
var urlLib      = require('url');
var domainsConf = require('../config/domains_conf.json');
var templates   = require('./templates');
var request     = require('request');
var fs          = require('fs');


// Load custom domains
var domains = _.reduce(requireAll(path.join(__dirname, 'domains')), function (acc, config, id) {
  // If config in folder - extract
  if (config.index) {
    config = config.index;
  }

  // Fill `id` by file name
  config.id = id;
  acc.push(config);
  return acc;
}, []);

// Load generic domains
domains = domains.concat(yaml.safeLoad(fs.readFileSync(path.join(__dirname, '..', 'config', 'generic.yml'))));


// Create Embedza
//
// options:
//
// - enabledProviders ([String]|Boolean) - optional, array of enabled providers
//   or `true` for all providers, default `true`
// - cache (Cache) - optional, custom cache class, default `new Cache()`
//
function Embedza(options) {
  var self = this;

  this.__options__ = _.defaults({}, options, {
    enabledProviders: true,
    cache: new Cache()
  });

  this.__fetchers__ = {};
  this.__mixins__ = {};
  this.__mixinsAfter__ = {};
  this.__domains__ = [];

  // Domains config cache
  this.__rulesCache__ = null;

  // Init plugins

  fetchers.forEach(function (fetcher) {
    self.addFetcher(fetcher);
  });

  mixins.forEach(function (mixin) {
    self.addMixin(mixin);
  });

  mixinsAfter.forEach(function (mixinAfter) {
    self.addMixinAfter(mixinAfter);
  });

  domains.forEach(function (domain) {
    self.addDomain(domain);
  });

  // Deactivate some providers if needed
  if (_.isArray(this.__options__.enabledProviders)) {

    // Disable all first
    this.forEach(function (domain) { domain.enabled = false; });

    // Enable required and add missing providers
    this.__options__.enabledProviders.forEach(function (domain) {
      if (!self.__domains__[domain]) {
        self.addDomain(domain);
      } else {
        self.__domains__[domain].enabled = true;
      }
    });
  }
}


// Render url
//
// - url (String) - content url
// - type ([String]|String) - format name or list of suitable formats by priority ('block', 'inline')
// - callback (Function) - `function (err, result)`
//   - `result.html`
//   - `result.type`
//
Embedza.prototype.render = function (url, type, callback) {
  var self = this;

  if (!_.isArray(type)) {
    type = [ type ];
  }

  self.info(url, function (err, result) {
    if (err) {
      callback(err);
      return;
    }

    // If domain disabled - stop here
    if (!result) {
      callback();
      return;
    }

    var tpl, html;
    var tplData = _.assign({}, result, {
      utils: {
        url: urlLib
      }
    });

    // Find and render suitable template
    for (var i = 0; i < type.length; i++) {
      tpl = templates[result.domain + '_' + type[i]] || templates['default_' + type[i]];

      if (tpl) {
        try {
          html = tpl(tplData);
          // If we can't render template (maybe not enough data) - use next
        } catch (__) {
          continue;
        }

        callback(null, {
          html: _.trim(html),
          type: type[i]
        });
        return;
      }
    }

    // If no template found - return empty result
    callback();
  });
};


// Get data for URL
//
// - url (String) - resource URL
// - callback (Function) - `function (err, result)`
//
// Result fields:
//
// - domain (String) - domain plugin id ('youtube.com', 'vimeo.com', ...)
// - src (String) - source url
// - meta (Object)
//   - title
//   - description
//   - date
//   - canonical
//   - shortlink
//   - category
//   - keywords
//   - author
//   - author_url
//   - copyright
//   - license
//   - license_url
//   - site
//   - duration
//   - country-name
//   - postal-code
//   - street-address
//   - region
//   - locality
//   - latitude
//   - longitude
//   - price
//   - currency_code
//   - brand
//   - product_id
//   - availability
//   - quantity
// - snippets ([Object])
//   - type (String)
//   - tags ([String])
//   - href (String)
//   - media (Object)
//   - html (String)
//
// Env fields:
//
// - src (String) - resource url
// - wl (Object)
// - config (Object) - additional domain config: autoplay parameter name, API key
// - data (Object) - fetchers result
// - result (Object) - see above
// - request (Function)
//
//
Embedza.prototype.info = function (url, callback) {
  var self = this;

  var domain = urlLib.parse(url).host;

  if (!domain) {
    callback();
    return;
  }

  // Fill plugins environment
  var env = {
    src: url,
    wl: null,
    config: null,
    data: {},
    result: {
      src: url,
      domain: '',
      meta: {},
      snippets: []
    },
    request: this.request
  };

  // Create domains config cache if not created yet
  if (!this.__rulesCache__) {
    this.__buildCache__();
  }

  // Find domain plugin
  if (this.__rulesCache__.match && this.__rulesCache__.match.test(env.src)) {
    env.result.domain = _.findKey(this.__rulesCache__.domains, function (domain) {
      return domain.match.test(env.src);
    });
  }

  // If no domain plugin - stop here
  if (!env.result.domain) {
    callback();
    return;
  }

  env.config = self.__domains__[env.result.domain].config;

  // Get data from cache
  this.__options__.cache.get(url, function (err, value) {
    if (err) {
      callback(err);
      return;
    }

    // If data in cache - return it
    if (value) {
      callback(null, value);
      return;
    }

    var domainPatterns = [ env.result.domain, 'www.' + env.result.domain, '*.' + env.result.domain ];

    // Try find domain in conf
    for (var i = 0; i < domainPatterns.length; i++) {
      if (domainsConf.domains[domainPatterns[i]]) {
        env.wl = domainsConf.domains[domainPatterns[i]];
        break;
      }
    }

    // Run fetchers
    async.eachSeries(self.__rulesCache__.domains[env.result.domain].fetchers, function (fetcher, next) {
      fetcher.fn(env, next);
    }, function (err) {
      if (err) {
        callback(err);
        return;
      }

      // Run mixins
      async.eachSeries(self.__rulesCache__.domains[env.result.domain].mixins, function (mixin, next) {
        mixin(env, next);
      }, function (err) {
        if (err) {
          callback(err);
          return;
        }

        // Run mixins after
        async.eachSeries(self.__rulesCache__.domains[env.result.domain].mixinsAfter, function (mixinAfter, next) {
          mixinAfter(env, next);
        }, function (err) {
          if (err) {
            callback(err);
            return;
          }

          // Save fetched data in cache
          self.__options__.cache.set(url, env.result, function (err) {
            if (err) {
              callback(err);
              return;
            }

            callback(null, env.result);
          });
        });
      });
    });
  });
};


// Make request
//
// - url (String) - request url
// - options (Object)
//   - method (String) - optional, 'GET', 'HEAD', 'POST', ..., default 'GET'
// - callback (Function) - `function (err, response, body)`
//   - err (Error) - possible socket error
//   - response (Response) - server response
//   - body (String) - response body
//
Embedza.prototype.request = function (url, options, callback) {
  request(url, options, callback);
};


// Add data fetcher
//
// - options (Object)
//   - id (String) - fetcher id
//   - priority (Number) - optional, run priority, default `0`
//   - fn (Function) - fetcher handler - `function (env, callback)`
//
Embedza.prototype.addFetcher = function (options) {
  this.__fetchers__[options.id] = _.defaults({}, options, {
    priority: 0
  });

  // Clear domains match cache
  this.__rulesCache__ = null;
};


// Add mixin (data handler)
//
// - options (Object)
//   - id (String) - mixin id
//   - fn (Function) - mixin handler - `function (env, callback)`
//
Embedza.prototype.addMixin = function (options) {
  this.__mixins__[options.id] = options.fn;

  // Clear domains match cache
  this.__rulesCache__ = null;
};


// Add mixin after handler
//
// - options (Object)
//   - id (String) - post id
//   - fn (Function) - post handler - `function (env, callback)`
//
Embedza.prototype.addMixinAfter = function (options) {
  this.__mixinsAfter__[options.id] = options.fn;

  // Clear domains match cache
  this.__rulesCache__ = null;
};


// Enable domain with default rules or add custom one
//
// - options (Object|String)
//   - id (String) - provider ID (`youtube.com`)
//   - match ([RegExp]|RegExp) - patterns to match
//   - fetchers ([String]) - optional, array of fetchers dependency
//   - fetchersExtra ([Object]) - custom fetchers
//   - mixins ([String]) - optional, array of mixins dependency
//   - mixinsExtra ([Function]) - custom mixins
//   - mixinsAfter ([String]) - optional, array of mixins after dependency
//   - mixinsAfterExtra ([Function]) - custom mixins after
//   - config (Object) - additional config: autoplay parameter name, API key
//
Embedza.prototype.addDomain = function (options) {
  // If options is string `embedza.addDomain('example.com')` - convert to object
  if (_.isString(options)) {
    options = {
      id: options
    };
  }

  var domainOptions = _.defaults({}, options, {
    fetchers: true,
    fetchersExtra: [],
    mixins: true,
    mixinsExtra: [],
    mixinsAfter: true,
    mixinsAfterExtra: [],
    match: [
      new RegExp('^https?://(?:www\\.)?' + _.escapeRegExp(options.id) + '.*')
    ],
    enabled: this.__options__.enabledProviders === true || this.__options__.enabledProviders.indexOf(options.id) !== -1,
    config: {}
  });

  domainOptions.match = _.isArray(domainOptions.match) ? domainOptions.match : [ domainOptions.match ];

  this.__domains__[domainOptions.id] = domainOptions;

  // Clear domains cache
  this.__rulesCache__ = null;
};


// Iterate through domains to modify it
//
// - fn (Function) - `function (domain)`
//
Embedza.prototype.forEach = function (fn) {
  _.values(this.__domains__).forEach(fn);
  // Clear domains match cache
  this.__rulesCache__ = null;
};


// Get domain rule by name
//
// - name (String) - rule name
//
Embedza.prototype.rule = function (name) {
  return this.__domains__[name];
};


// Create domains config cache
//
Embedza.prototype.__buildCache__ = function () {
  var self = this;
  var cache;

  this.__rulesCache__ = {
    domains: {}, // domains with joined matchers and expanded fetchers, mixins and mixinsAfter
    match: null // RegEx to check if any domains match
  };

  _.values(this.__domains__).forEach(function (domain) {
    if (!domain.enabled) {
      return; // continue
    }

    cache = {
      // Compile match pattern
      match: new RegExp(domain.match.reduce(function (acc, re) {
        acc.push('(' + re.source + ')');
        return acc;
      }, []).join('|'), 'i'),

      // Add custom fetchers to cache
      fetchers: domain.fetchersExtra.slice(0),

      // Add custom mixins to cache
      mixins: domain.mixinsExtra.slice(0),

      // Add custom mixins after to cache
      mixinsAfter: domain.mixinsAfterExtra.slice(0)
    };


    ///////////////////////////////////////////////////////////////////////////
    // Fetchers

    if (_.isArray(domain.fetchers)) {
      // Use fetchers from array
      cache.fetchers = cache.fetchers.concat(domain.fetchers);

    } else if (domain.fetchers === true) {
      // Use all common fetchers
      cache.fetchers = cache.fetchers.concat(_.values(self.__fetchers__));
    }

    cache.fetchers = cache.fetchers.map(function (fetcher) {
      if (_.isFunction(fetcher)) {
        // If extra fetcher is function - transform to object with priority
        return { priority: 0, fn: fetcher };

      } else if (_.isString(fetcher)) {
        // If fetcher is string id - replace by common fetcher
        return self.__fetchers__[fetcher];
      }

      return fetcher;
    });

    // Sort fetchers by priority
    cache.fetchers = _.sortBy(cache.fetchers, 'priority');


    ///////////////////////////////////////////////////////////////////////////
    // Mixins

    if (_.isArray(domain.mixins)) {
      // Use mixins from array
      cache.mixins = cache.mixins.concat(domain.mixins);

    } else if (domain.mixins === true) {
      // Use all common mixins
      cache.mixins = cache.mixins.concat(_.values(self.__mixins__));
    }

    // If mixin is string id - replace by common mixin
    cache.mixins = cache.mixins.map(function (mixin) {
      if (_.isString(mixin)) {
        return self.__mixins__[mixin];
      }

      return mixin;
    });


    ///////////////////////////////////////////////////////////////////////////
    // Mixins after

    if (_.isArray(domain.mixinsAfter)) {
      // Use mixins after from array
      cache.mixinsAfter = cache.mixinsAfter.concat(domain.mixinsAfter);

    } else if (domain.mixinsAfter === true) {
      // Use all common mixins after
      cache.mixinsAfter = cache.mixinsAfter.concat(_.values(self.__mixinsAfter__));
    }

    // If mixin after is string id - replace by common mixin after
    cache.mixinsAfter = cache.mixinsAfter.map(function (mixinAfter) {
      if (_.isString(mixinAfter)) {
        return self.__mixinsAfter__[mixinAfter];
      }

      return mixinAfter;
    });


    // Add to cache
    self.__rulesCache__.domains[domain.id] = cache;
  });

  // Compile match pattern for all domains
  this.__rulesCache__.match = new RegExp(_.reduce(this.__rulesCache__.domains, function (acc, domain) {
    acc.push('(' + domain.match.source + ')');

    return acc;
  }, []).join('|'), 'i');
};


module.exports = Embedza;