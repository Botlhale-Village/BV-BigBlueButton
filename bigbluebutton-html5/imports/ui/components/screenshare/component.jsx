import React from 'react';
import { defineMessages, injectIntl, intlShape } from 'react-intl';
import PropTypes from 'prop-types';
import _ from 'lodash';
import FullscreenService from '../fullscreen-button/service';
import FullscreenButtonContainer from '../fullscreen-button/container';
import { styles } from './styles';
import MediaService, { getSwapLayout } from '../media/service';
import AutoplayOverlay from '../media/autoplay-overlay/component';
import logger from '/imports/startup/client/logger';
import playAndRetry from '/imports/utils/mediaElementPlayRetry';

import HybeFlexService, { HybeFlexAppMode } from '/imports/api/hybeflex/client';

const intlMessages = defineMessages({
  screenShareLabel: {
    id: 'app.screenshare.screenShareLabel',
    description: 'screen share area element label',
  },
  autoplayBlockedDesc: {
    id: 'app.media.screenshare.autoplayBlockedDesc',
  },
  autoplayAllowLabel: {
    id: 'app.media.screenshare.autoplayAllowLabel',
  },
});

const ALLOW_FULLSCREEN = Meteor.settings.public.app.allowFullscreen;

class ScreenshareComponent extends React.Component {
  constructor() {
    super();
    this.state = {
      loaded: false,
      isFullscreen: false,
      autoplayBlocked: false,
    };

    this.thumbTag = null;
    this.publishedStream = null;
    this.onVideoLoad = this.onVideoLoad.bind(this);
    this.onFullscreenChange = this.onFullscreenChange.bind(this);
    this.handleAllowAutoplay = this.handleAllowAutoplay.bind(this);
    this.handlePlayElementFailed = this.handlePlayElementFailed.bind(this);
    this.onThumbnailUpdate = this.onThumbnailUpdate.bind(this);
    this.failedMediaElements = [];
  }

  componentDidMount() {
    const { presenterScreenshareHasStarted } = this.props;

    presenterScreenshareHasStarted();

    this.screenshareContainer.addEventListener('fullscreenchange', this.onFullscreenChange);
    window.addEventListener('screensharePlayFailed', this.handlePlayElementFailed);
    
    this.updateThumbnailPublish();
  }

  UNSAFE_componentWillReceiveProps(nextProps) {
    const {
      isPresenter, unshareScreen,
    } = this.props;
    if (isPresenter && !nextProps.isPresenter) {
      unshareScreen();
    }
  }

  componentDidUpdate() {
    this.updateThumbnailPublish();
  }

  componentWillUnmount() {
    const {
      presenterScreenshareHasEnded,
      unshareScreen,
      getSwapLayout,
      shouldEnableSwapLayout,
      toggleSwapLayout,
    } = this.props;
    if (this.thumbwatch) { this.thumbwatch.remove(); this.thumbwatch = null; }
    if (this.publishedStream) { this.publishedStream.remove(); this.publishedStream = null; }
    const layoutSwapped = getSwapLayout() && shouldEnableSwapLayout();
    if (layoutSwapped) toggleSwapLayout();
    //presenterScreenshareHasEnded();
    //unshareScreen();
    this.screenshareContainer.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('screensharePlayFailed', this.handlePlayElementFailed);
  }

  updateThumbnailPublish() {
    if (this.props.isPresenter && this.videoTag) {
      if (this.thumbwatch) { this.thumbwatch.remove(); this.thumbwatch = null; }
      if (this.publishedStream) {
        if (this.publishedStream.element === this.videoTag) { return; }
        this.publishedStream.remove();
        this.publishedStream = null;
      }
      this.publishedStream = HybeFlexService.addPublishedStream('screenshare', this.videoTag);
    } else {
      if (this.publishedStream) { this.publishedStream.remove(); this.publishedStream = null; }
      if (this.props.isPresenter || !HybeFlexService.isUsingThumbnails() ||
         (this.props.selectedVideoCameraId && this.props.selectedVideoCameraId != 'screenshare')) {
        if (this.thumbwatch) { this.thumbwatch.remove(); this.thumbwatch = null; }
      } else {
        this.thumbwatch = HybeFlexService.watchStreamThumbnail('screenshare', this.onThumbnailUpdate);
        if (!this.state.loaded) { this.setState({ loaded: true }); }
      }
    }
  }

  onThumbnailUpdate(src) {
    if (this.thumbTag) {
      this.thumbTag.src = src;
    }
  }

  onVideoLoad() {
    this.setState({ loaded: true });
    this.updateThumbnailPublish();
  }

  onFullscreenChange() {
    const { isFullscreen } = this.state;
    const newIsFullscreen = FullscreenService.isFullScreen(this.screenshareContainer);
    if (isFullscreen !== newIsFullscreen) {
      this.setState({ isFullscreen: newIsFullscreen });
    }
  }

  handleAllowAutoplay() {
    const { autoplayBlocked } = this.state;

    logger.info({
      logCode: 'screenshare_autoplay_allowed',
    }, 'Screenshare media autoplay allowed by the user');

    window.removeEventListener('screensharePlayFailed', this.handlePlayElementFailed);
    while (this.failedMediaElements.length) {
      const mediaElement = this.failedMediaElements.shift();
      if (mediaElement) {
        const played = playAndRetry(mediaElement);
        if (!played) {
          logger.error({
            logCode: 'screenshare_autoplay_handling_failed',
          }, 'Screenshare autoplay handling failed to play media');
        } else {
          logger.info({
            logCode: 'screenshare_viewer_media_play_success',
          }, 'Screenshare viewer media played successfully');
        }
      }
    }
    if (autoplayBlocked) { this.setState({ autoplayBlocked: false }); }
  }

  handlePlayElementFailed(e) {
    const { mediaElement } = e.detail;
    const { autoplayBlocked } = this.state;

    e.stopPropagation();
    this.failedMediaElements.push(mediaElement);
    if (!autoplayBlocked) {
      logger.info({
        logCode: 'screenshare_autoplay_prompt',
      }, 'Prompting user for action to play screenshare media');

      this.setState({ autoplayBlocked: true });
    }
  }

  renderFullscreenButton() {
    const { intl } = this.props;
    const { isFullscreen } = this.state;

    if (!ALLOW_FULLSCREEN) return null;

    return (
      <FullscreenButtonContainer
        key={_.uniqueId('fullscreenButton-')}
        elementName={intl.formatMessage(intlMessages.screenShareLabel)}
        fullscreenRef={this.screenshareContainer}
        isFullscreen={isFullscreen}
        dark
      />
    );
  }

  render() {
    const { loaded, autoplayBlocked, isFullscreen } = this.state;
    const { intl, selectedVideoCameraId, isPresenter } = this.props;

    return (
      [!loaded
        ? (
          <div
            key={_.uniqueId('screenshareArea-')}
            className={styles.connecting}
          />
        )
        : null,
      !autoplayBlocked
        ? null
        : (
          <AutoplayOverlay
            key={_.uniqueId('screenshareAutoplayOverlay')}
            autoplayBlockedDesc={intl.formatMessage(intlMessages.autoplayBlockedDesc)}
            autoplayAllowLabel={intl.formatMessage(intlMessages.autoplayAllowLabel)}
            handleAllowAutoplay={this.handleAllowAutoplay}
          />
        ),
      (
        <div
          className={styles.screenshareContainer}
          key="screenshareContainer"
          ref={(ref) => { this.screenshareContainer = ref; }}
        >
          {loaded && this.renderFullscreenButton()}
          { (!isPresenter && HybeFlexService.isUsingThumbnails() &&
            (!selectedVideoCameraId || selectedVideoCameraId != 'screenshare')) ?
            <img
              style={{ maxHeight: '100%', width: '100%', height: '100%' }}
              ref={(ref) => { this.thumbTag = ref; this.videoTag = null; }}
              onClick={() => {
                if (isFullscreen) { return; }
                if (HybeFlexService.appMode != HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT &&
                    HybeFlexService.appMode != HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER) { return; }
                if (getSwapLayout()) { MediaService.toggleSwapLayout(); }
                HybeFlexService.setSelectedVideoCameraId('screenshare');
              }}
              className={(!isFullscreen &&
                (HybeFlexService.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT ||
                 HybeFlexService.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER) &&
                selectedVideoCameraId != 'screenshare') ? styles.cursorPointer : ''}
            /> :
            <video
              id="screenshareVideo"
              key="screenshareVideo"
              style={{ maxHeight: '100%', width: '100%', height: '100%' }}
              playsInline
              onLoadedData={this.onVideoLoad}
              ref={(ref) => { this.videoTag = ref; this.thumbTag = null; }}
              onClick={() => {
                if (isFullscreen) { return; }
                if (HybeFlexService.appMode != HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT &&
                    HybeFlexService.appMode != HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER) { return; }
                if (getSwapLayout()) { MediaService.toggleSwapLayout(); }
                HybeFlexService.setSelectedVideoCameraId('screenshare');
              }}
              className={(!isFullscreen &&
                (HybeFlexService.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_STUDENT ||
                 HybeFlexService.appMode == HybeFlexAppMode.HYBEFLEX_APP_MODE_LECTURER) &&
                selectedVideoCameraId != 'screenshare') ? styles.cursorPointer : ''}
              muted
            />
          }
        </div>
      )]
    );
  }
}

export default injectIntl(ScreenshareComponent);

ScreenshareComponent.propTypes = {
  intl: intlShape.isRequired,
  isPresenter: PropTypes.bool.isRequired,
  unshareScreen: PropTypes.func.isRequired,
  presenterScreenshareHasEnded: PropTypes.func.isRequired,
  presenterScreenshareHasStarted: PropTypes.func.isRequired,
};
