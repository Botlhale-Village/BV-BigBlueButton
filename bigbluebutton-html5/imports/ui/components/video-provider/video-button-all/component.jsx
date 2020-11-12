import React, { memo } from 'react';
import PropTypes from 'prop-types';
import cx from 'classnames';
import Button from '/imports/ui/components/button/component';
import VideoService from '../service';
import { defineMessages, injectIntl, intlShape } from 'react-intl';
import { styles } from './styles';
import { validIOSVersion } from '/imports/ui/components/app/service';

const intlMessages = defineMessages({
  joinVideo: {
    id: 'app.video.joinVideo',
    description: 'Join video button label',
  },
  leaveVideo: {
    id: 'app.video.leaveVideo',
    description: 'Leave video button label',
  },
  videoLocked: {
    id: 'app.video.videoLocked',
    description: 'video disabled label',
  },
  videoConnecting: {
    id: 'app.video.connecting',
    description: 'video connecting label',
  },
  dataSaving: {
    id: 'app.video.dataSaving',
    description: 'video data saving label',
  },
  meteorDisconnected: {
    id: 'app.video.clientDisconnected',
    description: 'Meteor disconnected label',
  },
  iOSWarning: {
    id: 'app.iOSWarning.label',
    description: 'message indicating to upgrade ios version',
  },
});

const propTypes = {
  intl: intlShape.isRequired,
  hasVideoStream: PropTypes.bool.isRequired,
};

const JoinVideoAllButton = ({
  intl,
  hasVideoStream,
  disableReason,
}) => {
  const handleOnClick = () => {
    if (!validIOSVersion()) {
      return VideoService.notify(intl.formatMessage(intlMessages.iOSWarning));
    }

    if (hasVideoStream) {
      VideoService.exitVideo();
    } else {
      navigator.mediaDevices.getUserMedia({ audio: false, video: true }).then((stream) => {
        navigator.mediaDevices.enumerateDevices().then((devices) => {
          var deviceIds = {};
          devices.forEach((device) => {
            if (device.kind === 'videoinput') { deviceIds[device.deviceId] = true; }
          });
          VideoService.joinMultipleVideo(Object.keys(deviceIds));
        });
      });
    }
  };

  let label = hasVideoStream
    ? intl.formatMessage(intlMessages.leaveVideo)
    : intl.formatMessage(intlMessages.joinVideo);

  if (disableReason) label = intl.formatMessage(intlMessages[disableReason]);

  return (
    <Button
      label={label}
      className={cx(styles.button, hasVideoStream || styles.btn)}
      onClick={handleOnClick}
      hideLabel
      color={hasVideoStream ? 'primary' : 'default'}
      icon={hasVideoStream ? 'video' : 'video-slash'}
      ghost={!hasVideoStream}
      size="lg"
      circle
      disabled={!!disableReason}
    />
  );
};

JoinVideoAllButton.propTypes = propTypes;

export default injectIntl(memo(JoinVideoAllButton));
