export const telemetry = window.telemetry = (function () {
  var consoleLog = console.log;
  var consoleWarm = console.warn;
  var consoleError = console.error;
  var consoleInfo = console.info;

  var callback = null;
  var queue = [];
  var pumping = false;

  var pump = function () {
    if (!callback) { return; }
    if (pumping) { return; }
    pumping = true;
    while (queue.length > 0) {
      var item = queue.shift();
      try {
        var result = callback(item);
        if (result === false || result === 0) {
          pumping = false;
          queue.unshift(item);
          return;
        }
        if (result && result.then) {
          result.then(
            function () { pumping = false; pump(); },
            function () { pumping = false; queue.unshift(item); });
          return;
        }
      } catch (e) {
        pumping = false;
        queue.unshift(item);
        return;
      }
    }
    pumping = false;
  };

  var patch = function (thisPtr, original, type) {
    return function () {
      try {
        var args = arguments;
        var data = [];
        if (typeof args[0] === 'string' && args[0].indexOf('%') >= 0) {
          var count = 0;
          data.push(args[0].replace(/%([a-zA-Z])/g, function (str, fmt) {
            try {
              switch (fmt) {
                case 's': return args[++count];
                case 'i': case 'd': return Math.floor(+args[++count]) + '';
                case 'f': return +args[++count];
                case 'o': case 'O': return JSON.stringify(args[++count]);
                default: count++; return '';
              }
            } catch (e) {
              return '';
            }
          }));
        } else {
          for (var i = 0; i < args.length; i++) {
            if (typeof args[i] === 'string') { data.push(args[i]); }
            else { data.push(JSON.stringify(args[i])); }
          }
        }
        data = data.join(' ');
        var effectiveType = type;
        if (type == 'log') {
          if (data.indexOf('ERROR:') >= 0) { effectiveType = 'error'; }
          else if (data.indexOf('INFO:') >= 0) { effectiveType = 'info'; }
          else if (data.indexOf('DEBUG:') >= 0) { effectiveType = 'warn'; }
        }
        api.send(effectiveType, data);
      } catch (e) { }
      original.apply(thisPtr, args);
    };
  };

  var windowError = function (ev) {
    api.send('error', (ev && ev.message) || '');
  };

  var api = {
    init: function () {
      console.log = patch(console, consoleLog, 'log');
      console.warn = patch(console, consoleLog, 'warn');
      console.error = patch(console, consoleLog, 'error');
      console.info = patch(console, consoleLog, 'info');
      window.addEventListener('error', windowError);
    },

    uninit: function () {
      console.log = consoleLog;
      console.warn = consoleWarm;
      console.error = consoleError;
      console.info = consoleInfo;
      window.removeEventListener('error', windowError);
    },

    send: function (type, message) {
      queue.push({
        t: type,
        m: message,
        c: (new Date()).getTime()
      });
      pump();
    },

    setCallback: function (cbk) {
      callback = cbk;
      pump();
    },

    clearPending: function () {
      queue = []
    },
  };

  return api;
})();
