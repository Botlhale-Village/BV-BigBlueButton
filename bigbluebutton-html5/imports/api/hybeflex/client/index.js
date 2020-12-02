import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { HybeFlexAppMode } from './..';
import Users from '/imports/api/users';
import { base64ArrayBuffer } from './base64';

export * from './..';

const {
  webcamsOnlyForModeratorOverride: HYBEFLEX_WEBCAMS_ONLY_FOR_MODERATOR_OVERRIDE,
  hackyModeDeterminationEnabled: HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED,
  wsUrl: API_WS_URL,
  apiUrl: API_HTTP_URL,
} = Meteor.settings.public.hybeflex;

var globalUserID = null;
var globalSocketUrl = API_WS_URL;

function svgToImage(svg) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function() { resolve(img); };
    img.onerror = function() { reject(); };
    img.src = 'data:image/svg+xml;charset=utf8,' +
      encodeURIComponent(new XMLSerializer().serializeToString(svg));
  });
}

class HybeFlexService {
  constructor() {
    this.meetingId = null;
    this.userId = null;
    this.user = null;
    this.speakingUser = null;
    this.appMode = HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING;
    this.appModeTracker = new Tracker.Dependency();
    this.screenIndex = 0;
    this.screenCount = 0;
    this.screenLayout = [];

    this.useThumbnails = true;

    this.videoCameraElements = {};
    this.selectedVideoCameraId = {
      value: null,
      tracker: new Tracker.Dependency(),
    };
    
    this.watchingStreams = {};
    this.watchingStreamsIndexByName = {};
    this.watchingStreamsNameByIndex = {};
    this.watchingStreamsIndex = 0;

    this.offscreenRenderPool = [];
    this.publishedStreamElements = {};
    this.publishingStreamsById = {};
    this.publishingStreamIndex = 0;
    this.watchingStreamsSubscribed = {};
    
    this.lastSocketSend = (new Date()).getTime();

    this.sortVideoScreenStreamsCallback = this.sortVideoScreenStreamsCallback.bind(this);
    this.sortUserListCallback = this.sortUserListCallback.bind(this);
    this.filterUserListCallback = this.filterUserListCallback.bind(this);
    this.pushThumbnail = this.pushThumbnail.bind(this);
    this.watchStreamThumbnail = this.watchStreamThumbnail.bind(this);

    setInterval(() => {
      if (!this.isWebSocketReady()) { return; }
      this.updateStreamSubscriptions();
      const now = (new Date()).getTime();
      if ((now - this.lastSocketSend) >= (3 * 1000)) {
        try {
          this.connection.send(JSON.stringify({ t: 'ping' }));
          this.lastSocketSend = now;
        } catch (e) { }
      }
    }, 5000);
  }

  watchStreamThumbnail(stream, callback) {
    const list = this.watchingStreams[stream] || (this.watchingStreams[stream] = []);
    const index = this.watchingStreamsIndexByName[stream] || (this.watchingStreamsIndexByName[stream] = ++this.watchingStreamsIndex);
    this.watchingStreamsNameByIndex[index] = stream;
    const obj = {
      latest: API_HTTP_URL + '/thumbnail/' + stream,
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

  updateStreamSubscriptions() {
    if (this.isWebSocketReady()) {
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
    }
  }

  onWebsocketInit() {
    if (this.user && this.appMode === HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING) {
      this.appMode = this.user.appMode;
      this.appModeTracker.changed();
    }
    this.publishingStreamsById = {};
    this.publishingStreamIndex = 0;
    this.watchingStreamsSubscribed = {};
    this.connection.send(JSON.stringify({
      t: 'init',
      id: this.userId,
      extid: this.user && this.user.extId,
      name: this.user && this.user.name,
    }));
    this.updateStreamSubscriptions();
    this.lastSocketSend = (new Date()).getTime();
  }

  onWebsocketMessage(msg) {
    if (!msg || !msg.data) { return; }
    if (msg.data.constructor === String) {
      try {
        const json = JSON.parse(msg.data);
        switch (json.t) {
          case 'redirect':
            globalSocketUrl = json.server;
            this.connectWebSocket();
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

  connectWebSocket() {
    this.appMode = HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING;
    this.appModeTracker.changed();
    if (this.connection) { this.connection.close(); }
    const id = (this.user && this.user.extId) || this.userId;
    this.connectionUserId = this.userId;
    this.connection = new ReconnectingWebSocket(globalSocketUrl + '?u=' + id, [], { startClosed: true });
    this.connection.binaryType = 'arraybuffer';
    this.connection.addEventListener('open', this.onWebsocketInit.bind(this));
    this.connection.addEventListener('message', this.onWebsocketMessage.bind(this));
    this.connection.reconnect();
  }
  
  init(meetingId, userId) {
    this.meetingId = meetingId;
    this.userId = globalUserID = userId;
    if (!this.trackerComputation) {
      this.trackerComputation = Tracker.autorun(async () => {
        this.speakingUser = Users.findOne({ meetingId: this.meetingId, isActiveSpeaker: true });
        const user = Users.findOne({ userId: this.userId, approved: true });
        if (user && user.appMode) {
          this.user = user;
          if (this.userId !== this.connectionUserId || !this.connection) { this.connectWebSocket(); }
          if (HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED && user.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN) {
            const fields = user.name.split('_');
            this.initScreenCount(fields[1], fields[2]);
          }
        }
      });
    }
  }

  isWebSocketReady() { return this.connection && this.connection.readyState === 1; }

  addPublishedStream(stream, element) {
    if (!stream) { return; }
    const data = this.publishedStreamElements[stream] || { timeout: null };
    if (data.element === element) { return; }
    if (data.timeout !== null) { clearTimeout(data.timeout); }
    const isWebSocketReady = () => this.isWebSocketReady();
    const pushThumbnail = (s, e) => this.pushThumbnail(s, e);
    data.stream = stream;
    data.element = element;
    data.timeout = null;
    data.removed = false;
    data.rescheduleThis = () => {
      if (data.timeout !== null) { clearTimeout(data.timeout); data.timeout = null; }
      if (data.removed) { return; }
      data.timeout = setTimeout(() => {
        data.timeout = null;
        data.pushThis();
      }, 900 + Math.random() * 200);
    };
    data.pushThis = () => {
      if (data.removed) { return; }
      if (!isWebSocketReady()) { data.rescheduleThis(); return; }
      pushThumbnail(data.stream, data.element).finally(data.rescheduleThis);
    };
    this.publishedStreamElements[stream] = data;
    data.pushThis();
  }

  removePublishedStream(stream) {
    const data = this.publishedStreamElements[stream];
    if (data) {
      data.removed = true;
      if (data.timeout !== null) { clearTimeout(data.timeout); data.timeout = null; }
      delete this.publishedStreamElements[stream];
      const index = this.publishingStreamsById[stream];
      if (this.isWebSocketReady() && index) {
        this.connection.send(JSON.stringify({ t: 'unpublishStream', stream, index }));
        delete this.publishingStreamsById[stream];
        this.lastSocketSend = (new Date()).getTime();
      }
    }
  }

  pushThumbnail(stream, blob) {
    if (!this.isWebSocketReady() || !blob || !stream) {
      return Promise.reject('Not ready.');
    }
    if (blob.tagName == 'svg') {
      return svgToImage(blob).then(img => { this.pushThumbnail(stream, img); });
    }
    if (!blob.arrayBuffer) {
      if (blob.toBlob && blob.getContext) {
        return new Promise((resolve, reject) => {
          try {
            blob.toBlob(newBlob => {
              this.pushThumbnail(stream, newBlob).then(resolve, reject);
            }, 'image/jpeg', 0.8);
          } catch (e) {
            reject(e);
          }
        });
      }
      const canvas = this.offscreenRenderPool.length > 0 ?
        this.offscreenRenderPool.pop() : document.createElement('canvas');
      try {
        var width = canvas.width; if (width != 300) { canvas.width = width = 300; }
        var height = canvas.height; if (height != 200) { canvas.height = height = 200; }
        const ctx = canvas.getContext('2d');
        ctx.drawImage(blob, 0, 0, width, height);
        return this.pushThumbnail(stream, canvas).finally(() => {
          this.offscreenRenderPool.push(canvas);
        });
      } catch (e) {
        this.offscreenRenderPool.push(canvas);
        return Promise.reject(e);
      }
    }
    var index = this.publishingStreamsById[stream];
    if (!index) {
      index = ++this.publishingStreamIndex;
      this.connection.send(JSON.stringify({ t: 'publishStream', stream, index }));
      this.publishingStreamsById[stream] = index;
      this.lastSocketSend = (new Date()).getTime();
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

  getSelectedVideoCameraId() {
    this.selectedVideoCameraId.tracker.depend();
    return this.selectedVideoCameraId.value;
  }

  setSelectedVideoCameraId(cameraId) {
    if (this.selectedVideoCameraId.value === cameraId) { return; }
    this.selectedVideoCameraId.value = cameraId;
    this.selectedVideoCameraId.tracker.changed();
  }

  getWebcamsOnlyForModeratorOverride() {
    if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN) { return true; }
    return HYBEFLEX_WEBCAMS_ONLY_FOR_MODERATOR_OVERRIDE;
  }

  isMultipleCamerasEnabled() {
    return this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER;
  }

  canUnmute() {
    if (this.appMode != HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT) { return true; }
    return !!(this.speakingUser && this.speakingUser.userId == this.userId);
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
    if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT) {
      // View local streams + speaking student + lecturer + interpreter streams
      this.populateStreamAppMode(streams);
      streams = streams.filter((stream) => {
        if (stream.userId == this.user.userId) { return true; }
        if (stream.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER) { return true; }
        if (stream.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_INTERPRETER) { return true; }
        if (this.speakingUser && stream.userId == this.speakingUser.userId) { return true; }
        return false;
      });
    }
    if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER ||
        this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_INTERPRETER) {
      // View local streams + speaking student
      streams = streams.filter((stream) => {
        if (stream.userId == this.user.userId) { return true; }
        if (this.speakingUser && stream.userId == this.speakingUser.userId) { return true; }
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
    this.screenCount = +count; if (this.screenCount <= 0) { this.screenCount = 1; }
    this.screenIndex = +index; if (this.screenIndex < 0) { this.screenIndex = 0; }
    else if (this.screenIndex >= this.screenCount) { this.screenIndex = this.screenCount - 1; }
    while (this.screenLayout.length > this.screenCount) { this.screenLayout.pop(); }
    while (this.screenLayout.length < this.screenCount) { this.screenLayout.push({ screenIndex: this.screenLayout.length, streams: [] }); }
  }

  buildScreenLayout(streams) {
    var i, layout, totalCapacity = 0, streamIndex = 0;
    var baseTotal = Math.floor(streams.length / this.screenCount);
    var cols = baseTotal ? Math.ceil(Math.sqrt(baseTotal)) : 1;
    var rows = baseTotal ? Math.ceil(baseTotal / cols) : 1;
    for (var i = 0; i < this.screenCount; i++) {
      var layout = this.screenLayout[i];
      layout.cols = cols;
      layout.rows = rows;
      totalCapacity += (layout.count = cols * rows);
    }
    while (totalCapacity < streams.length) {
      for (var i = 0; i < this.screenCount && totalCapacity < streams.length; i++) {
        var layout = this.screenLayout[i];
        if (layout.cols <= layout.rows) { layout.cols++; } else { layout.rows++; }
        totalCapacity -= layout.count;
        totalCapacity += (layout.count = layout.cols * layout.rows);
      }
    }
    for (var i = 0; i < this.screenCount; i++) {
      var layout = this.screenLayout[i];
      while (layout.streams.length > layout.count) { layout.streams.pop(); }
      while (layout.streams.length < layout.count) { layout.streams.push({}); }
      for (var j = 0; j < layout.count; j++) {
        if (streamIndex >= streams.length) { layout.streams[j].stream = null; }
        else { layout.streams[j].stream = streams[streamIndex++]; }
      }
    }
  }

  getActiveScreenLayout() {
    return this.screenLayout[this.screenIndex] ||
      (this.screenLayout[this.screenIndex] = { screenIndex: this.screenIndex, streams: [] });
  }
}

export default new HybeFlexService();
