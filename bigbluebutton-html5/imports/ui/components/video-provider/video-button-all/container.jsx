import React from 'react';
import { withTracker } from 'meteor/react-meteor-data';
import { injectIntl } from 'react-intl';
import JoinVideoAllButton from './component';
import VideoService from '../service';

import HybeFlexService, { HybeFlexAppMode } from '/imports/api/hybeflex/client';

const JoinVideoAllContainer = (props) => {
  if (HybeFlexService.appMode != HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER) { return null; }
  return <JoinVideoAllButton {...props} />;
};

export default injectIntl(withTracker(() => ({
  hasVideoStream: VideoService.hasVideoStream(),
  disableReason: VideoService.disableReason(),
}))(JoinVideoAllContainer));
