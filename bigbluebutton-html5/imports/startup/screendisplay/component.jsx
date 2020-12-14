import React, { Component } from 'react';
import { withTracker } from 'meteor/react-meteor-data';
import VideoService from '/imports/ui/components/video-provider/service';
import VideoController from './service';

import HybeFlexService from '/imports/api/hybeflex/client';

const screenStyle = {
  position: 'fixed',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  overflow: 'hidden',
};

const screenNum = {
  position: 'fixed',
  right: '10px',
  width: '50%',
  bottom: '10px',
  height: '24px',
  fontSize: '24px',
  textAlign: 'right',
  color: 'white'
};

const screenDbg = {
  position: 'fixed',
  right: '0px',
  width: '100%',
  bottom: '0px',
  height: '100%',
  fontSize: '48px',
  textAlign: 'left',
  color: 'blue'
};

const rowStyle = {
  display: 'block',
  width: '100%',
  overflow: 'hidden',
};

const colStyle = {
  display: 'block',
  float: 'left',
  height: '100%',
  overflow: 'hidden',
};

const videoStyle = {
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

export class ScreenDisplay extends Component {
  constructor(props) {
    super(props);
    this.controller = new VideoController(props.screenLayout);
  }

  componentDidMount() {
    this.controller.init();
  }
  
  componentWillUpdate(newProps) {
    if (this.controller.screenLayout !== newProps.screenLayout) {
      this.controller.dispose();
      this.controller = new VideoController(newProps.screenLayout);
    }
  }

  componentDidUpdate() {
    this.controller.update();
  }

  componentWillUnmount() {
    this.controller.dispose();
  }

  render() {
    /*<div style={screenDbg}>{JSON.stringify(this.props.screenLayout, null, 2)}</div>*/
    return <div style={screenStyle}>
      {this.generateGrid(this.props.screenLayout)}
      <div style={screenNum}>{this.props.screenLayout.screenIndex + 1} of {this.props.screenLayout.screenCount}</div>
    </div>;
  }

  generateGrid(layout) {
    const list = [];
    const height = `${100.0 / layout.rows}%`;
    const style = { ...rowStyle, height };
    for (let y = 0; y < layout.rows; y++) {
      if (y < (layout.rows - 1)) { style.borderBottom = '1px solid black'; }
      list.push(<div key={y} style={style}>{this.generateGridCols(layout, y * layout.cols)}</div>);
    }
    return list;
  }

  generateGridCols(layout, index) {
    const list = [];
    const width = `${100.0 / layout.cols}%`;
    const style = { ...colStyle, width };
    for (let x = 0; x < layout.cols; x++) {
      if (x < (layout.cols - 1)) { style.borderRight = '1px solid black'; }
      list.push(<div key={x} style={style}>{this.generateVideo(index + x)}</div>);
    }
    return list;
  }

  generateVideo(index) {
    if (HybeFlexService.isUsingThumbnails()) {
      return (
        <img
          style={videoStyle}
          ref={(ref) => { this.controller.setThumbTag(index, ref); }}
        />
      );
    }
    return (
      <video
        muted
        style={videoStyle}
        ref={(ref) => { this.controller.setVideoTag(index, ref); }}
        autoPlay
        playsInline
      />
    );
  }
}

export default withTracker((props) => {
  HybeFlexService.appModeTracker.depend();
  HybeFlexService.buildScreenLayout(VideoService.getVideoStreams().streams);
  return {
    screenLayout: HybeFlexService.getActiveScreenLayout(),
    ...props,
  };
})(ScreenDisplay);
