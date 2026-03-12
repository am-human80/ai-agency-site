document.addEventListener('DOMContentLoaded', () => {
  const queryElement = (...selectors) =>
    selectors.reduce((found, selector) => found || document.querySelector(selector), null);

  const toggleButton = queryElement('#chat-toggle', '.chat-toggle');
  const panel = queryElement('#chat-panel', '.chat-panel');
  const closeButton = queryElement('#chat-close', '.chat-close', '.chat-panel__close');
  const historyNode = queryElement('#chat-history', '.chat-history');
  const form = queryElement('#chat-form', '.chat-panel__form');
  const inputField = queryElement('#chat-input', '.chat-input');
  const loadingIndicator = queryElement('#chat-loading', '.chat-loading');
  const errorNode = queryElement('#chat-error', '.chat-error');
  const submitButton = form?.querySelector('button[type="submit"], .chat-send');
  const escalationBanner = queryElement('#chat-escalation', '.chat-escalation');
  const streamingStatusNode = queryElement('#chat-streaming-status', '.chat-streaming-status');
  const warningNode = queryElement('#chat-warning', '.chat-warning');
  const trackerNotice = queryElement('#chat-tracker-notice', '.chat-tracker-notice');

  if (
    !toggleButton ||
    !panel ||
    !closeButton ||
    !historyNode ||
    !form ||
    !inputField ||
    !loadingIndicator ||
    !errorNode ||
    !submitButton ||
    !escalationBanner ||
    !streamingStatusNode ||
    !warningNode ||
    !trackerNotice
  ) {
    console.warn('[ChatWidget] Missing required DOM nodes. Widget will not initialize.');
    return;
  }

  let isLoading = false;
  let lastFocusedBeforeOpen = null;
  const repeatTracker = new Map();
  let trackerSocket = null;
  let reconnectTimeout = null;

  const scrollHistory = () => {
    historyNode.scrollTop = historyNode.scrollHeight;
  };

  const resetError = () => {
    errorNode.textContent = '';
    errorNode.hidden = true;
  };

  const setError = (message) => {
    errorNode.textContent = message;
    errorNode.hidden = false;
  };

  const hideWarning = () => {
    warningNode.hidden = true;
    warningNode.textContent = '';
  };

  const showWarning = (message) => {
    warningNode.textContent = message;
    warningNode.hidden = false;
  };

  const setEscalationBanner = (visible, message) => {
    escalationBanner.textContent = message || escalationBanner.textContent;
    escalationBanner.hidden = !visible;
  };

  const setLoading = (value) => {
    isLoading = value;
    loadingIndicator.hidden = !value;
    loadingIndicator.setAttribute('aria-hidden', value ? 'false' : 'true');
    inputField.disabled = value;
    submitButton.disabled = value;
  };

  const setStreamingStatus = (active, message = 'Streaming response from the FAG RAG assistant…') => {
    streamingStatusNode.textContent = message;
    streamingStatusNode.hidden = !active;
    streamingStatusNode.setAttribute('aria-hidden', active ? 'false' : 'true');
  };

  const resetStreamingBadge = (nodes) => {
    if (!nodes) return;
    nodes.bubble.classList.remove('chat-message--streaming');
    if (nodes.streamingBadge) {
      nodes.streamingBadge.remove();
      nodes.streamingBadge = null;
    }
  };

  const formatConfidence = (confidence = 0) => {
    const parsed = Number(confidence);
    if (!Number.isFinite(parsed)) {
      return 'n/a';
    }
    let normalized = parsed;
    if (normalized <= 1) {
      normalized = normalized * 100;
    }
    return `${Math.min(100, Math.round(normalized))}%`;
  };

  const coerceCitations = (metadata) => {
    const citations = [];
    const sourcePayload = metadata?.citations || metadata?.sources || metadata?.references || metadata?.citation;

    if (Array.isArray(sourcePayload)) {
      sourcePayload.forEach((item) => {
        if (typeof item === 'string') {
          citations.push({ label: item });
          return;
        }

        if (item && typeof item === 'object') {
          citations.push({
            label: item.label || item.title || item.source || `Citation ${citations.length + 1}`,
            url: item.url,
          });
        }
      });
    } else if (sourcePayload && typeof sourcePayload === 'object') {
      citations.push({
        label: sourcePayload.title || sourcePayload.label || sourcePayload.source || 'Source',
        url: sourcePayload.url,
      });
    }

    return citations;
  };

  const createMessageNodes = (role, options = {}) => {
    const bubble = document.createElement('div');
    bubble.className = `chat-message ${role}`;
    if (options.streaming) {
      bubble.classList.add('chat-message--streaming');
    }

    const textNode = document.createElement('p');
    textNode.className = 'chat-message__text';
    textNode.textContent = options.text || '';
    bubble.appendChild(textNode);

    const metaWrapper = document.createElement('div');
    metaWrapper.className = 'chat-message__meta';
    metaWrapper.hidden = true;

    const confidenceBadge = document.createElement('span');
    confidenceBadge.className = 'chat-message__confidence';

    const citationContainer = document.createElement('div');
    citationContainer.className = 'chat-citation-badges';

    metaWrapper.appendChild(confidenceBadge);
    metaWrapper.appendChild(citationContainer);

    bubble.appendChild(metaWrapper);

    let streamingBadge = null;
    if (options.streaming) {
      streamingBadge = document.createElement('span');
      streamingBadge.className = 'chat-streaming-badge';
      streamingBadge.textContent = 'Streaming';
      bubble.appendChild(streamingBadge);
    }

    return {
      bubble,
      textNode,
      metaWrapper,
      confidenceBadge,
      citationContainer,
      streamingBadge,
      partialText: options.text || '',
    };
  };

  const appendToHistory = (nodes) => {
    historyNode.appendChild(nodes.bubble);
    scrollHistory();
    return nodes;
  };

  const appendUserMessage = (text) => {
    const nodes = createMessageNodes('user', { text });
    appendToHistory(nodes);
    return nodes;
  };

  const appendSystemMessage = (text) => {
    const bubble = document.createElement('div');
    bubble.className = 'chat-message system';
    bubble.textContent = text;
    historyNode.appendChild(bubble);
    scrollHistory();
  };

  const renderMetadata = (nodes, metadata) => {
    if (!nodes || !metadata) {
      return;
    }

    let hasMeta = false;

    const citationItems = coerceCitations(metadata);
    const confidenceValue = metadata?.confidence;

    if (confidenceValue !== undefined && confidenceValue !== null) {
      nodes.confidenceBadge.textContent = `Confidence • ${formatConfidence(confidenceValue)}`;
      hasMeta = true;
    } else {
      nodes.confidenceBadge.textContent = '';
    }

    nodes.citationContainer.innerHTML = '';
    if (citationItems.length) {
      citationItems.forEach((citation, index) => {
        const badge = citation.url ? document.createElement('a') : document.createElement('span');
        badge.className = 'chat-citation-badge';
        badge.textContent = citation.label || `Source ${index + 1}`;
        if (citation.url) {
          badge.href = citation.url;
          badge.target = '_blank';
          badge.rel = 'noreferrer noopener';
        }
        nodes.citationContainer.appendChild(badge);
      });
      hasMeta = true;
    }

    nodes.metaWrapper.hidden = !hasMeta;
  };

  const shouldEscalate = (metadata, text) => {
    if (!metadata && !text) {
      return false;
    }

    const fallbackKeywords = ['support team', 'loop our support', 'escalate', 'handoff', 'specialist', 'urgent'];
    const lowerText = text?.toLowerCase() || '';

    if (metadata?.escalation || metadata?.handoff || metadata?.intent === 'support') {
      return true;
    }

    return fallbackKeywords.some((keyword) => lowerText.includes(keyword));
  };

  const shouldLogFallback = (metadata, text) => {
    if (!metadata && !text) {
      return false;
    }

    if (metadata?.fallback || metadata?.handoff || metadata?.escalation) {
      return true;
    }

    const fallbackTriggers = ['loop our support team', 'fallback', 'handoff', 'specialist', 'escalate'];
    const lowerText = (text || '').toLowerCase();
    return metadata?.intent === 'support' || fallbackTriggers.some((trigger) => lowerText.includes(trigger));
  };

  const logTrackerEvent = async (metadata, text, streaming) => {
    if (!metadata?.requestId) {
      return;
    }

    const payload = {
      requestId: metadata.requestId,
      intent: metadata.intent || 'fallback',
      keywords: metadata.keywords || [],
      messageSnippet: (text || '').slice(0, 200),
      streaming: Boolean(streaming),
      timestamp: new Date().toISOString(),
    };

    try {
      await fetch('/api/tracker/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      appendSystemMessage('Fallback/handoff logged for tracking and follow-up.');
    } catch (error) {
      console.warn('[ChatWidget] Tracker log failed', error);
    }
  };

  const finalizeBotResponse = async (payload, nodes, streaming) => {
    const metadata = payload?.metadata || {};
    const text = payload?.response || nodes.textNode.textContent || '';

    nodes.textNode.textContent = text;
    renderMetadata(nodes, metadata);
    resetStreamingBadge(nodes);

    if (shouldEscalate(metadata, text)) {
      setEscalationBanner(true, metadata?.escalationNote || 'Escalation requested — specialists are tracking this conversation.');
    } else {
      setEscalationBanner(false);
    }

    if (shouldLogFallback(metadata, text)) {
      void logTrackerEvent(metadata, text, streaming);
    }
  };

  const createStreamingPlaceholder = () => {
    const nodes = createMessageNodes('bot', { text: '', streaming: true });
    appendToHistory(nodes);
    nodes.partialText = '';
    return nodes;
  };

  const appendChunkToNodes = (nodes, chunk) => {
    if (!chunk) {
      return;
    }

    nodes.partialText = `${nodes.partialText || ''}${chunk}`;
    nodes.textNode.textContent = nodes.partialText;
    scrollHistory();
  };

  const parseStreamSegment = (segment) => {
    if (!segment) {
      return { delta: '' };
    }

    try {
      const parsed = JSON.parse(segment);
      return parsed;
    } catch (error) {
      return { delta: segment };
    }
  };

  const streamResponse = async (response, nodes) => {
    if (!response.body || !nodes) {
      return { metadata: {}, finalText: nodes?.partialText || '' };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let metadata = {};

    const flushSegment = (segment) => {
      const { delta, text, response: fullText, metadata: chunkMeta, citations, confidence } = parseStreamSegment(segment);
      const chunkPayload = delta ?? text ?? fullText ?? segment;
      appendChunkToNodes(nodes, chunkPayload);

      if (chunkMeta) {
        metadata = { ...metadata, ...chunkMeta };
      }

      if (citations) {
        metadata = { ...metadata, citations };
      }

      if (confidence) {
        metadata = { ...metadata, confidence };
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;

      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const segment = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (segment) {
          flushSegment(segment);
        }
      }
    }

    if (buffer.trim()) {
      flushSegment(buffer.trim());
    }

    return { metadata, finalText: nodes.textNode.textContent };
  };

  const isStreamingResponse = (response) => {
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    return (
      response.body &&
      (contentType.includes('stream') || contentType.includes('event-stream') || contentType.includes('ndjson'))
    );
  };

  const markRepeat = (message) => {
    const key = message.trim().toLowerCase();
    if (!key) {
      return false;
    }
    const count = repeatTracker.get(key) || 0;
    repeatTracker.set(key, count + 1);
    return count > 0;
  };

  const sendToBot = async (message) => {
    setLoading(true);
    resetError();
    hideWarning();
    setEscalationBanner(false);
    setStreamingStatus(false);

    const normalized = message.trim();
    if (!normalized) {
      setError('Please type a message before sending.');
      setLoading(false);
      return;
    }

    const isRepeat = markRepeat(normalized);
    if (isRepeat) {
      showWarning('We noticed that question already — we will elevate it for follow-up.');
    }

    try {
      const response = await fetch('/api/chatbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: normalized }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const errorMessage = payload?.response || 'Unable to load a reply right now.';
        throw new Error(`HTTP ${response.status}: ${errorMessage}`);
      }

      if (isStreamingResponse(response)) {
        setStreamingStatus(true, 'Streaming response from the FAG RAG assistant…');
        const streamingNodes = createStreamingPlaceholder();
        const { metadata, finalText } = await streamResponse(response, streamingNodes);
        await finalizeBotResponse({ response: finalText, metadata }, streamingNodes, true);
      } else {
        const payload = await response.json();
        const nodes = createMessageNodes('bot', { text: '' });
        appendToHistory(nodes);
        await finalizeBotResponse(payload, nodes, false);
      }
    } catch (error) {
      console.warn('[ChatWidget] Failed to fetch chatbot response.', error);
      setError('We could not reach the chat service. Please try again in a moment.');
    } finally {
      setLoading(false);
      setStreamingStatus(false);
    }
  };

  const subscribeToTrackerEvents = () => {
    if (!('WebSocket' in window)) {
      appendSystemMessage('Real-time tracker updates are not supported by your browser.');
      return;
    }

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const eventUrl = `${scheme}://${window.location.host}/api/tracker/events`;

    const connect = () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      trackerSocket = new WebSocket(eventUrl);

      trackerSocket.addEventListener('open', () => {
        appendSystemMessage('Listening for tracker updates and data refreshes.');
      });

      trackerSocket.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data);

          if (payload?.type === 'tracker_entry_complete') {
            appendSystemMessage(
              `Tracker entry ${payload.entryId || 'unknown'} completed (${payload.status || 'confirmed'}) at ${payload.timestamp || ''}`.trim()
            );
          } else if (payload?.type === 'data_refresh') {
            appendSystemMessage(
              `Knowledge refresh finished for ${payload.dataset || 'this FAQ set'} at ${payload.timestamp || ''}`.trim()
            );
          }
        } catch (error) {
          console.warn('[ChatWidget] Invalid tracker event payload.', error);
        }
      });

      trackerSocket.addEventListener('error', () => {
        appendSystemMessage('Tracker feed temporarily unavailable.');
      });

      trackerSocket.addEventListener('close', () => {
        appendSystemMessage('Reconnecting to tracker updates…');
        reconnectTimeout = setTimeout(connect, 5000);
      });
    };

    connect();
  };

  const isOpen = () => !panel.hidden;

  const setPanelOpen = (open) => {
    if (open === isOpen()) {
      return;
    }

    if (open) {
      lastFocusedBeforeOpen = document.activeElement;
      panel.hidden = false;
      panel.setAttribute('aria-hidden', 'false');
      toggleButton.setAttribute('aria-expanded', 'true');
      window.requestAnimationFrame(() => inputField.focus());
    } else {
      panel.hidden = true;
      panel.setAttribute('aria-hidden', 'true');
      toggleButton.setAttribute('aria-expanded', 'false');
      resetError();
      setLoading(false);
      setStreamingStatus(false);

      if (lastFocusedBeforeOpen && typeof lastFocusedBeforeOpen.focus === 'function') {
        lastFocusedBeforeOpen.focus();
      } else {
        toggleButton.focus();
      }

      lastFocusedBeforeOpen = null;
    }
  };

  toggleButton.addEventListener('click', () => {
    setPanelOpen(!isOpen());
  });

  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setPanelOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      setPanelOpen(false);
    }
  });

  const appendInitialMessage = () => {
    const nodes = createMessageNodes('bot', {
      text: 'Hi! Ask about SEO, PPC, or request an update and I will pull the best answer with citations.',
    });
    appendToHistory(nodes);
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    if (isLoading) {
      return;
    }

    const message = inputField.value.trim();

    if (!message) {
      setError('Please type a message before sending.');
      inputField.focus();
      return;
    }

    resetError();
    appendUserMessage(message);
    inputField.value = '';
    sendToBot(message);
  });

  inputField.addEventListener('input', () => {
    if (inputField.value.trim()) {
      hideWarning();
    }
  });

  setPanelOpen(false);
  setLoading(false);
  resetError();
  hideWarning();
  setEscalationBanner(false);
  setStreamingStatus(false);
  appendInitialMessage();
  subscribeToTrackerEvents();
});
