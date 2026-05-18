// untis-sync-test / server.js
// Backend mit Day- und Week-Endpoint

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { WebUntis } = require('webuntis');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   UPSTASH REDIS (cloud sync)
============================================================ */
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CLOUD_ENABLED = !!(UPSTASH_URL && UPSTASH_TOKEN);

function normalizeKeyPart(value) {
  return String(value || '').trim().toLowerCase();
}

function userKey({ server, school, username }) {
  const id = [
    normalizeKeyPart(server).replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    normalizeKeyPart(school),
    normalizeKeyPart(username)
  ].join(':');
  const h = crypto.createHash('sha256').update(id).digest('hex');
  return `gs:${h}`;
}

async function upstashCmd(cmd) {
  if (!CLOUD_ENABLED) return null;
  try {
    const r = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    const text = await r.text();
    if (!r.ok) {
      console.error('[Upstash Error]', r.status, text);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      console.error('[Upstash Parse Error]', err.message);
      return null;
    }
  } catch (err) {
    console.error('[Upstash Network Error]', err.message);
    return null;
  }
}

async function cloudGet(key) {
  const d = await upstashCmd(['GET', key]);
  return d ? d.result : null;
}

async function cloudSet(key, value) {
  const d = await upstashCmd(['SET', key, value]);
  return !!(d && d.result === 'OK');
}

function validCreds(c) {
  return c && c.school && c.server && c.username && c.password;
}

async function withUntis(creds, fn) {
  const { school, server, username, password } = creds;
  const untis = new WebUntis(school, username, password, server);
  try {
    await untis.login();
    return await fn(untis);
  } finally {
    try { await untis.logout(); } catch (_) {}
  }
}

app.post('/api/timetable', async (req, res) => {
  const { date, ...creds } = req.body || {};
  if (!validCreds(creds)) return res.status(400).json({ error: 'Fehlende Felder.' });
  try {
    const target = date ? new Date(date) : new Date();
    const timetable = await withUntis(creds, u => u.getOwnTimetableFor(target));
    timetable.sort((a, b) => a.startTime - b.startTime);
    res.json({ ok: true, date: target.toISOString(), timetable });
  } catch (err) {
    console.error('[Untis Day Error]', err.message);
    res.status(401).json({ error: err.message || 'Login fehlgeschlagen' });
  }
});

app.post('/api/timetable-week', async (req, res) => {
  const { rangeStart, rangeEnd, ...creds } = req.body || {};
  if (!validCreds(creds) || !rangeStart || !rangeEnd) {
    return res.status(400).json({ error: 'Fehlende Felder.' });
  }
  try {
    const start = new Date(rangeStart);
    const end = new Date(rangeEnd);

    const result = await withUntis(creds, async (u) => {
      const timetable = await u.getOwnTimetableForRange(start, end);
      // Homework is optional, swallow errors if not supported
      let hwResp = null;
      try { hwResp = await u.getHomeWorksFor(start, end); } catch (_) {}
      return { timetable, hwResp };
    });

    result.timetable.sort((a, b) => (a.date - b.date) || (a.startTime - b.startTime));

    // Extract homeworks (API shape varies between versions)
    let homeworks = [];
    const h = result.hwResp;
    if (h) {
      if (Array.isArray(h)) homeworks = h;
      else if (Array.isArray(h.homeworks)) homeworks = h.homeworks;
      else if (h.data && Array.isArray(h.data.homeworks)) homeworks = h.data.homeworks;
    }

    res.json({ ok: true, rangeStart, rangeEnd, timetable: result.timetable, homeworks });
  } catch (err) {
    console.error('[Untis Week Error]', err.message);
    res.status(401).json({ error: err.message || 'Login fehlgeschlagen' });
  }
});

/* ============================================================
   GAME STATE SYNC
============================================================ */
app.post('/api/state/get', async (req, res) => {
  const { server, school, username, password } = req.body || {};
  if (!school || !username || !password) {
    return res.status(400).json({ error: 'creds missing' });
  }
  if (!CLOUD_ENABLED) {
    return res.json({ ok: true, state: null, cloudEnabled: false });
  }
  const key = userKey({ server, school, username });
  const raw = await cloudGet(key);
  let state = null;
  if (raw) { try { state = JSON.parse(raw); } catch (_) {} }
  res.json({ ok: true, state, cloudEnabled: true });
});

app.post('/api/state/save', async (req, res) => {
  const { server, school, username, password, state } = req.body || {};
  if (!school || !username || !password || !state) {
    return res.status(400).json({ error: 'data missing' });
  }
  if (!CLOUD_ENABLED) {
    return res.json({ ok: false, cloudEnabled: false });
  }
  const key = userKey({ server, school, username });
  const ok = await cloudSet(key, JSON.stringify(state));
  res.json({ ok, cloudEnabled: true });
});

app.get('/api/cloud-status', async (_req, res) => {
  const status = {
    ok: true,
    cloudEnabled: CLOUD_ENABLED,
    hasUpstashUrl: !!UPSTASH_URL,
    hasUpstashToken: !!UPSTASH_TOKEN,
    upstashHost: null,
    ping: null
  };
  if (UPSTASH_URL) {
    try { status.upstashHost = new URL(UPSTASH_URL).host; } catch (_) {}
  }
  if (CLOUD_ENABLED) {
    const pong = await upstashCmd(['PING']);
    status.ping = pong?.result || null;
    status.ok = status.ping === 'PONG';
  }
  res.status(status.ok ? 200 : 503).json(status);
});

app.listen(PORT, () => {
  console.log(`\n  untis.sync running -> http://localhost:${PORT}`);
  console.log(`  cloud sync: ${CLOUD_ENABLED ? 'ON' : 'OFF (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)'}\n`);
});
