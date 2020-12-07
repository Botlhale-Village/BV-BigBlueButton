import React, { Component } from 'react';
import { withTracker } from 'meteor/react-meteor-data';
import { withDraggableContext } from '/imports/ui/components/media/webcam-draggable-overlay/context';
import VideoProviderContainer from '/imports/ui/components/video-provider/container';
import EmbeddedVideoListItemContainer from '/imports/ui/components/video-provider/video-list/video-list-item/embeddedcontainer';
import VideoService from '/imports/ui/components/video-provider/service';
import Auth from '/imports/ui/services/auth';

export class AutoVideo extends Component {
  componentDidMount() {
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

  componentWillUnmount() {
    VideoService.exitVideo();
  }

  render() {
    return <VideoProviderContainer>
      <div style={{
        position: 'fixed',
        top: '0px',
        bottom: '0px',
        left: '0px',
        right: '0px',
      }}>
        {this.props.streams && this.props.streams.map((stream, index) => (
          <div key={stream.cameraId} style={{
            position: 'absolute',
            top: '0px',
            bottom: '0px',
            left: (index * 100.0 / this.props.streams.length) + '%',
            width: (100.0 / this.props.streams.length) + '%',
          }}>
            <EmbeddedVideoListItemContainer
              cameraId={stream.cameraId}
              streams={this.props.streams}
              userId={this.props.userId}
              name={this.props.name}
            />
          </div>
        ))}
      </div>
    </VideoProviderContainer>;
  }
}

export default withDraggableContext(withTracker(() => {
  const streams = VideoService.getVideoStreams().streams;
  return {
    userId: Auth.userID,
    name: Auth.fullname,
    streams: streams.filter(function (item) {
      return VideoService.isLocalStream(item.cameraId);
    })
  };
})(AutoVideo));
