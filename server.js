const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const publicDir = __dirname;
const buildRequestId = () => `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

const contextRules = [
  {
    intent: 'support',
    keywords: ['help', 'issue', 'problem', 'support', 'bug', 'error'],
    reply:
      'It sounds like you need a little help. I can gather the details and loop our support team in so you get a fast response.',
  },
  {
    intent: 'pricing',
    keywords: ['price', 'cost', 'pricing', 'quote', 'plan', 'subscription'],
    reply:
      'You can find our transparent pricing tiers on the website, and I can also share a personalized quote if you tell me a bit more about your needs.',
  },
  {
    intent: 'demo',
    keywords: ['demo', 'walkthrough', 'tour', 'showcase'],
    reply:
      'Happy to arrange a demo! Share a few time slots that work for you or let me know what you want to focus on, and I will get everything scheduled.',
  },
  {
    intent: 'services',
    keywords: ['service', 'services', 'offer'],
    reply:
      'We offer SEO, content strategy, PPC, and social media services tailored to growth‑focused teams. Tell me which area you want to explore and I can share case studies or next steps.',
  },
];

app.use(express.json());
app.use(express.static(publicDir, { fallthrough: true }));

const trackerWss = new WebSocket.Server({ server, path: '/api/tracker/events' });

trackerWss.on('connection', (socket) => {
  const sendEvent = (event) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  };

  sendEvent({
    type: 'tracker_entry_complete',
    entryId: buildRequestId(),
    status: 'queued',
    timestamp: new Date().toISOString(),
  });

  const entryInterval = setInterval(() => {
    sendEvent({
      type: 'tracker_entry_complete',
      entryId: buildRequestId(),
      status: 'resolved',
      timestamp: new Date().toISOString(),
    });
  }, 35000);

  const refreshInterval = setInterval(() => {
    sendEvent({
      type: 'data_refresh',
      dataset: 'FAQ knowledge base',
      timestamp: new Date().toISOString(),
    });
  }, 45000);

  socket.on('close', () => {
    clearInterval(entryInterval);
    clearInterval(refreshInterval);
  });
});

const analyzeMessage = (message) => {
  const lower = message.toLowerCase();
  const match = contextRules.find((rule) =>
    rule.keywords.some((keyword) => lower.includes(keyword))
  );

  if (match) {
    const matchedKeywords = match.keywords.filter((keyword) => lower.includes(keyword));
    return {
      intent: match.intent,
      reply: match.reply,
      keywords: Array.from(new Set(matchedKeywords)),
    };
  }

  return {
    intent: 'general',
    reply: `Thanks for reaching out! You said: "${message}". We'll reply shortly.`,
    keywords: [],
  };
};

app.post('/api/chatbot', (req, res) => {
  const requestId = buildRequestId();
  const timestamp = new Date().toISOString();

  try {
    const { message } = req.body;
    const cleaned = typeof message === 'string' ? message.trim() : '';

    if (!cleaned) {
      return res.status(400).json({
        response: 'Please enter a message before sending.',
        metadata: {
          requestId,
          timestamp,
          intent: 'validation_error',
          error: 'empty_message',
        },
      });
    }

    const analyzed = analyzeMessage(cleaned);
    const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
    const charCount = cleaned.length;
    const confidence = Number(
      Math.min(0.95, 0.75 + Math.min(analyzed.keywords.length, 5) * 0.04).toFixed(2)
    );
    const metadata = {
      requestId,
      timestamp,
      intent: analyzed.intent,
      keywords: analyzed.keywords,
      wordCount,
      charCount,
      originalMessage: cleaned,
      source: 'backend-chatbot',
      confidence,
      fallback: analyzed.intent === 'general',
      escalation: analyzed.intent === 'support',
      handoff: analyzed.intent === 'support',
    };

    const citations = [];
    if (analyzed.intent === 'support') {
      citations.push({
        title: 'Operations & Support Escalation Guide',
        url: 'https://clickthroughdigital.com/support',
        label: 'Support Guide',
      });
    } else if (analyzed.keywords.length) {
      citations.push({
        title: `FAQ: ${analyzed.keywords[0]}`,
        url: 'https://clickthroughdigital.com/faqs',
        label: 'FAQ Reference',
      });
    }

    if (citations.length) {
      metadata.citations = citations;
    }

    return res.json({
      response: analyzed.reply,
      metadata,
    });
  } catch (error) {
    console.error(`[${requestId}] Unexpected error`, error);
    return res.status(500).json({
      response:
        'We hit an unexpected issue while processing your message. Please try again in a moment.',
      metadata: {
        requestId,
        timestamp,
        intent: 'internal_error',
        error: 'internal_server_error',
        details: error.message,
      },
    });
  }
});

app.post('/api/tracker/log', (req, res) => {
  const logEntry = {
    ...(req.body || {}),
    receivedAt: new Date().toISOString(),
  };

  console.log('[TrackerLog]', logEntry);
  res.status(204).end();
});

app.get(/.*/, (req, res, next) => {
  if (path.extname(req.path)) {
    return next();
  }

  const trimmedPath = req.path.replace(/^\/+|\/+$/g, '');
  const htmlFile = trimmedPath ? `${trimmedPath}.html` : 'index.html';
  const resolvedPath = path.resolve(publicDir, htmlFile);
  res.sendFile(resolvedPath, (err) => {
    if (err) {
      return res.sendFile(htmlFile, { root: publicDir }, (fallbackErr) => {
        if (fallbackErr) {
          return next();
        }
      });
    }
  });
});

server.listen(PORT);
