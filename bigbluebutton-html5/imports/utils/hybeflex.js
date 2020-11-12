export const HybeFlexAppMode = {
  HYBEFLEX_APP_MODE_DEBUG: -1,
  HYBEFLEX_APP_MODE_LOADING: 0,
  HYBEFLEX_APP_MODE_VIDEOSCREEN: 1,
  HYBEFLEX_APP_MODE_STUDENT: 2,
  HYBEFLEX_APP_MODE_LECTURER: 3,
  HYBEFLEX_APP_MODE_INTERPRETER: 4,
  HYBEFLEX_APP_MODE_NORMAL: 99,
}

const {
  webcamsOnlyForModeratorOverride: HYBEFLEX_WEBCAMS_ONLY_FOR_MODERATOR_OVERRIDE,
  hackyModeDeterminationEnabled: HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED,
  debugModeEnabled: HYBEFLEX_DEBUG_MODE_ENABLED,
} = Meteor.settings.public.hybeflex;

class HybeFlexService {
  constructor() {
    this.user = null;
    this.speakingUser = null;
    this.appMode = HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING;
    this.screenIndex = 0;
    this.screenCount = 0;
    this.screenLayout = [];
  }

  getWebcamsOnlyForModeratorOverride() {
    if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN) { return true; }
    return HYBEFLEX_WEBCAMS_ONLY_FOR_MODERATOR_OVERRIDE;
  }

  isMultipleCamerasEnabled() {
    return this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER;
  }

  static getAppModeByUser(user) {
    if (user && user.userId) {
      switch (user.userId[0]) {
        case 'V': return HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN;
        case 'L': return HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER;
        case 'I': return HybeFlexAppMode.HYBEFLEX_APP_MODE_INTERPRETER;
        case 'S': return HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT;
        case 'X': if (HYBEFLEX_DEBUG_MODE_ENABLED) { return HybeFlexAppMode.HYBEFLEX_APP_MODE_DEBUG; }
      }
      if (HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED && user.name) {
        var name = user.name.toLowerCase();
        if (name == 'superman' && HYBEFLEX_DEBUG_MODE_ENABLED) { return HybeFlexAppMode.HYBEFLEX_APP_MODE_DEBUG; }
        if (name.slice(0, 7) == 'screen_') { return HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN; }
        if (name.slice(0, 4) == 'lec_') { return HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER; }
        if (name.slice(0, 4) == 'int_') { return HybeFlexAppMode.HYBEFLEX_APP_MODE_INTERPRETER; }
        return HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT;
      }
    }
    return HybeFlexAppMode.HYBEFLEX_APP_MODE_NORMAL;
  }

  setUser(user) {
    if (this.user) { return; }
    this.user = user;
    this.appMode = HybeFlexService.getAppModeByUser(user);
    if (HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED && this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN) {
      var fields = user.name.split('_');
      this.initScreenCount(fields[1], fields[2]);
    }
  }

  filterStreams(streams) {
    for (var i = streams.length - 1; i >= 0; i--) {
      streams[i].appMode = HybeFlexService.getAppModeByUser(streams[i]);
    }
    if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN) {
      // View student streams only
      streams = streams.filter((stream) => {
        if (stream.userId == this.user.userId) { return true; }
        if (stream.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT) { return true; }
        return false;
      });
    }
    if (this.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT) {
      // View local streams + speaking student + lecturer + interpreter streams
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

  static sortVideoScreenStreams(s1, s2) {
    if (s1.userId === Auth.userID && s2.userId !== Auth.userID) { return -1; }
    if (s2.userId === Auth.userID && s1.userId !== Auth.userID) { return 1; }
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    if (aName < bName) { return -1; }
    if (aName > bName) { return 1; }
    if (a.userId > b.userId) { return -1; }
    if (a.userId < b.userId) { return 1; }
    return 0;
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
