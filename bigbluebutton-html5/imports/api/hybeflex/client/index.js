import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { HybeFlexAppMode } from './..';
import Users from '/imports/api/users';

export * from './..';

const {
  webcamsOnlyForModeratorOverride: HYBEFLEX_WEBCAMS_ONLY_FOR_MODERATOR_OVERRIDE,
  hackyModeDeterminationEnabled: HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED,
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

    this.sortVideoScreenStreamsCallback = this.sortVideoScreenStreamsCallback.bind(this);
    this.sortUserListCallback = this.sortUserListCallback.bind(this);
    this.filterUserListCallback = this.filterUserListCallback.bind(this);
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
          if (HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED && this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN) {
            const fields = user.name.split('_');
            this.initScreenCount(fields[1], fields[2]);
          }
        }
      });
    }
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
