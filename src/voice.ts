import { useEffect, useRef, useState } from 'react';
import { api, message } from './api';
import type { Participant, Signal } from './types';

type Peer = { pc: RTCPeerConnection; audio: HTMLAudioElement; candidates: RTCIceCandidateInit[] };
export function useVoice(
  userId: string | undefined,
  participants: Participant[],
  iceServers: RTCIceServer[],
  notify: (value: string) => void,
) {
  const stream = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, Peer>());
  const config = useRef(iceServers);
  config.current = iceServers;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(true);
  const [connected, setConnected] = useState(0);
  const [joining, setJoining] = useState(false);
  const disposePeer = (uid: string) => {
    const p = peers.current.get(uid);
    if (!p) return;
    p.pc.close();
    p.audio.pause();
    p.audio.srcObject = null;
    p.audio.remove();
    peers.current.delete(uid);
    setConnected(
      [...peers.current.values()].filter((peer) => peer.pc.connectionState === 'connected').length,
    );
  };
  const cleanup = () => {
    for (const uid of [...peers.current.keys()]) disposePeer(uid);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setJoined(false);
    setMuted(true);
    setConnected(0);
  };
  const signal = (to: string, type: Signal['type'], payload: Signal['payload']) =>
    api('/signal', { to, type, payload });
  const peer = (uid: string) => {
    const existing = peers.current.get(uid);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: config.current });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    document.body.append(audio);
    const result: Peer = { pc, audio, candidates: [] };
    peers.current.set(uid, result);
    for (const track of stream.current?.getTracks() || []) pc.addTrack(track, stream.current!);
    pc.onicecandidate = (event) => {
      if (event.candidate)
        void signal(uid, 'candidate', event.candidate.toJSON()).catch((e) =>
          notifyRef.current(message(e)),
        );
    };
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      void audio.play().catch(() => notifyRef.current('浏览器暂停了声音播放，请点击“恢复声音”。'));
    };
    pc.onconnectionstatechange = () => {
      setConnected(
        [...peers.current.values()].filter((p) => p.pc.connectionState === 'connected').length,
      );
      if (pc.connectionState === 'failed')
        notifyRef.current(
          '语音连接失败。跨网络通常需要 HTTPS 和经配置的 TURN 服务；文字共读不受影响。',
        );
    };
    return result;
  };
  useEffect(() => {
    const receive = async (event: Event) => {
      if (!stream.current) return;
      const data = (event as CustomEvent<Signal>).detail;
      try {
        const p = peer(data.from);
        if (data.type === 'candidate') {
          const candidate = data.payload as RTCIceCandidateInit;
          if (p.pc.remoteDescription) await p.pc.addIceCandidate(candidate);
          else p.candidates.push(candidate);
          return;
        }
        await p.pc.setRemoteDescription(data.payload as RTCSessionDescriptionInit);
        for (const c of p.candidates.splice(0)) await p.pc.addIceCandidate(c);
        if (data.type === 'offer') {
          const answer = await p.pc.createAnswer();
          await p.pc.setLocalDescription(answer);
          await signal(data.from, 'answer', answer);
        }
      } catch (error) {
        notifyRef.current(message(error));
      }
    };
    const offline = () => cleanup();
    window.addEventListener('cloud-signal', receive);
    window.addEventListener('cloud-offline', offline);
    return () => {
      window.removeEventListener('cloud-signal', receive);
      window.removeEventListener('cloud-offline', offline);
      cleanup();
    };
  }, [userId]);
  useEffect(() => {
    if (!joined || !userId || !stream.current) return;
    const ids = participants.filter((p) => p.voice && p.id !== userId).map((p) => p.id);
    for (const uid of [...peers.current.keys()]) if (!ids.includes(uid)) disposePeer(uid);
    for (const uid of ids)
      if (userId < uid && !peers.current.has(uid)) {
        const p = peer(uid);
        void (async () => {
          const offer = await p.pc.createOffer();
          await p.pc.setLocalDescription(offer);
          await signal(uid, 'offer', offer);
        })().catch((error) => {
          disposePeer(uid);
          notifyRef.current(message(error));
        });
      }
  }, [joined, userId, participants]);
  const join = async () => {
    setJoining(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('此入口无法使用麦克风，请使用 localhost 或 HTTPS。');
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      media.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      stream.current = media;
      await api('/voice', { enabled: true });
      setJoined(true);
      setMuted(true);
    } catch (error) {
      cleanup();
      notifyRef.current(message(error));
    } finally {
      setJoining(false);
    }
  };
  const leave = async () => {
    cleanup();
    await api('/voice', { enabled: false }).catch((error) => notifyRef.current(message(error)));
  };
  const toggle = () => {
    const next = !muted;
    stream.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  };
  const resume = () => {
    for (const p of peers.current.values())
      void p.audio.play().catch(() => notifyRef.current('声音尚未恢复，请检查浏览器站点权限。'));
  };
  return { joined, muted, connected, joining, join, leave, toggle, resume };
}
