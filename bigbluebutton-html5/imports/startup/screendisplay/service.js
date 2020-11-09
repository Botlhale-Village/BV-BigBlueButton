import ReconnectingWebSocket from 'reconnecting-websocket';
import { tryGenerateIceCandidates } from '/imports/utils/safari-webrtc';
import { fetchWebRTCMappedStunTurnServers, getMappedFallbackStun } from '/imports/utils/fetchStunTurnServers';
import Auth from '/imports/ui/services/auth';
import logger from '/imports/startup/client/logger';
import VideoService from '/imports/ui/components/video-provider/service';

const {
  baseTimeout: CAMERA_SHARE_FAILED_WAIT_TIME = 15000,
  maxTimeout: MAX_CAMERA_SHARE_FAILED_WAIT_TIME = 60000,
} = Meteor.settings.public.kurento.cameraTimeouts || {};
const WS_CONN_TIMEOUT = Meteor.settings.public.kurento.wsConnectionTimeout || 4000;
const ROLE_VIEWER = Meteor.settings.public.user.role_viewer;
const PING_INTERVAL = 15000;

export default class VideoController {
  constructor() {
    this.streamInfo = [];
    this.webRtcPeers = {};
    this.restartTimeout = {};
    this.restartTimer = {};
    this.disposed = false;
    this.pingInterval = null;

    this.info = VideoService.getInfo();

    this.wsQueue = [];
    this.ws = new ReconnectingWebSocket(
      VideoService.getAuthenticatedURL(),
      [],
      { connectionTimeout: WS_CONN_TIMEOUT },
    );

    this.ws.onopen = this.onWsOpen = this.onWsOpen.bind(this);
    this.ws.onclose = this.onWsClose = this.onWsClose.bind(this);
    this.ws.onmessage = this.onWsMessage = this.onWsMessage.bind(this);
    this.ping = this.ping.bind(this);
  }

  setVideoTag(index, tag) {
    if (this.disposed) { return; }
    const stream = this.streamInfo[index] || (this.streamInfo[index] = new VideoStreamHandler(this));
    stream.videoTag = tag;
  }

  setVideoStream(index, cameraId) {
    if (this.disposed) { return; }
    const stream = this.streamInfo[index] || (this.streamInfo[index] = new VideoStreamHandler(this));
    stream.cameraId = cameraId;
  }

  init() {
    window.addEventListener('offline', this.onWsClose);
  }

  update() {
    if (this.disposed) { return; }
    const cameraIds = {};
    this.streamInfo.forEach((item) => {
      if (item && item.cameraId && item.videoTag) { cameraIds[item.cameraId] = 1; }
    });

    Object.keys(this.webRtcPeers).forEach((cameraId) => {
      if (!cameraIds[cameraId]) { this.stopWebRTCPeer(cameraId, false); }
    });

    Object.keys(cameraIds).forEach((cameraId) => {
      if (!this.webRtcPeers[cameraId]) { this.createWebRTCPeer(cameraId); }
    });

    this.streamInfo.forEach((item) => { if (item) { item.update(); } });
  }

  dispose() {
    this.ws.onmessage = null;
    this.ws.onopen = null;
    this.ws.onclose = null;

    // window.removeEventListener('online', this.openWs);
    window.removeEventListener('offline', this.onWsClose);

    this.disposed = true;
    this.streamInfo.forEach((item) => { if (item) { item.stop(); } });
    this.streamInfo = [];

    Object.keys(this.webRtcPeers).forEach((cameraId) => {
      this.stopWebRTCPeer(cameraId, false);
    });

    // Close websocket connection to prevent multiple reconnects from happening
    this.onWsClose();
    this.ws.close();
  }

  // /////////////////// Internal /////////////////////////

  onWsMessage(message) {
    const parsedMessage = JSON.parse(message.data);
    if (parsedMessage.id === 'pong') return;
    switch (parsedMessage.id) {
      case 'startResponse': this.startResponse(parsedMessage); break;
      case 'playStart': this.handlePlayStart(parsedMessage); break;
      case 'playStop': this.handlePlayStop(parsedMessage); break;
      case 'iceCandidate': this.handleIceCandidate(parsedMessage); break;
      case 'pong': break;
      case 'error': default: this.handleSFUError(parsedMessage); break;
    }
  }

  onWsClose() {
    logger.debug({
      logCode: 'video_provider_onwsclose',
    }, 'Multiple video provider websocket connection closed.');

    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  onWsOpen() {
    logger.debug({
      logCode: 'video_provider_onwsopen',
    }, 'Multiple video provider websocket connection opened.');

    // Resend queued messages that happened when socket was not connected
    while (this.wsQueue.length > 0) { this.sendMessage(this.wsQueue.pop()); }
    if (this.pingInterval !== null) { clearInterval(this.pingInterval); }
    this.pingInterval = setInterval(this.ping, PING_INTERVAL);
  }

  ping() {
    const message = { id: 'ping' };
    this.sendMessage(message);
  }

  sendMessage(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      const jsonMessage = JSON.stringify(message);
      this.ws.send(jsonMessage, (error) => {
        if (error) {
          logger.error({
            logCode: 'video_provider_ws_send_error',
            extraInfo: {
              sfuRequest: message,
              error,
            },
          }, `WebSocket failed when sending request to SFU due to ${error.message}`);
        }
      });
    } else if (message.id !== 'stop' && message.id !== 'ping') {
      // No need to queue video stop (or ping) messages
      this.wsQueue.push(message);
    }
  }

  handlePlayStop(message) {
    const { cameraId } = message;

    logger.info({
      logCode: 'video_provider_handle_play_stop',
      extraInfo: {
        cameraId,
        sfuRequest: message,
      },
    }, `Received request from SFU to stop camera ${cameraId}`);

    this.stopWebRTCPeer(cameraId, false);
  }

  handlePlayStart(message) {
    const { cameraId } = message;
    const peer = this.webRtcPeers[cameraId];

    if (peer) {
      logger.info({
        logCode: 'video_provider_handle_play_start_flowing',
        extraInfo: {
          cameraId,
          sfuResponse: message,
        },
      }, `SFU says that media is flowing for camera ${cameraId}`);

      peer.started = true;

      // Clear camera shared timeout when camera succesfully starts
      clearTimeout(this.restartTimeout[cameraId]);
      delete this.restartTimeout[cameraId];
      delete this.restartTimer[cameraId];

      this.streamInfo.forEach((item) => { if (item && item.cameraId == cameraId) { item.update(); } });
    } else {
      logger.warn({ logCode: 'video_provider_playstart_no_peer' },
        `SFU playStart response for ${cameraId} arrived after the peer was discarded, ignore it.`);
    }
  }

  handleSFUError(message) {
    const { code, reason, streamId } = message;
    const cameraId = streamId;
    logger.error({
      logCode: 'video_provider_handle_sfu_error',
      extraInfo: {
        error: message,
        cameraId,
      },
    }, `SFU returned error for camera ${cameraId}. Code: ${code}, reason: ${reason}`);

    this.stopWebRTCPeer(cameraId, true);
  }

  handleIceCandidate(message) {
    const { cameraId, candidate } = message;
    const peer = this.webRtcPeers[cameraId];

    logger.debug({
      logCode: 'video_provider_ice_candidate_received',
      extraInfo: {
        candidate,
      },
    }, `video-provider received candidate for ${cameraId}: ${JSON.stringify(candidate)}`);

    if (peer) {
      if (!peer.inboundIceQueue) { peer.inboundIceQueue = []; }
      peer.inboundIceQueue.push(candidate);
      if (peer.didSDPAnswered) {
        // ICE candidates are queued until a SDP answer has been processed.
        // This was done due to a long term iOS/Safari quirk where it'd
        // fail if candidates were added before the offer/answer cycle was completed.
        // Dunno if that still happens, but it works even if it slows the ICE checks
        // a bit  - prlanzarin july 2019
        this.processInboundIceQueue(peer, cameraId);
      }
    } else {
      logger.warn({
        logCode: 'video_provider_addicecandidate_no_peer',
      }, `SFU ICE candidate for ${cameraId} arrived after the peer was discarded, ignore it.`);
    }
  }

  startResponse(message) {
    const { cameraId, role } = message;
    const peer = this.webRtcPeers[cameraId];

    logger.info({
      logCode: 'video_provider_start_response_success',
      extraInfo: {
        cameraId,
        sfuResponse: message,
      },
    }, `Camera start request was accepted by SFU, processing response for ${cameraId}`);

    if (peer) {
      peer.processAnswer(message.sdpAnswer, (error) => {
        if (error) {
          logger.error({
            logCode: 'video_provider_peerconnection_processanswer_error',
            extraInfo: {
              cameraId,
              error,
            },
          }, `Processing SDP answer from SFU for ${cameraId} failed due to ${error.message}`);

          return;
        }

        peer.didSDPAnswered = true;

        this.processOutboundIceQueue(peer, role, cameraId);
        this.processInboundIceQueue(peer, cameraId);
      });
    } else {
      logger.warn({
        logCode: 'video_provider_startresponse_no_peer',
      }, `SFU start response for ${cameraId} arrived after the peer was discarded, ignore it.`);
    }
  }

  processOutboundIceQueue(peer, role, cameraId) {
    if (!peer.outboundIceQueue) { return; }
    while (peer.outboundIceQueue.length) {
      const candidate = peer.outboundIceQueue.shift();
      this.sendIceCandidateToSFU(peer, role, candidate, cameraId);
    }
  }

  processInboundIceQueue(peer, cameraId) {
    if (!peer.inboundIceQueue) { return; }
    while (peer.inboundIceQueue.length) {
      const candidate = peer.inboundIceQueue.shift();
      peer.addIceCandidate(candidate, (error) => {
        if (error) {
          // Just log the error. We can't be sure if a candidate failure on add is
          // fatal or not, so that's why we have a timeout set up for negotiations
          // and listeners for ICE state transitioning to failures, so we won't
          // act on it here
          logger.error({
            logCode: 'video_provider_addicecandidate_error',
            extraInfo: {
              cameraId,
              error,
            },
          }, `Adding ICE candidate failed for ${cameraId} due to ${error.message}`);
        }
      });
    }
  }

  stopWebRTCPeer(cameraId, restarting) {
    // in this case, 'closed' state is not caused by an error;
    // we stop listening to prevent this from being treated as an error
    const peer = this.webRtcPeers[cameraId];
    if (peer && peer.peerConnection) {
      const conn = peer.peerConnection;
      conn.oniceconnectionstatechange = null;
    }

    logger.info({
      logCode: 'video_provider_stopping_webcam_sfu',
    }, `Sending stop request to SFU. Camera: ${cameraId}, and flag restarting ${restarting}`);

    this.sendMessage({
      id: 'stop',
      type: 'video',
      cameraId,
      role: ROLE_VIEWER,
    });

    // Clear the shared camera media flow timeout and current reconnect period
    // when destroying it if the peer won't restart
    if (!restarting) {
      if (this.restartTimeout[cameraId]) {
        clearTimeout(this.restartTimeout[cameraId]);
        delete this.restartTimeout[cameraId];
      }

      if (this.restartTimer[cameraId]) {
        delete this.restartTimer[cameraId];
      }
    }

    if (peer) {
      logger.info({
        logCode: 'video_provider_destroywebrtcpeer',
      }, `Disposing WebRTC peer ${cameraId}`);
      if (typeof peer.dispose === 'function') { peer.dispose(); }
      delete this.webRtcPeers[cameraId];
    } else {
      logger.warn({
        logCode: 'video_provider_destroywebrtcpeer_no_peer',
      }, `Peer ${cameraId} was already disposed (glare), ignore it.`);
    }
  }

  async createWebRTCPeer(cameraId) {
    let iceServers = [];
    if (this.webRtcPeers[cameraId]) { return; }
    this.webRtcPeers[cameraId] = {};

    // WebRTC restrictions may need a capture device permission to release
    // useful ICE candidates on recvonly/no-gUM peers
    try {
      await tryGenerateIceCandidates();
    } catch (error) {
      logger.error({
        logCode: 'video_provider_no_valid_candidate_gum_failure',
        extraInfo: {
          errorName: error.name,
          errorMessage: error.message,
        },
      }, `Forced gUM to release additional ICE candidates failed due to ${error.name}.`);
    }

    try {
      iceServers = await fetchWebRTCMappedStunTurnServers(Auth.sessionToken);
    } catch (error) {
      logger.error({
        logCode: 'video_provider_fetchstunturninfo_error',
        extraInfo: {
          errorCode: error.code,
          errorMessage: error.message,
        },
      }, 'video-provider failed to fetch STUN/TURN info, using default');
      // Use fallback STUN server
      iceServers = getMappedFallbackStun();
    } finally {
      const { constraints, bitrate, id: profileId } = VideoService.getCameraProfile();
      const peerOptions = {
        mediaConstraints: {
          audio: false,
          video: constraints,
        },
        onicecandidate: this.getOnIceCandidateCallback(cameraId),
      };

      if (iceServers.length > 0) {
        peerOptions.configuration = {};
        peerOptions.configuration.iceServers = iceServers;
      }

      const peer = this.webRtcPeers[cameraId] = new window.kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(peerOptions, (error) => {
        const peer = this.webRtcPeers[cameraId];

        peer.started = false;
        peer.attached = false;
        peer.didSDPAnswered = false;
        peer.isPublisher = false;
        if (peer.inboundIceQueue == null) { peer.inboundIceQueue = []; }

        if (error) { return this.onWebRTCError(error, cameraId); }

        peer.generateOffer((errorGenOffer, offerSdp) => {
          if (errorGenOffer) { return this.onWebRTCError(errorGenOffer, cameraId); }

          const message = {
            id: 'start',
            type: 'video',
            cameraId,
            role: ROLE_VIEWER,
            sdpOffer: offerSdp,
            meetingId: this.info.meetingId,
            voiceBridge: this.info.voiceBridge,
            userId: this.info.userId,
            userName: this.info.userName,
            bitrate,
            record: VideoService.getRecord(),
          };

          logger.info({
            logCode: 'video_provider_sfu_request_start_camera',
            extraInfo: {
              sfuRequest: message,
              cameraProfile: profileId,
            },
          }, `Camera offer generated. Sending start request to SFU for ${cameraId}`);

          this.sendMessage(message);

          return false;
        });

        return false;
      });

      if (peer && peer.peerConnection) {
        const conn = peer.peerConnection;
        conn.oniceconnectionstatechange = this.getOnIceConnectionStateChangeCallback(cameraId);
      }
    }
  }

  onWebRTCError(error, cameraId) {
    // 2001 means MEDIA_SERVER_OFFLINE. It's a server-wide error.
    // We only display it to a sharer/publisher instance to avoid popping up
    // redundant toasts.
    // If the client only has viewer instances, the WS will close unexpectedly
    // and an error will be shown there for them.
    if (error === 2001) { return; }

    // Only display WebRTC negotiation error toasts to sharers. The viewer streams
    // will try to autoreconnect silently, but the error will log nonetheless
    // If it's a viewer, set the reconnection timeout. There's a good chance
    // no local candidate was generated and it wasn't set.
    this.setReconnectionTimeout(cameraId);

    // shareWebcam as the second argument means it will only try to reconnect if
    // it's a viewer instance (see stopWebRTCPeer restarting argument)
    this.stopWebRTCPeer(cameraId, true);

    logger.error({
      logCode: 'video_provider_webrtc_peer_error',
      extraInfo: {
        cameraId,
        error,
      },
    }, `Camera peer creation failed for ${cameraId} due to ${error.message}`);
  }

  setReconnectionTimeout(cameraId) {
    const peer = this.webRtcPeers[cameraId];
    const peerHasStarted = peer && peer.started === true;
    const shouldSetReconnectionTimeout = !this.restartTimeout[cameraId] && !peerHasStarted;

    if (shouldSetReconnectionTimeout) {
      const newReconnectTimer = this.restartTimer[cameraId] || CAMERA_SHARE_FAILED_WAIT_TIME;
      this.restartTimer[cameraId] = newReconnectTimer;

      logger.info({
        logCode: 'video_provider_setup_reconnect',
        extraInfo: {
          cameraId,
          reconnectTimer: newReconnectTimer,
        },
      }, `Camera has a new reconnect timer of ${newReconnectTimer} ms for ${cameraId}`);

      this.restartTimeout[cameraId] = setTimeout(
        this.getWebRTCStartTimeout(cameraId),
        this.restartTimer[cameraId],
      );
    }
  }

  getWebRTCStartTimeout(cameraId) {
    return () => {
      // Create new reconnect interval time
      const oldReconnectTimer = this.restartTimer[cameraId];
      const newReconnectTimer = Math.min(
        2 * oldReconnectTimer,
        MAX_CAMERA_SHARE_FAILED_WAIT_TIME,
      );
      this.restartTimer[cameraId] = newReconnectTimer;

      // Clear the current reconnect interval so it can be re-set in createWebRTCPeer
      if (this.restartTimeout[cameraId]) {
        delete this.restartTimeout[cameraId];
      }

      // Peer that timed out is a subscriber/viewer
      // Subscribers try to reconnect according to their timers if media could
      // not reach the server. That's why we pass the restarting flag as true
      // to the stop procedure as to not destroy the timers
      logger.error({
        logCode: 'video_provider_camera_view_timeout',
        extraInfo: {
          cameraId,
          oldReconnectTimer,
          newReconnectTimer,
        },
      }, `Camera VIEWER has not succeeded in ${oldReconnectTimer} for ${cameraId}. Reconnecting.`);

      this.stopWebRTCPeer(cameraId, true);
      this.createWebRTCPeer(cameraId);
    };
  }

  getOnIceCandidateCallback(cameraId) {
    return (candidate) => {
      const peer = this.webRtcPeers[cameraId];

      // Setup a timeout only when the first candidate is generated and if the peer wasn't
      // marked as started already (which is done on handlePlayStart after
      // it was verified that media could circle through the server)
      this.setReconnectionTimeout(cameraId);

      if (peer) {
        if (!peer.outboundIceQueue) { peer.outboundIceQueue = []; }
        peer.outboundIceQueue.push(candidate);
        if (peer.didSDPAnswered) {
          this.processOutboundIceQueue(peer, ROLE_VIEWER, cameraId);
        } else {
          logger.debug({
            logCode: 'video_provider_client_candidate',
            extraInfo: { candidate },
          }, `video-provider client-side candidate queued for ${cameraId}`);
        }
      }
    };
  }

  getOnIceConnectionStateChangeCallback(cameraId) {
    const peer = this.webRtcPeers[cameraId];
    if (peer && peer.peerConnection) {
      const conn = peer.peerConnection;
      const { iceConnectionState } = conn;

      return () => {
        if (iceConnectionState === 'failed' || iceConnectionState === 'closed') {
          // prevent the same error from being detected multiple times
          conn.oniceconnectionstatechange = null;
          logger.error({
            logCode: 'video_provider_ice_connection_failed_state',
            extraInfo: {
              cameraId,
              iceConnectionState,
            },
          }, `ICE connection state transitioned to ${iceConnectionState} for ${cameraId}`);

          this.stopWebRTCPeer(cameraId, false);
        }
      };
    }
    return () => {
      logger.error({
        logCode: 'video_provider_ice_connection_failed_state',
        extraInfo: {
          cameraId,
          iceConnectionState: undefined,
        },
      }, `Missing peer at ICE connection state transition for ${cameraId}`);

      // It will only try to reconnect if
      // it's a viewer instance (see stopWebRTCPeer restarting argument)
      this.stopWebRTCPeer(cameraId, true);
    };
  }

  sendIceCandidateToSFU(peer, role, candidate, cameraId) {
    logger.debug({
      logCode: 'video_provider_client_candidate',
      extraInfo: { candidate },
    }, `video-provider client-side candidate generated for ${cameraId}: ${JSON.stringify(candidate)}`);
    const message = {
      type: 'video',
      role,
      id: 'onIceCandidate',
      candidate,
      cameraId,
    };
    this.sendMessage(message);
  }

  // //////////////////////////////////////////////////////
}

class VideoStreamHandler {
  constructor(controller) {
    this.controller = controller;
    this.videoTag = null;
    this.cameraId = null;
    this._cameraId = null;
  }

  update() {
    const elem = this.videoTag;
    if (elem !== this._videoTag) { this.stop(); }
    this._videoTag = elem;
    if (!elem) { return; }

    if (this.cameraId !== this._cameraId || !elem.srcObject) {
      this._cameraId = this.cameraId;
      if (!this.cameraId) { elem.pause(); elem.srcObject = null; return; }
      const peer = this.controller.webRtcPeers[this.cameraId];
      if (peer && peer.started) {
        elem.pause();
        elem.srcObject = peer.getRemoteStream();
        elem.load();
        peer.attached = true;
      }
    }

    if (elem.paused && elem.srcObject) {
      setTimeout(() => {
        elem.play().catch((error) => {
          // NotAllowedError equals autoplay issues, fire autoplay handling event
          if (error.name === 'NotAllowedError') {
            const tagFailedEvent = new CustomEvent('videoPlayFailed', { detail: { mediaTag: elem } });
            window.dispatchEvent(tagFailedEvent);
          }
        });
      }, 100);
    }
  }

  stop() {
    const elem = this._videoTag;
    if (elem) { elem.pause(); elem.srcObject = null; }
    this._cameraId = null;
  }
}
