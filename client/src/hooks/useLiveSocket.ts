import { useEffect, useRef } from 'react';

function wsBaseUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

const RECONNECT_DELAY_MS = 2000;

// Opens a WebSocket connection to `path` and calls `onMessage` whenever the
// server sends a "something changed" signal, reconnecting automatically if
// the connection drops. The server pushes no state itself — the caller is
// expected to refetch via the existing REST endpoints, which already do the
// per-session permission shaping a broadcast can't.
export function useLiveSocket(path: string, onMessage: () => void): void {
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) {
        return;
      }
      socket = new WebSocket(`${wsBaseUrl()}${path}`);
      socket.onmessage = () => onMessageRef.current();
      socket.onclose = () => {
        if (!stopped) {
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [path]);
}
