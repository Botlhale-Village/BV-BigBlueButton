import React from 'react';
import { withTracker } from 'meteor/react-meteor-data';
import VideoProvider from './component';
import VideoService from './service';

const VideoProviderContainer = ({ children, ...props }) => (
  <VideoProvider {...props}>{children}</VideoProvider>
);

export default withTracker(props => {
  // getVideoStreams returns a dictionary consisting of:
  // {
  //  streams: array of mapped streams
  //  totalNumberOfStreams: total number of shared streams in the server
  // }
  const {
    streams,
    totalNumberOfStreams
  } = VideoService.getVideoStreams();

  return {
    swapLayout: props.swapLayout,
    streams,
    totalNumberOfStreams,
    isUserLocked: VideoService.isUserLocked(),
    currentVideoPageIndex: VideoService.getCurrentVideoPageIndex(),
    children: props.children,
    selectedVideoChildren: props.selectedVideoChildren,
    selectedVideoCameraId: props.selectedVideoCameraId,
  };
})(VideoProviderContainer);
