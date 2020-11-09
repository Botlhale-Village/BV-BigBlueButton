import React, { Component } from 'react';
import { withTracker } from 'meteor/react-meteor-data';
import VideoStreams from '/imports/api/video-streams';
import VideoController from './service';

const screenStyle = {
  position: 'fixed',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  overflow: 'hidden',
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
    this.controller = new VideoController();
  }

  componentDidMount() {
    this.controller.init();
    this.controller.update();
  }

  componentDidUpdate() {
    this.controller.update();
  }

  componentWillUnmount() {
    this.controller.dispose();
  }

  render() {
    const total = Math.ceil(this.props.videoStreams.length / this.props.total);
    const cols = total ? Math.ceil(Math.sqrt(total)) : 1;
    const rows = total ? Math.ceil(total / cols) : 1;
    const capacity = cols * rows;
    return <div style={screenStyle}>{this.generateGrid(rows, cols, capacity * (this.props.index - 1))}</div>;
  }

  generateGrid(rows, cols, index) {
    const list = [];
    const height = `${100.0 / rows}%`;
    for (let y = 0; y < rows; y++) {
      const style = { ...rowStyle, height };
      if (y < (rows - 1)) { style.borderBottom = '1px solid black'; }
      list.push(<div key={y} style={style}>{this.generateGridCols(cols, y * cols + index)}</div>);
    }
    return list;
  }

  generateGridCols(cols, index) {
    const list = [];
    const width = `${100.0 / cols}%`;
    for (let x = 0; x < cols; x++) {
      const style = { ...colStyle, width };
      if (x < (cols - 1)) { style.borderRight = '1px solid black'; }
      list.push(<div key={x} style={style}>{this.generateVideo(index + x)}</div>);
    }
    return list;
  }

  generateVideo(index) {
    if (!this.props.videoStreams[index]
        || !this.props.videoStreams[index].stream) {
      this.controller.setVideoStream(index, null);
      return null;
    }
    this.controller.setVideoStream(index, this.props.videoStreams[index].stream);
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
  const videoStreams = VideoStreams.find().fetch();
  return {
    videoStreams,
    ...props,
  };
})(ScreenDisplay);
