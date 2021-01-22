import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { HybeFlexAppMode } from './..';
import Users from '/imports/api/users';
import { base64ArrayBuffer } from './base64';
import { telemetry } from './telemetry';

export * from './..';

telemetry.init();

const {
  webcamsOnlyForModeratorOverride: HYBEFLEX_WEBCAMS_ONLY_FOR_MODERATOR_OVERRIDE,
  hackyModeDeterminationEnabled: HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED,
} = Meteor.settings.public.hybeflex;

const MAX_THUMB_DIM = 300;

const currentDomainName = window.location.host;
export const HybeflexSocketUrl = 'wss://' + currentDomainName + '/hybeflex/sockysock';
export const HybeflexAPIUrl = 'https://' + currentDomainName + '/hybeflex/api';
export const WebRTCSFU = 'wss://' + currentDomainName + '/bbb-webrtc-sfu';

var globalUserID = null;
var globalSocketUrl = HybeflexSocketUrl;

const ajaxPost = function (url, data) {
  return new Promise(function (resolve, reject) {
    var http = new XMLHttpRequest();
    http.onreadystatechange = function () {
      if (http.readyState === 4) {
        if (http.status >= 200 && http.status < 300) { resolve(true); }
        else { reject(http.statusText || 'Error'); }
      }
    };
    http.open('POST', url, true);
    http.setRequestHeader('Content-Type', 'application/json');
    http.send(JSON.stringify(data || {}));
  });
};

const svgToImage = (function () {
  var lastSvgImageTag = new Image();
  var lastSvgImageBackTag = new Image();
  var lastSvgImageBackSrc = '';

  function loadImage(img, src) {
    if (img.src == src) { return Promise.resolve(img); }
    return new Promise(function (resolve, reject) {
      img.onload = function () { resolve(img); };
      img.onerror = function (e) { reject(e); };
      img.src = src;
    });
  }

  return function (svg) {
    var svgText = new XMLSerializer().serializeToString(svg);

    // Strip out background image
    var i = svgText.indexOf('<image ');
    if (i >= 0) {
      var j = svgText.indexOf('/>', i + 7);
      var imageTag = svgText.slice(i, j + 2);
      svgText = svgText.slice(0, i) + svgText.slice(j + 2);
      i = imageTag.indexOf('href="');
      if (i >= 0) {
        i += 6; j = imageTag.indexOf('"', i);
        lastSvgImageBackSrc = imageTag.slice(i, j);
      }
    }

    // Strip out white rectangle
    i = svgText.indexOf('<g><g><rect x="0" y="0"');
    if (i >= 0) {
      var j = svgText.indexOf('/></g></g>', i + 23);
      svgText = svgText.slice(0, i) + svgText.slice(j + 10);
    }

    return Promise.all([
      loadImage(lastSvgImageBackTag, lastSvgImageBackSrc),
      loadImage(lastSvgImageTag, 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svgText)),
    ]);
  };
})();

class HybeFlexService {
  constructor() {
    this.meetingId = null;
    this.userId = null;
    this.user = null;
    this.speakingUsers = [];
    this.speakingUserIds = {};
    this.appMode = HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING;
    this.appModeTracker = new Tracker.Dependency();
    this.screenIndex = 0;
    this.screenCount = 0;
    this.screenLayout = [];

    this.opts = { };
    this.activeStream = null;
    this.activeStreamTracker = new Tracker.Dependency();
    this.classStreamSelected = true;
    this.roomStreamsByTag = {};
    this.roomStreamsById = {};

    this.videoCameraElements = {};
    this.selectedVideoCameraId = {
      value: null,
      tracker: new Tracker.Dependency(),
    };
    
    this.watchingStreams = {};
    this.watchingStreamsIndexByName = {};
    this.watchingStreamsNameByIndex = {};
    this.watchingStreamsIndex = 0;

    this.publishingStreams = {};
    this.publishingStreamsIndexByName = {};
    this.publishingStreamsNameByIndex = {};
    this.publishingStreamsIndex = 0;

    this.offscreenRenderPool = [];
    this.publishedStreamSubscribed = {};
    this.watchingStreamsSubscribed = {};
    
    this.lastSocketSend = (new Date()).getTime();
    this.checkAppTimer = null;

    this.sortVideoScreenStreamsCallback = this.sortVideoScreenStreamsCallback.bind(this);
    this.sortUserListCallback = this.sortUserListCallback.bind(this);
    this.filterUserListCallback = this.filterUserListCallback.bind(this);
    this.watchStreamThumbnail = this.watchStreamThumbnail.bind(this);
    this.addPublishedStream = this.addPublishedStream.bind(this);
    this.isWebSocketReady = this.isWebSocketReady.bind(this);
    this.checkAppMode = this.checkAppMode.bind(this);

    setInterval(() => {
      this.checkAppMode();
      if (!this.isWebSocketReady()) { return; }
      this.updateStreamSubscriptions();
      const now = (new Date()).getTime();
      if ((now - this.lastSocketSend) >= (3 * 1000)) {
        try {
          this.connection.send(JSON.stringify({ t: 'ping' }));
          this.lastSocketSend = now;
        } catch (e) { }
      }
      var videos = document.getElementsByTagName('video');
      for (var i = videos.length - 1; i >= 0; i--) {
        var el = videos[i];
        if (el.srcObject && el.paused) {
          el.play();
        }
      }
    }, 5000);
  }

  isUsingThumbnails() { return !!this.opts.useThumbnails; }

  isWebSocketReady() { return this.connection && this.connection.readyState === 1; }

  getWebcamsOnlyForModeratorOverride() {
    if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN) { return true; }
    return HYBEFLEX_WEBCAMS_ONLY_FOR_MODERATOR_OVERRIDE;
  }

  isMultipleCamerasEnabled() {
    return this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER;
  }

  canUnmute() {
    if (this.appMode != HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT) { return true; }
    return this.speakingUserIds[this.userId];
  }

  isWebcamStream(stream) {
    if (!stream) { return false; }
    if (stream == 'presentation' || stream == 'screenshare') { return false; }
    if (stream.length >= 13 && stream.slice(0, 13) == 'presentation_') { return false; }
    if (stream.length >= 12 && stream.slice(0, 12) == 'screenshare_') { return false; }
    return true;
  }

  isScreenshareStream(stream) {
    if (!stream) { return false; }
    if (stream == 'screenshare' || (stream.length >= 12 && stream.slice(0, 12) == 'screenshare_')) { return true; }
    return false;
  }

  isPresentationStream(stream) {
    if (!stream) { return false; }
    if (stream == 'presentation' || (stream.length >= 13 && stream.slice(0, 13) == 'presentation_')) { return true; }
    return false;
  }

  getFromUserSettings(setting, defaultValue) {
    const value = this.opts[setting];
    if (value !== undefined) { return value; }
    return defaultValue;
  }

  initDefaultOpts(appMode) {
    this.opts = {
      useThumbnails: 1,
      bbb_skip_check_audio: 1,
      bbb_listen_only_mode: 0,
      bbb_force_listen_only: 0,
    };
    switch (appMode) {
      case HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN:
        this.opts.maxStreamsBeforeThumbnails = 4;
        this.opts.screenIndex = 0;
        this.opts.screens = [{ screenIndex: 0 }];
        break;
      case HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT:
        break;
    }
  }

  watchStreamThumbnail(stream, callback) {
    stream = this.getStreamIdForStream(stream);
    const list = this.watchingStreams[stream] || (this.watchingStreams[stream] = []);
    const index = this.watchingStreamsIndexByName[stream] ||
      (this.watchingStreamsIndexByName[stream] = ++this.watchingStreamsIndex);
    this.watchingStreamsNameByIndex[index] = stream;
    const obj = {
      latest: HybeflexAPIUrl + '/thumbnail/' + stream,
      receive: (img) => {
        obj.latest = img;
        try { callback(img); }
        catch (e) { }
      },
      remove: () => {
        const idx = list.indexOf(obj);
        if (idx >= 0) { list.splice(idx, 1); }
        if (list.length <= 0 && this.watchingStreams[stream] === list) {
          delete this.watchingStreams[stream];
          this.updateStreamSubscriptions();
        }
      }
    };
    list.push(obj);
    try { callback(obj.latest); } catch (e) { }
    this.updateStreamSubscriptions();
    return obj;
  }

  addPublishedStream(stream, element) {
    if (this.appMode != HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER) {
      if (stream == 'presentation' || stream == 'screenshare') { return; }
    }
    stream = this.getStreamIdForStream(stream);
    const list = this.publishingStreams[stream] || (this.publishingStreams[stream] = []);
    const index = this.publishingStreamsIndexByName[stream] ||
      (this.publishingStreamsIndexByName[stream] = ++this.publishingStreamsIndex);
    this.publishingStreamsNameByIndex[index] = stream;
    const obj = {
      element: element,
      timeout: null,
      reschedulePush: () => {
        if (obj.timeout !== null) { clearTimeout(obj.timeout); obj.timeout = null; }
        if (obj.removed) { return; }
        obj.timeout = setTimeout(() => {
          obj.timeout = null;
          obj.pushThumbnail();
        }, 900 + Math.random() * 200);
      },
      pushThumbnail: () => {
        if (obj.removed) { return; }
        if (!this.isWebSocketReady()) { obj.reschedulePush(); return; }
        if (!this.publishedStreamSubscribed[stream]) { this.updateStreamSubscriptions(); }
        this.pushThumbnail(index, obj.element).finally(obj.reschedulePush);
      },
      remove: () => {
        obj.removed = true;
        if (obj.timeout !== null) { clearTimeout(obj.timeout); obj.timeout = null; }
        const idx = list.indexOf(obj);
        if (idx >= 0) { list.splice(idx, 1); }
        if (list.length <= 0 && this.publishingStreams[stream] === list) {
          delete this.publishingStreams[stream];
          this.updateStreamSubscriptions();
        }
      }
    };
    list.push(obj);
    this.updateStreamSubscriptions();
    obj.pushThumbnail();
    return obj;
  }

  updateStreamSubscriptions() {
    if (this.isWebSocketReady()) {
      const now = (new Date()).getTime();

      Object.keys(this.watchingStreamsSubscribed).forEach(stream => {
        if (!this.watchingStreams[stream] || !this.watchingStreams[stream].length) {
          try {
            const index = this.watchingStreamsIndexByName[stream];
            this.connection.send(JSON.stringify({ t: 'unwatchStream', stream, index }));
            this.lastSocketSend = now;
            delete this.watchingStreamsSubscribed[stream];
            delete this.watchingStreams[stream];
          } catch (e) { }
        }
      });

      Object.keys(this.watchingStreams).forEach(stream => {
        if (!this.watchingStreamsSubscribed[stream] && this.watchingStreams[stream].length) {
          try {
            const index = this.watchingStreamsIndexByName[stream];
            this.connection.send(JSON.stringify({ t: 'watchStream', stream, index }));
            this.lastSocketSend = now;
            this.watchingStreamsSubscribed[stream] = true;
          } catch (e) { }
        }
      });

      Object.keys(this.publishedStreamSubscribed).forEach(stream => {
        if (!this.publishingStreams[stream] || !this.publishingStreams[stream].length) {
          try {
            const index = this.publishingStreamsIndexByName[stream];
            this.connection.send(JSON.stringify({ t: 'unpublishStream', stream, index }));
            this.lastSocketSend = now;
            delete this.publishedStreamSubscribed[stream];
            delete this.publishingStreams[stream];
          } catch (e) { }
        }
      });

      Object.keys(this.publishingStreams).forEach(stream => {
        if (!this.publishedStreamSubscribed[stream] && this.publishingStreams[stream].length) {
          try {
            const index = this.publishingStreamsIndexByName[stream];
            this.connection.send(JSON.stringify({ t: 'publishStream', stream, index }));
            this.lastSocketSend = now;
            this.publishedStreamSubscribed[stream] = true;
          } catch (e) { }
        }
      });

    }
  }

  getStreamIdForStream(stream) {
    if (!stream) { return null; }
    if (stream != 'presentation' && stream != 'screenshare') { return stream; }
    return stream + '_' + this.meetingId;
  }

  getInternalTagForStream(stream) {
    if (!stream) { return null; }
    if (stream == 'presentation' || stream == 'screenshare') { return stream; }
    if (stream.length >= 13 && stream.slice(0, 13) == 'presentation_') { return 'presentation'; }
    if (stream.length >= 12 && stream.slice(0, 12) == 'screenshare_') { return 'screenshare'; }
    return this.roomStreamsById[stream];
  }

  initTelemetryCallback(extId) {
    const fields = (extId || '').split('_');
    const userId = fields[1];
    const roomId = fields[2];
    telemetry.setCallback((obj) => {
      if (this.isWebSocketReady()) {
        this.connection.send(JSON.stringify({ t: 'tel', data: obj }));
        return true;
      } else {
        return ajaxPost(HybeflexAPIUrl + '/telemetry', {
          u: userId,
          r: roomId,
          t: obj.t,
          m: obj.m,
          c: obj.c,
        });
      }
    });
  }

  checkAppMode() {
    if (!this.isWebSocketReady()) {
      if (this.appMode !== HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING) {
        this.appMode = HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING;
        this.appModeTracker.changed();
      }
      if (this.checkAppTimer !== null) { this.checkAppTimer = null; }
      this.checkAppTimer = setTimeout(() => { this.checkAppTimer = null; this.checkAppMode(); }, 200);
    } else if (this.user && this.appMode !== this.user.appMode) {
      this.appMode = this.user.appMode;
      this.appModeTracker.changed();
    }
  }

  onWebsocketInit() {
    this.watchingStreamsSubscribed = {};
    this.publishedStreamSubscribed = {};
    this.connection.send(JSON.stringify({
      t: 'init',
      id: this.userId,
      extid: this.user && this.user.extId,
      name: this.user && this.user.name,
      opts: this.opts,
    }));
    this.updateStreamSubscriptions();
    this.lastSocketSend = (new Date()).getTime();
    this.sendActiveSpeakers();
    this.checkAppMode();
  }

  onWebsocketClose() {
    this.checkAppMode();
  }

  onWebsocketMessage(msg) {
    if (!msg || !msg.data) { return; }
    this.checkAppMode();
    if (msg.data.constructor === String) {
      try {
        const json = JSON.parse(msg.data);
        switch (json.t) {
          case 'redirect':
            globalSocketUrl = json.server;
            this.connectWebSocket();
            break;
          case 'resetClient':
            try { window.location.reload(true); } catch (e) { }
            window.location.reload();
            break;
          case 'optSet':
            if (json.opts) {
              Object.keys(json.opts).forEach(key => { this.opts[key] = json.opts[key]; });
              if (this.user.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN && (this.opts.screenIndex || this.opts.screens)) {
                this.initScreenCount(this.opts.screenIndex, (this.opts.screens && this.opts.screens.length) || 1);
              }
              this.appModeTracker.changed();
            }
            this.connection.send(JSON.stringify({ t: 'optVal', opts: this.opts }));
            break;
          case 'roomStreams':
            if (json.opts) {
              this.roomStreamsByTag = json.opts;
              this.roomStreamsById = {};
              Object.keys(json.opts).forEach(key => { this.roomStreamsById[json.opts[key]] = key; });
            }
            break;
          case 'activeStream':
            this.activeStream = json.stream;
            this.setSelectedVideoCameraId(this.activeStream, true);
            this.activeStreamTracker.changed();
            break;
        }
      } catch (e) { }
    } else if (msg.data.constructor === ArrayBuffer && msg.data.byteLength >= 4) {
      const header = new Uint8Array(msg.data, 0, 4);
      if (header[0] === 0x01) { // Thumbnail update
        // tslint:disable-next-line:no-bitwise
        const index = (header[1] << 16) + (header[2] << 8) + header[3];
        const streamId = this.watchingStreamsNameByIndex[index];
        if (streamId) {
          const img = 'data:image/jpeg;base64,' + base64ArrayBuffer(msg.data.slice(4));
          const list = this.watchingStreams[streamId];
          if (list) { for (var i = list.length - 1; i >= 0; i--) { list[i].receive(img); } }
        }
      }
    }
  }

  sendActiveSpeakers() {
    if (!this.isWebSocketReady()) { return; }
    this.connection.send(JSON.stringify({
      t: 'activeSpeaker',
      opts: this.speakingUserIds
    }));
    this.lastSocketSend = (new Date()).getTime();
  }

  connectWebSocket() {
    if (this.appMode !== HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING) {
      this.appMode = HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING;
      this.appModeTracker.changed();
    }
    if (this.connection) { this.connection.close(); }
    const id = (this.user && this.user.extId) || this.userId;
    this.connectionUserId = this.userId;
    this.connection = new ReconnectingWebSocket(globalSocketUrl + '?u=' + id, [], { startClosed: true });
    this.connection.binaryType = 'arraybuffer';
    this.connection.addEventListener('open', this.onWebsocketInit.bind(this));
    this.connection.addEventListener('message', this.onWebsocketMessage.bind(this));
    this.connection.addEventListener('close', this.onWebsocketClose.bind(this));
    this.connection.addEventListener('error', this.onWebsocketClose.bind(this));
    this.connection.reconnect();
  }
  
  init(meetingId, userId) {
    this.meetingId = meetingId;
    this.userId = globalUserID = userId;
    if (!this.trackerComputation) {
      this.trackerComputation = Tracker.autorun(async () => {
        this.speakingUsers = Users.find({ meetingId: this.meetingId, isActiveSpeaker: true }).fetch();
        this.speakingUserIds = {};
        this.speakingUsers.forEach((item) => this.speakingUserIds[item.userId] = true);
        this.sendActiveSpeakers();
        const user = Users.findOne({ userId: this.userId, approved: true });
        if (user && user.appMode) {
          this.user = user;
          if (this.userId !== this.connectionUserId || !this.connection) {
            telemetry.send('info', 'User ' + this.userId + ' joined meeting ' + meetingId + ' mode ' + this.user.appMode);
            this.initTelemetryCallback(user.extId);
            this.initDefaultOpts(user.appMode);
            this.connectWebSocket();
            if (HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED && user.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN) {
              const fields = user.name.split('_');
              if (fields.length >= 3) { this.initScreenCount(this.opts.screenIndex = (+fields[1]) - 1, +(fields[2] || 1)); }
            }
          }
        }
      });
    }
  }

  pushThumbnail(index, blob) {
    if (!this.isWebSocketReady() || !blob) {
      return Promise.reject('Not ready.');
    }
    if (blob.tagName == 'svg') {
      return svgToImage(blob).then(img => { this.pushThumbnail(index, img); });
    }
    if (!blob.arrayBuffer) {
      if (blob.toBlob && blob.getContext) {
        return new Promise((resolve, reject) => {
          try {
            blob.toBlob(newBlob => {
              this.pushThumbnail(index, newBlob).then(resolve, reject);
            }, 'image/jpeg', 0.8);
          } catch (e) {
            reject(e);
          }
        });
      }
      const element = (blob.constructor == Array) ? blob[0] : blob;
      var width = element.width || 300;
      var height = element.height || 200;
      if (width > MAX_THUMB_DIM) { height = Math.floor((height * MAX_THUMB_DIM / width) + 0.5); width = MAX_THUMB_DIM; }
      if (height > MAX_THUMB_DIM) { width = Math.floor((width * MAX_THUMB_DIM / height) + 0.5); height = MAX_THUMB_DIM; }
      var canvas = null;
      for (var i = 0; i < this.offscreenRenderPool.length; i++) {
        if (this.offscreenRenderPool[i].width == width && this.offscreenRenderPool[i].height == height) {
          canvas = this.offscreenRenderPool[i];
          this.offscreenRenderPool[i] = this.offscreenRenderPool[this.offscreenRenderPool.length - 1];
          this.offscreenRenderPool.pop();
          break;
        }
      }
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
      }
      try {
        const ctx = canvas.getContext('2d');
        if (blob.constructor == Array) {
          for (var i = 0; i < blob.length; i++) {
            if (!blob[i].width || !blob[i].height) { ctx.drawImage(blob[i], 0, 0, width, height); }
            else { ctx.drawImage(blob[i], 0, 0, blob[i].width, blob[i].height, 0, 0, width, height); }
          }
        } else {
          if (!blob.width || !blob.height) { ctx.drawImage(blob, 0, 0, width, height); }
          else { ctx.drawImage(blob, 0, 0, blob.width, blob.height, 0, 0, width, height); }
        }
        return this.pushThumbnail(index, canvas).finally(() => {
          this.offscreenRenderPool.push(canvas);
        });
      } catch (e) {
        this.offscreenRenderPool.push(canvas);
        return Promise.reject(e);
      }
    }
    return blob.arrayBuffer().then(buffer => {
      const array = new Uint8Array(buffer.byteLength + 4);
      array[0] = 0x01;
      array[1] = (index >> 16) & 0xff
      array[2] = (index >> 8) & 0xff
      array[3] = index & 0xff;
      array.set(new Uint8Array(buffer), 4);
      this.connection.send(array);
      this.lastSocketSend = (new Date()).getTime();
    });
  }

  getActiveStream() {
    this.activeStreamTracker.depend();
    return this.activeStream;
  }

  getSelectedVideoCameraId() {
    this.selectedVideoCameraId.tracker.depend();
    return this.selectedVideoCameraId.value;
  }

  setSelectedVideoCameraId(cameraId, fromSocket) {
    if (cameraId == 'class') {
      if (!this.classStreamSelected) {
        this.classStreamSelected = true;
        this.activeStreamTracker.depend();
      }
      this.setSelectedVideoCameraId(this.activeStream, true);
    } else {
      if (cameraId) {
        if (cameraId.length >= 13 && cameraId.slice(0, 13) == 'presentation_') { cameraId = 'presentation'; }
        else if (cameraId.length >= 12 && cameraId.slice(0, 12) == 'screenshare_') { cameraId = 'screenshare'; }
      }
      if (this.selectedVideoCameraId.value === cameraId) { return; }
      if (!fromSocket || (this.classStreamSelected && fromSocket)) {
        this.selectedVideoCameraId.value = cameraId;
        this.selectedVideoCameraId.tracker.changed();
      }
      if (!fromSocket) {
        if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT) {
          if (this.classStreamSelected) {
            this.classStreamSelected = false;
            this.activeStreamTracker.depend();
          }
        } else if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER && this.isWebSocketReady()) {
          const tag = this.getInternalTagForStream(cameraId);
          if (tag) {
            this.connection.send(JSON.stringify({ t: 'setActiveStream', name: tag }));
            this.lastSocketSend = (new Date()).getTime();
          }
        }
      }
    }
  }

  populateStreamAppMode(streams) {
    var userAppMode = {};
    var users = Users.find({ meetingId: this.meetingId }).fetch();
    for (var i = users.length - 1; i >= 0; i--) { userAppMode[users[i].userId] = users[i].appMode; }
    for (var i = streams.length - 1; i >= 0; i--) { streams[i].appMode = userAppMode[streams[i].userId]; }
  }

  filterStreams(streams) {
    if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN) {
      // View student streams only
      this.populateStreamAppMode(streams);
      streams = streams.filter((stream) => {
        if (stream.userId == this.user.userId) { return true; }
        if (stream.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT) { return true; }
        return false;
      });
    }
    if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT ||
        this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER ||
        this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_INTERPRETER) {
      // View local streams + speaking student + lecturer + interpreter streams
      this.populateStreamAppMode(streams);
      streams = streams.filter((stream) => {
        if (stream.userId == this.user.userId) { return true; }
        if (stream.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER) { return true; }
        if (stream.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_AUTOVIDEO) { return true; }
        if (stream.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_INTERPRETER) { return true; }
        if (this.speakingUserIds[stream.userId]) { return true; }
        return false;
      });
    }
    return streams;
  }

  sortVideoScreenStreamsCallback(a, b) {
    if (a.userId === this.userId && b.userId !== this.userId) { return -1; }
    if (b.userId === this.userId && a.userId !== this.userId) { return 1; }
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    if (aName < bName) { return -1; }
    if (aName > bName) { return 1; }
    if (a.userId > b.userId) { return -1; }
    if (a.userId < b.userId) { return 1; }
    return 0;
  }

  sortUserListCallback(u1, u2) {
    var score1 = 0, score2 = 0;

    if (u1.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER) { score1 += 1000; }
    else if (u1.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_INTERPRETER) { score1 += 100; }
    else if (u1.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT) { score1 += 10; }
    if (u1.isActiveSpeaker) { score1++; }

    if (u2.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER) { score2 += 1000; }
    else if (u2.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_INTERPRETER) { score2 += 100; }
    else if (u2.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT) { score2 += 10; }
    if (u2.isActiveSpeaker) { score2++; }

    return score2 - score1;
  }

  filterUserListCallback(u) {
    if (u.userId == this.userId) { return true; }
    if (u.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT ||
        u.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER ||
        u.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_INTERPRETER) { return true; }
    return false;
  }

  initScreenCount(index, count) {
    this.screenCount = +count; if (this.screenCount <= 0 || isNaN(this.screenCount)) { this.screenCount = 1; }
    this.screenIndex = +index; if (this.screenIndex < 0 || isNaN(this.screenIndex)) { this.screenIndex = 0; }
    else if (this.screenIndex >= this.screenCount) { this.screenIndex = this.screenCount - 1; }
    while (this.screenLayout.length > this.screenCount) { this.screenLayout.pop(); }
    while (this.screenLayout.length < this.screenCount) { this.screenLayout.push({ screenIndex: this.screenLayout.length, streams: [] }); }
  }

  getVideoWallStreams(streams) {
    var users = Users.find({
      meetingId: this.meetingId,
      approved: true,
      connectionStatus: 'online',
      appMode: HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT
    }).fetch();
    users.sort((a, b) => { return a.userId.localeCompare(b.userId); });
    var streamByUserId = {};
    streams.forEach((stream) => { streamByUserId[stream.userId] = stream; });
    return users.map((user) => {
      var stream = streamByUserId[user.userId];
      if (!stream) { stream = { cameraId: null, userId: user.userId, name: user.name }; }
      stream.handRaised = user.emoji == 'raiseHand';
      stream.isActiveSpeaker = user.isActiveSpeaker;
      return stream;
    });
  }

  buildScreenLayout(streams) {
    if (this.screenCount <= 0 || isNaN(this.screenCount)) { return; }
    var activeSpeakers = streams.filter((item) => item.isActiveSpeaker);
    streams = streams.filter((item) => !item.isActiveSpeaker);
    var i, layout, totalCapacity = 0, streamIndex = 0;
    var baseTotal = Math.floor(streams.length / this.screenCount);
    var cols = baseTotal ? Math.ceil(Math.sqrt(baseTotal)) : 1;
    var rows = baseTotal ? Math.ceil(baseTotal / cols) : 1;
    for (var i = 0; i < this.screenCount; i++) {
      var layout = this.screenLayout[i];
      layout.screenIndex = i;
      layout.screenCount = this.screenCount;
      layout.opts = this.opts && this.opts.screens && this.opts.screens[i];
      if (layout.opts && layout.opts.showActiveSpeaker && activeSpeakers.length) {
        layout.cols = Math.ceil(Math.sqrt(activeSpeakers.length));
        layout.rows = Math.ceil(activeSpeakers.length / layout.cols);
        layout.activeSpeakerOnly = true;
        layout.doListenAudio = true;
      } else {
        layout.cols = cols;
        layout.rows = rows;
        layout.activeSpeakerOnly = false;
        layout.doListenAudio = false;
      }
      totalCapacity += (layout.count = layout.cols * layout.rows);
    }
    while (totalCapacity < streams.length) {
      var increased = false;
      for (var i = 0; i < this.screenCount && totalCapacity < streams.length; i++) {
        var layout = this.screenLayout[i];
        if (layout.activeSpeakerOnly) { continue; }
        if (layout.cols <= layout.rows) { layout.cols++; } else { layout.rows++; }
        totalCapacity -= layout.count;
        totalCapacity += (layout.count = layout.cols * layout.rows);
        increased = true;
      }
      if (!increased) { break; }
    }
    for (var i = 0; i < this.screenCount; i++) {
      var layout = this.screenLayout[i];
      while (layout.streams.length > layout.count) { layout.streams.pop(); }
      while (layout.streams.length < layout.count) { layout.streams.push({}); }
      if (layout.activeSpeakerOnly) {
        for (var j = 0; j < layout.streams.length; j++) {
          if (j >= activeSpeakers.length) { layout.streams[j].stream = null; }
          else { layout.streams[j].stream = activeSpeakers[j]; }
        }
      } else {
        for (var j = 0; j < layout.streams.length; j++) {
          if (streamIndex >= streams.length) { layout.streams[j].stream = null; }
          else { layout.streams[j].stream = streams[streamIndex++]; }
        }
      }
    }
    if (this.opts.maxStreamsBeforeThumbnails === 0) { this.opts.useThumbnails = 1; }
    else if (this.opts.maxStreamsBeforeThumbnails) {
      var thisScreen = this.getActiveScreenLayout();
      this.opts.useThumbnails = (thisScreen.streams.length > this.opts.maxStreamsBeforeThumbnails) ? 1 : 0;
    }
  }

  getActiveScreenLayout() {
    return this.screenLayout[this.screenIndex] ||
      (this.screenLayout[this.screenIndex] = { screenIndex: this.screenIndex, screenCount: this.screenCount, streams: [] });
  }
}

export default new HybeFlexService();
