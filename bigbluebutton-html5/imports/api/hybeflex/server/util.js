import { Meteor } from 'meteor/meteor';
import { HybeFlexAppMode } from './..';

const {
  hackyModeDeterminationEnabled: HYBEFLEX_HACKY_MODE_DETERMINATION_ENABLED,
  debugModeEnabled: HYBEFLEX_DEBUG_MODE_ENABLED,
} = Meteor.settings.public.hybeflex;

function getAppModeByUser(user) {
  if (user) {
    if (user.extId) {
      switch (user.extId[0]) {
        case 'V': return HybeFlexAppMode.HYBEFLEX_APP_MODE_VIDEOSCREEN;
        case 'L': return HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER;
        case 'I': return HybeFlexAppMode.HYBEFLEX_APP_MODE_INTERPRETER;
        case 'S': return HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT;
        case 'X': if (HYBEFLEX_DEBUG_MODE_ENABLED) { return HybeFlexAppMode.HYBEFLEX_APP_MODE_DEBUG; }
      }
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
  return HybeFlexAppMode.HYBEFLEX_APP_MODE_LOADING;
}

export function updateUserAppMode(user, modifier) {
  if (!modifier.$set) { modifier.$set = {}; }
  modifier.$set.appMode = getAppModeByUser(user);
}
