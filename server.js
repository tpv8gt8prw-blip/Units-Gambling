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

      // Homework (primary endpoint)
      let hwResp = null;
      try { hwResp = await u.getHomeWorksFor(start, end); }
      catch (err) { console.log('[Homework getHomeWorksFor]', err.message); }

      // Homework fallback (different endpoint shape on some schools)
      let hwAltResp = null;
      if (!hwResp || (Array.isArray(hwResp?.homeworks) && hwResp.homeworks.length === 0)) {
        try { hwAltResp = await u.getHomeWorkAndLessons(start, end); }
        catch (err) { console.log('[Homework getHomeWorkAndLessons]', err.message); }
      }

      // Absences / Anwesenheit
      let absResp = null;
      try { absResp = await u.getAbsentLesson(start, end); }
      catch (err) { console.log('[Absences]', err.message); }

      // Exams / Prüfungen
      let examsResp = null;
      try { examsResp = await u.getExamsForRange(start, end); }
      catch (err) { console.log('[Exams]', err.message); }

      return { timetable, hwResp, hwAltResp, absResp, examsResp };
    });

    result.timetable.sort((a, b) => (a.date - b.date) || (a.startTime - b.startTime));

    // Extract homeworks robustly (API shape varies between school configs / library versions)
    let homeworks = [];
    let homeworkLessons = [];
    const extractHw = (h) => {
      if (!h) return;
      if (Array.isArray(h)) { homeworks = homeworks.concat(h); return; }
      if (Array.isArray(h.homeworks)) homeworks = homeworks.concat(h.homeworks);
      if (Array.isArray(h.lessons)) homeworkLessons = homeworkLessons.concat(h.lessons);
      if (h.data && Array.isArray(h.data.homeworks)) homeworks = homeworks.concat(h.data.homeworks);
      if (h.data && Array.isArray(h.data.lessons)) homeworkLessons = homeworkLessons.concat(h.data.lessons);
      if (h.records && Array.isArray(h.records)) homeworks = homeworks.concat(h.records);
    };
    extractHw(result.hwResp);
    extractHw(result.hwAltResp);
    // Deduplicate homeworks by id
    const seenHwIds = new Set();
    homeworks = homeworks.filter(hw => {
      const id = hw.id || hw.homeworkId;
      if (id == null) return true;
      if (seenHwIds.has(id)) return false;
      seenHwIds.add(id);
      return true;
    });

    // Extract absences
    let absences = [];
    const a = result.absResp;
    if (a) {
      if (Array.isArray(a)) absences = a;
      else if (Array.isArray(a.absences)) absences = a.absences;
      else if (a.data && Array.isArray(a.data.absences)) absences = a.data.absences;
    }

    // Extract exams
    let exams = [];
    const e = result.examsResp;
    if (e) {
      if (Array.isArray(e)) exams = e;
      else if (Array.isArray(e.exams)) exams = e.exams;
      else if (e.data && Array.isArray(e.data.exams)) exams = e.data.exams;
    }

    console.log(`[Week ${rangeStart}→${rangeEnd}] lessons=${result.timetable.length} hw=${homeworks.length} abs=${absences.length} exams=${exams.length}`);
    if (homeworks.length > 0) {
      console.log('[Homework sample]', JSON.stringify(homeworks[0]));
    }

    res.json({
      ok: true,
      rangeStart, rangeEnd,
      timetable: result.timetable,
      homeworks,
      homeworkLessons,
      absences,
      exams,
    });
  } catch (err) {
    console.error('[Untis Week Error]', err.message);
    res.status(401).json({ error: err.message || 'Login fehlgeschlagen' });
  }
});

/* ============================================================
   OFFICE HOURS (Sprechzeiten) — uses raw JSON-RPC since the
   webuntis library doesn't expose this method directly
============================================================ */
app.post('/api/office-hours', async (req, res) => {
  const creds = req.body || {};
  if (!validCreds(creds)) return res.status(400).json({ error: 'Fehlende Felder.' });
  try {
    const officeHours = await withUntis(creds, async (u) => {
      // Try the internal JSON-RPC method — works on most modern WebUntis installs
      try {
        const r = await u._request('getOfficeHours2017', {});
        if (Array.isArray(r)) return r;
        if (r && Array.isArray(r.officeHours)) return r.officeHours;
        if (r && Array.isArray(r.entries)) return r.entries;
        return r || [];
      } catch (err) {
        console.log('[OfficeHours raw call failed]', err.message);
        // Fallback: try the old endpoint
        try {
          const r2 = await u._request('getOfficeHours', {});
          return r2 || [];
        } catch (err2) {
          console.log('[OfficeHours old endpoint also failed]', err2.message);
          return [];
        }
      }
    });
    res.json({ ok: true, officeHours: Array.isArray(officeHours) ? officeHours : [] });
  } catch (err) {
    console.error('[OfficeHours Error]', err.message);
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
