import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { HybeFlexAppMode } from './..';
import Users from '/imports/api/users';

export * from './..';

const {
  webcamsOnlyForModeratorOverride: HYBEFLEX_WEBCAMS_ONLY_FOR_MODERATOR_OVERRIDE,
  hackyModeDeterminationEnabled: HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED,
  wsUrl: API_WS_URL,
} = Meteor.settings.public.hybeflex;

var globalUserID = null;

class HybeFlexService {
  constructor() {
    this.meetingId = null;
    this.userId = null;
    this.user = null;
    this.speakingUser = null;
    this.appMode = HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING;
    this.screenIndex = 0;
    this.screenCount = 0;
    this.screenLayout = [];

    this.videoCameraElements = {};
    this.selectedVideoCameraId = {
      value: null,
      tracker: new Tracker.Dependency(),
    };
    
    this.offscreenRenderPool = [];
    this.latestThumbnail = {};
    this.publishedStreamElements = {};
    this.publishingStreamsById = {};
    this.publishingStreamIndex = 0;

    this.sortVideoScreenStreamsCallback = this.sortVideoScreenStreamsCallback.bind(this);
    this.sortUserListCallback = this.sortUserListCallback.bind(this);
    this.filterUserListCallback = this.filterUserListCallback.bind(this);
    this.pushThumbnail = this.pushThumbnail.bind(this);
  }

  onWebsocketInit() {
    this.latestThumbnail = {};
    this.publishingStreamsById = {};
    this.publishingStreamIndex = 0;
    this.connection.send(JSON.stringify({
      t: 'init',
      id: this.userId,
      name: this.user && this.user.name
    }));
  }

  onWebsocketMessage(msg) {
    if (!msg || !msg.data) { return; }
    /*if (msg.data.constructor === String) {
      try {
        const json = JSON.parse(msg.data);
      } catch (e) { }
    } else if (msg.data.constructor === ArrayBuffer && msg.data.byteLength >= 4) {
      const header = new Uint8Array(msg.data, 0, 4);
      if (header[0] === 0x01) { // Thumbnail update
        // tslint:disable-next-line:no-bitwise
        const index = (header[1] << 16) + (header[2] << 8) + header[3];
        const streamId = this.watchingStreamsByIndex[index];
        if (streamId) {
          const img = 'data:image/jpeg;base64,' + encodeBase64(msg.data.slice(4));
          this.latestThumbnail[streamId] = img;
        }
      }
    }*/
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
          this.appMode = user.appMode;
          if (this.userId !== this.connectionUserId || !this.connection) {
            if (this.connection) { this.connection.close(); }
            this.connectionUserId = this.userId;
            this.connection = new ReconnectingWebSocket(API_WS_URL + '?u=' + this.userId, [], { startClosed: true });
            this.connection.binaryType = 'arraybuffer';
            this.connection.addEventListener('open', this.onWebsocketInit.bind(this));
            this.connection.addEventListener('message', this.onWebsocketMessage.bind(this));
            this.connection.reconnect();
          }
          if (HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED && this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN) {
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
      }
    }
  }

  pushThumbnail(stream, blob) {
    if (!this.isWebSocketReady() || !blob || !stream) {
      return Promise.reject('Not ready.');
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
    }
    return blob.arrayBuffer().then(buffer => {
      const array = new Uint8Array(buffer.byteLength + 4);
      array[0] = 0x01;
      array[1] = (index >> 16) & 0xff
      array[2] = (index >> 8) & 0xff
      array[3] = index & 0xff;
      array.set(new Uint8Array(buffer), 4);
      this.connection.send(array);
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
    return this.screenLayout[this.screenIndex];
  }
}

export default new HybeFlexService();
