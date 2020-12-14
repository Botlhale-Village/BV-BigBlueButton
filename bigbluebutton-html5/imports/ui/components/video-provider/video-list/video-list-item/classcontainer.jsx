import React, { Component }  from 'react';
import { withTracker } from 'meteor/react-meteor-data';
import cx from 'classnames';
import { styles } from '../styles';

import HybeFlexService from '/imports/api/hybeflex/client';

class VideoItemClassContainer extends Component {
  constructor(props) {
    super(props);
    this.thumbTag = null;
    this.onThumbnailUpdate = this.onThumbnailUpdate.bind(this);
  }

  componentDidMount() {
    this.activeStream = this.props.activeStream;
    if (this.thumbwatch) { this.thumbwatch.remove(); this.thumbwatch = null; }
    this.thumbwatch = HybeFlexService.watchStreamThumbnail(this.props.activeStream, this.onThumbnailUpdate);
  }

  componentDidUpdate() {
    if (this.activeStream !== this.props.activeStream) {
      this.activeStream = this.props.activeStream;
      if (this.thumbwatch) { this.thumbwatch.remove(); this.thumbwatch = null; }
      this.thumbwatch = HybeFlexService.watchStreamThumbnail(this.props.activeStream, this.onThumbnailUpdate);
    }
  }

  componentWillUnmount() {
    if (this.thumbwatch) { this.thumbwatch.remove(); this.thumbwatch = null; }
  }

  onThumbnailUpdate(src) {
    if (this.thumbTag) {
      this.thumbTag.src = src;
    }
  }

  render() {
    return (
      <div className={cx({
        [styles.content]: true
      })}
      >
        <div
          className={styles.videoContainer}
        >
          <img
            className={cx({
              [styles.media]: true,
              [styles.classFeedSelected]: this.props.isSelected,
              [styles.classFeedUnselected]: !this.props.isSelected,
            })}
            onClick={() => {
              HybeFlexService.setSelectedVideoCameraId('class');
            }}
            ref={(ref) => { this.thumbTag = ref; }}
          />
        </div>
        <div className={styles.info}>
          <div className={isFirefox ? styles.dropdownFireFox
            : styles.dropdown}
          >
            <span className={cx({
              [styles.userName]: true,
              [styles.noMenu]: true,
            })}
            >
              Class Feed
            </span>
          </div>
        </div>
      </div>
    );
  }
}

export default withTracker((props) => {
  return {
    activeStream: HybeFlexService.getActiveStream(),
    isSelected: HybeFlexService.classStreamSelected
  };
})(VideoItemClassContainer);
