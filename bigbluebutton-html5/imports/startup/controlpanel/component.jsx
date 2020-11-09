import React, { Component } from 'react';
import { withTracker } from 'meteor/react-meteor-data';
import Users from '/imports/api/users';
import VideoStreams from '/imports/api/video-streams';
import VoiceUsers from '/imports/api/voice-users';

export class ControlPanel extends Component {
  render() {
    const x = this.props;
    return (
      <pre style={{ color: '#fff', height: '100%', overflowY: 'scroll' }}>
        { JSON.stringify(x, null, 2) }
      </pre>
    );
  }
}

export default withTracker(() => {
  const users = Users.find().fetch();
  const videoStreams = VideoStreams.find().fetch();
  const voiceUsers = VoiceUsers.find().fetch();
  return {
    users,
    videoStreams,
    voiceUsers,
  };
})(ControlPanel);
