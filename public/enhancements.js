'use strict';

(() => {
  const BASE_TITLE = 'ChatMe — Private random chat';
  const favicon = document.querySelector('link[rel="icon"]');
  const messages = document.querySelector('#messages');
  const partnerStatus = document.querySelector('#partnerStatus');
  const startButton = document.querySelector('#startButton');
  const nextButton = document.querySelector('#nextButton');
  const endButton = document.querySelector('#endButton');
  const cancelSearchButton = document.querySelector('#cancelSearchButton');

  if (!favicon || !messages || !partnerStatus) return;

  let unreadCount = 0;
  let isMatched = false;
  let audioContext = null;

  function iconSvg(mode, count = 0) {
    const badge = mode === 'unread'
      ? `<circle cx="49" cy="15" r="12" fill="#ff5d73" stroke="white" stroke-width="4"/>${count > 0 ? `<text x="49" y="19" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="white">${count > 9 ? '9+' : count}</text>` : ''}`
      : mode === 'connected'
        ? '<circle cx="49" cy="15" r="11" fill="#20b985" stroke="white" stroke-width="4"/><path d="m44 15 3 3 7-8" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
        : '';

    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#775cff"/><stop offset="1" stop-color="#39c5f3"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#g)"/><path d="M17 19c0-4 3-7 7-7h16c4 0 7 3 7 7v14c0 4-3 7-7 7H29l-8 7v-7c-2-1-4-4-4-7V19Z" fill="white" opacity=".97"/><circle cx="27" cy="27" r="2.5" fill="#775cff"/><circle cx="37" cy="27" r="2.5" fill="#39c5f3"/>${badge}</svg>`)}`;
  }

  function setTabState(mode) {
    if (mode === 'unread' && unreadCount > 0) {
      document.title = `(${unreadCount}) New message${unreadCount === 1 ? '' : 's'} · ChatMe`;
      favicon.href = iconSvg('unread', unreadCount);
      return;
    }

    if (mode === 'connected' || isMatched) {
      document.title = '✓ Connected · ChatMe';
      favicon.href = iconSvg('connected');
      return;
    }

    document.title = BASE_TITLE;
    favicon.href = '/favicon.svg';
  }

  function resetUnread() {
    unreadCount = 0;
    setTabState(isMatched ? 'connected' : 'default');
  }

  function primeAudio() {
    if (!window.AudioContext && !window.webkitAudioContext) return;
    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioCtx();
    }
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  }

  function playConnectedSound() {
    if (!audioContext || audioContext.state !== 'running') return;
    const now = audioContext.currentTime;
    const master = audioContext.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.11, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);
    master.connect(audioContext.destination);

    [659.25, 783.99, 987.77].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = now + index * 0.075;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.7, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(start);
      oscillator.stop(start + 0.26);
    });
  }

  function markConnectedMessage(node) {
    if (!(node instanceof HTMLElement) || !node.classList.contains('system-message')) return;
    if (node.textContent?.trim().startsWith('You are connected.')) {
      node.classList.add('connection-success');
    }
  }

  const messageObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        markConnectedMessage(node);

        if (node.classList.contains('message-row') && node.classList.contains('them') && document.hidden) {
          unreadCount += 1;
          setTabState('unread');
        }
      }
    }
  });

  messageObserver.observe(messages, { childList: true });

  const statusObserver = new MutationObserver(() => {
    const connected = partnerStatus.textContent?.trim() === 'Secure connection ready';
    if (connected && !isMatched) {
      isMatched = true;
      unreadCount = 0;
      setTabState('connected');
      playConnectedSound();
      return;
    }

    if (!connected && isMatched) {
      isMatched = false;
      unreadCount = 0;
      setTabState('default');
    }
  });

  statusObserver.observe(partnerStatus, { childList: true, characterData: true, subtree: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resetUnread();
  });

  window.addEventListener('focus', resetUnread);
  startButton?.addEventListener('click', primeAudio, { passive: true });
  nextButton?.addEventListener('click', () => {
    unreadCount = 0;
    isMatched = false;
    setTabState('default');
  });
  endButton?.addEventListener('click', () => {
    unreadCount = 0;
    isMatched = false;
    setTabState('default');
  });
  cancelSearchButton?.addEventListener('click', () => {
    unreadCount = 0;
    isMatched = false;
    setTabState('default');
  });

  setTabState('default');
})();
