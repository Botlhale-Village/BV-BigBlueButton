import React from 'react';
import { withTracker } from 'meteor/react-meteor-data';
import VoiceUsers from '/imports/api/voice-users/';
import VideoListItem from './component';
import { VideoProviderContext } from '../../component';

const VideoListItemContainer = props => (
  <VideoListItem {...props} />
);

const withVideoConsumer = Component => props => (
  <VideoProviderContext.Consumer>
    {contexts => <Component {...props} {...contexts} />}
  </VideoProviderContext.Consumer>
);

export default withVideoConsumer(withTracker((props) => {
  return {
    cameraId: props.cameraId,
    numOfStreams: props.streams.length,
    userId: props.userId,
    name: props.name,
    voiceUser: VoiceUsers.findOne({ intId: props.userId }),
    onMount: (videoRef) => { props.onMount(props.cameraId, videoRef); },
    actions: []
  }

})(VideoListItemContainer));
