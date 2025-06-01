import { io, Socket } from 'socket.io-client';
import SimplePeer from 'simple-peer';
import { Howl } from 'howler';
import { Participant, User } from '../types';

class WebRTCService {
  private socket: Socket;
  private peers: Map<string, SimplePeer.Instance> = new Map();
  private localStream: MediaStream | null = null;
  private onParticipantStreamHandler: (userId: string, stream: MediaStream) => void = () => {};
  private onParticipantJoinHandler: (participant: Participant, isInitiator: boolean) => void = () => {};
  private onParticipantLeaveHandler: (userId: string) => void = () => {};
  private joinSound: Howl;
  private socketIdToUserIdMap: Map<string, string> = new Map();

  constructor() {
    // Initialize socket connection
    this.socket = io(import.meta.env.VITE_API_URL?.replace('/api', '') || 'http://localhost:3000', {
      transports: ['websocket'],
      upgrade: false
    });
    
    // Initialize join sound with lower volume and limited pool
    this.joinSound = new Howl({
      src: ['https://www.soundjay.com/button/sounds/button-09.mp3'],
      html5: true,
      preload: true,
      volume: 0.3,
      pool: 2 // Limit the audio pool size
    });
    
    this.setupSocketListeners();
  }

  private setupSocketListeners() {
    this.socket.on('connect', () => {
      console.log('Socket connected:', this.socket.id);
    });

    this.socket.on('user-joined', ({ remoteSocketId, participant, isInitiator }) => {
      console.log('User joined:', remoteSocketId, participant.id, isInitiator);
      this.socketIdToUserIdMap.set(remoteSocketId, participant.id);
      
      if (this.localStream) {
        this.createPeer(remoteSocketId, isInitiator);
        
        // Only play join sound for non-initiator to avoid double sounds
        if (!isInitiator) {
          this.joinSound.play();
        }
        
        if (this.onParticipantJoinHandler) {
          this.onParticipantJoinHandler(participant, isInitiator);
        }
      }
    });

    this.socket.on('signal', ({ from, signal }) => {
      console.log('Received signal from:', from);
      const peer = this.peers.get(from);
      if (peer) {
        try {
          peer.signal(signal);
        } catch (error) {
          console.error('Error processing signal:', error);
          this.removePeer(from);
        }
      }
    });

    this.socket.on('user-left', ({ remoteSocketId, userId }) => {
      console.log('User left:', remoteSocketId, userId);
      this.removePeer(remoteSocketId);
      if (this.onParticipantLeaveHandler) {
        this.onParticipantLeaveHandler(userId);
      }
    });

    this.socket.on('session-ended', () => {
      this.handleSessionEnded();
    });

    this.socket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
    });
  }

  private createPeer(remoteSocketId: string, isInitiator: boolean) {
    try {
      if (!this.localStream) {
        throw new Error('Local stream not available');
      }

      console.log('Creating peer connection:', remoteSocketId, isInitiator);

      const peer = new SimplePeer({
        initiator: isInitiator,
        stream: this.localStream,
        trickle: false,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });

      peer.on('signal', (signal) => {
        console.log('Generated signal for peer:', remoteSocketId);
        this.socket.emit('signal', {
          to: remoteSocketId,
          signal
        });
      });

      peer.on('stream', (stream) => {
        console.log('Received stream from peer:', remoteSocketId);
        const userId = this.socketIdToUserIdMap.get(remoteSocketId);
        if (userId && this.onParticipantStreamHandler) {
          this.onParticipantStreamHandler(userId, stream);
        }
      });

      peer.on('error', (err) => {
        console.error('Peer connection error:', err);
        this.removePeer(remoteSocketId);
      });

      peer.on('close', () => {
        console.log('Peer connection closed:', remoteSocketId);
        this.removePeer(remoteSocketId);
      });

      this.peers.set(remoteSocketId, peer);
      console.log('Peer created successfully');
    } catch (error) {
      console.error('Error creating peer:', error);
      this.removePeer(remoteSocketId);
    }
  }

  private removePeer(remoteSocketId: string) {
    const peer = this.peers.get(remoteSocketId);
    if (peer) {
      try {
        peer.destroy();
      } catch (error) {
        console.error('Error destroying peer:', error);
      }
      this.peers.delete(remoteSocketId);
      this.socketIdToUserIdMap.delete(remoteSocketId);
    }
  }

  private handleSessionEnded() {
    this.peers.forEach(peer => {
      try {
        peer.destroy();
      } catch (error) {
        console.error('Error destroying peer on session end:', error);
      }
    });
    
    this.peers.clear();
    this.socketIdToUserIdMap.clear();
    
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
  }

  public joinSession(sessionId: string, localStream: MediaStream, user: User) {
    console.log('Joining session:', sessionId);
    
    // Store local stream
    this.localStream = localStream;
    
    // Emit join event
    this.socket.emit('join-session', { 
      sessionId, 
      user: {
        ...user,
        socketId: this.socket.id
      }
    });
  }

  public leaveSession() {
    // Clean up peers
    this.peers.forEach(peer => {
      try {
        peer.destroy();
      } catch (error) {
        console.error('Error destroying peer on leave:', error);
      }
    });
    
    this.peers.clear();
    this.socketIdToUserIdMap.clear();
    
    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    
    // Emit leave event
    this.socket.emit('leave-session');
  }

  public updateStream(newStream: MediaStream) {
    this.localStream = newStream;
    
    // Update stream for all peers
    this.peers.forEach(peer => {
      // Remove old stream
      if (peer.streams[0]) {
        peer.removeStream(peer.streams[0]);
      }
      
      // Add new stream
      try {
        peer.addStream(newStream);
      } catch (error) {
        console.error('Error updating peer stream:', error);
      }
    });
  }

  public setOnParticipantStream(handler: (userId: string, stream: MediaStream) => void) {
    this.onParticipantStreamHandler = handler;
  }

  public setOnParticipantJoin(handler: (participant: Participant, isInitiator: boolean) => void) {
    this.onParticipantJoinHandler = handler;
  }

  public setOnParticipantLeave(handler: (userId: string) => void) {
    this.onParticipantLeaveHandler = handler;
  }

  public endSession() {
    this.socket.emit('end-session');
    this.leaveSession();
  }
}

export const webRTCService = new WebRTCService();