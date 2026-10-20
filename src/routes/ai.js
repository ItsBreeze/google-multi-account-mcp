/**
 * Reply links for AI agents that have no MCP (services/ai_bus).
 *
 * The signed token in the path is the whole credential: it names the owner,
 * the agent and the thread. GET reads the thread, POST answers in it.
 */

const express = require('express');
const bus     = require('../services/ai_bus');

const router = express.Router();

function capability(req, res) {
  try {
    return bus.readLink(req.params.token);
  } catch {
    res.status(401).json({ error: 'This reply link is invalid or has expired. Use the link from the newest message.' });
    return null;
  }
}

const fail = (res, next) => (err) => (err.status ? res.status(err.status).json({ error: err.message }) : next(err));

router.get('/k/:token', (req, res, next) => {
  const cap = capability(req, res);
  if (!cap) return;
  bus.thread(cap.ownerKey, cap.thread, { markReadFor: cap.agent })
    .then(t => res.json({ you: cap.agent, ...t, how_to_reply: bus.HOW_TO_REPLY }))
    .catch(fail(res, next));
});

// Plain text is accepted too: a bot's curl often forgets the JSON header.
router.post('/k/:token', express.text({ type: 'text/*', limit: '1mb' }), (req, res, next) => {
  const cap = capability(req, res);
  if (!cap) return;
  const body = typeof req.body === 'string' ? { text: req.body } : (req.body || {});
  if (body.new_thread && !body.to) return res.status(400).json({ error: 'new_thread needs "to"' });

  bus.send(cap.ownerKey, {
    from: cap.agent, to: body.to, text: body.text, thread: body.new_thread ? undefined : cap.thread,
  })
    .then(sent => res.status(201).json({ ...sent, reply_url: bus.replyLink(cap.ownerKey, cap.agent, sent.thread) }))
    .catch(fail(res, next));
});

module.exports = router;
