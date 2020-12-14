import React from 'react';
import { withTracker } from 'meteor/react-meteor-data';
import VideoList from '/imports/ui/components/video-provider/video-list/component';
import VideoService from '/imports/ui/components/video-provider/service';
import { VideoProviderContext } from '../component';

import HybeFlexService, { HybeFlexAppMode } from '/imports/api/hybeflex/client';

const VideoListContainer = ({ children, ...props }) => {
  const { streams } = props;
  return (!streams.length ? null : <VideoList {...props}>{children}</VideoList>);
};

const withVideoConsumer = Component => props => (
  <VideoProviderContext.Consumer>
    {contexts => <Component {...props} {...contexts} />}
  </VideoProviderContext.Consumer>
);

export default withVideoConsumer(withTracker(props => ({
  streams: props.streams,
  onMount: props.onMount,
  swapLayout: props.swapLayout,
  numberOfPages: VideoService.getNumberOfPages(),
  currentVideoPageIndex: props.currentVideoPageIndex,
  selectedVideoChildren: props.selectedVideoChildren,
  selectedVideoCameraId: props.selectedVideoCameraId,
  showClassFeed: HybeFlexService.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT
}))(VideoListContainer));
