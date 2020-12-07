import Auth from '/imports/ui/services/auth';
import UserSettings from '/imports/api/users-settings';
import HybeFlexService from '/imports/api/hybeflex/client';

export default function getFromUserSettings(setting, defaultValue) {
  const selector = {
    meetingId: Auth.meetingID,
    userId: Auth.userID,
    setting,
  };

  const userSetting = UserSettings.findOne(selector);

  if (userSetting !== undefined) {
    defaultValue = userSetting.value;
  }

  return HybeFlexService.getFromUserSettings(setting, defaultValue);
}
