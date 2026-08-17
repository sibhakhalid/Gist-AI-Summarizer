// server.js
// Minimal Express server: serves the frontend and proxies summarization
// requests to the xAI (Grok) API so the API key never reaches the browser.

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const MIN_WORDS = 3;
const MAX_WORDS = 12000; // generous ceiling that stays well inside model context + keeps cost/latency predictable

function countWords(str) {
  const trimmed = str.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

app.use(express.json({ limit: '2mb' }));

// Malformed JSON bodies would otherwise fall through to Express's default
// error handler, which leaks a stack trace (including server file paths).
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'That request got garbled on the way over. Please try again.' });
  }
  next(err);
});

app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPT = `You are a precise summarization engine.

Rules:
- Preserve the original meaning. Never distort what the source actually says.
- Identify and keep only the most important information.
- Remove repetition, filler, and unnecessary detail.
- Never invent, assume, or add information that is not present in the source.
- Produce a concise, clearly written, highly readable summary.
- Use short bullet points when they improve readability (e.g. for lists of distinct points); otherwise use tight prose paragraphs.
- Output ONLY the summary itself. No preamble like "Here is a summary," no headers, no meta-commentary.`;

app.post('/api/summarize', async (req, res) => {
  const text = (req.body?.text || '').trim();

  if (!text) {
    return res.status(400).json({ error: 'Paste some text before hitting Highlight it.' });
  }

  const wordCount = countWords(text);
  if (wordCount < MIN_WORDS) {
    return res.status(400).json({ error: "That's already short enough — nothing to highlight." });
  }
  if (wordCount > MAX_WORDS) {
    return res.status(413).json({
      error: `That's a lot of text (${wordCount.toLocaleString()} words). Try under ${MAX_WORDS.toLocaleString()} words at a time.`,
    });
  }

  if (!GROQ_API_KEY) {
    console.error('Missing GROQ_API_KEY environment variable.');
    return res.status(500).json({
      error: "The summarizer isn't configured yet. Add GROQ_API_KEY to your server environment and restart.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Summarize the following text:\n\n${text}` },
        ],
        temperature: 0.3,
       max_completion_tokens: 700,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error('Groq API error:', response.status, errBody);

      if (response.status === 401) {
        return res.status(500).json({ error: 'The summarizer rejected its API key. Check GROQ_API_KEY on the server.' });
      }
      if (response.status === 429) {
        return res.status(429).json({ error: "Groq is getting a lot of requests right now. Wait a moment and try again." });
      }
      return res.status(502).json({ error: "Groq couldn't process that text right now. Please try again." });
    }

    const data = await response.json();
    const summary = data?.choices?.[0]?.message?.content?.trim();

    if (!summary) {
      console.error('Unexpected Groq response shape:', JSON.stringify(data));
      return res.status(502).json({ error: 'Groq returned an empty response. Please try again.' });
    }

    return res.json({ summary });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error('Groq request timed out.');
      return res.status(504).json({ error: 'That took too long to summarize. Try a shorter passage or try again.' });
    }
   console.error('Error contacting Groq:', err);
    return res.status(502).json({ error: "Couldn't reach the summarizer. Check your connection and try again." });
  }
});

// Final safety net so an unexpected error never leaks internals to the client.
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`Gist server running at http://localhost:${PORT}`);
  if (!GROQ_API_KEY) {
    console.warn('⚠️  GROQ_API_KEY is not set. Summarization requests will fail until it is configured.');
  }
});
