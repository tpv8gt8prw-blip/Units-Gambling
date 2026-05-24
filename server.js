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

/* ============================================================
   LESSON CLASSIFIER
   Statuses:
     - normal        : nothing changed
     - raum_changed  : only the room differs (still held, same teacher/subject)
     - suppliert     : teacher (or subject) was substituted
     - cancelled     : lesson is cancelled
     - ausflug       : excursion / Lehrausgang / Wandertag (effectively no lesson)
   Returns { status, reason } — reason is the human-readable explanation
   (teacher note `lstext`, substitution note `substText`, or a derived string).
============================================================ */
function entryHasOrgDiff(e) {
  if (!e) return false;
  if (e.orgname && e.name && e.orgname !== e.name) return true;
  if (e.orgid != null && e.id != null && e.orgid !== e.id) return true;
  return false;
}
function containsAusflug(text) {
  if (!text) return false;
  return /ausflug|exkursion|wandertag|lehrausgang|schullandwoche|projektwoche/i.test(String(text));
}
function classifyLesson(l) {
  const lstext = (l.lstext || '').trim();
  const substText = (l.substText || '').trim();
  const info = (l.info || '').trim();
  const allText = `${lstext} ${substText} ${info}`;

  // Ausflug overrides everything else — even if Untis marked it irregular/cancelled.
  if (containsAusflug(allText)) {
    return { status: 'ausflug', reason: lstext || substText || info || 'Ausflug' };
  }
  if (l.code === 'cancelled') {
    return { status: 'cancelled', reason: lstext || substText || info || '' };
  }

  const teDiff = entryHasOrgDiff(l.te && l.te[0]);
  const suDiff = entryHasOrgDiff(l.su && l.su[0]);
  const roDiff = entryHasOrgDiff(l.ro && l.ro[0]);
  const irregular = l.code === 'irregular';

  // Real substitution: teacher or subject changed, or there is a substText note.
  if (teDiff || suDiff || substText) {
    let reason = substText || lstext;
    if (!reason && teDiff) {
      const orig = l.te[0].orgname || '';
      const next = l.te[0].name || '';
      reason = `Lehrer: ${orig}${next ? ' → ' + next : ' fehlt'}`;
    }
    if (!reason && suDiff) {
      reason = `Fach: ${l.su[0].orgname || ''} → ${l.su[0].name || ''}`;
    }
    return { status: 'suppliert', reason };
  }

  // Pure room change — teacher/subject still match.
  if (roDiff) {
    const orig = l.ro[0].orgname || '';
    const next = l.ro[0].name || '';
    const reason = lstext || (orig && next ? `Raum: ${orig} → ${next}` : `Raum: ${next || orig}`);
    return { status: 'raum_changed', reason };
  }

  // Untis flagged irregular but no field actually differs — fall back to suppliert
  // (this is rare, usually a backend quirk) and surface whatever note we have.
  if (irregular) {
    return { status: 'suppliert', reason: lstext || info || '' };
  }

  return { status: 'normal', reason: '' };
}
function annotateLessons(lessons) {
  if (!Array.isArray(lessons)) return;
  for (const l of lessons) {
    const c = classifyLesson(l);
    l.status = c.status;
    l.statusReason = c.reason;
  }
}

app.post('/api/timetable', async (req, res) => {
  const { date, ...creds } = req.body || {};
  if (!validCreds(creds)) return res.status(400).json({ error: 'Fehlende Felder.' });
  try {
    const target = date ? new Date(date) : new Date();
    const timetable = await withUntis(creds, u => u.getOwnTimetableFor(target));
    timetable.sort((a, b) => a.startTime - b.startTime);
    annotateLessons(timetable);
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
    annotateLessons(result.timetable);

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
   PROFILE — student's own foreName / longName.
   The webuntis lib stores sessionInformation after login (personId,
   personType, klasseId). getStudents() then lets us look up our own
   row. Many schools restrict that endpoint to teachers, so we wrap
   in try/catch and just return empty fields on failure — the
   frontend falls back to the username.
============================================================ */
function formatDisplayName(foreName, longName) {
  const f = String(foreName || '').trim();
  const l = String(longName || '').trim();
  if (f && l) return `${f} ${l.charAt(0).toUpperCase()}.`;
  if (f) return f;
  if (l) return l;
  return '';
}

app.post('/api/profile', async (req, res) => {
  const creds = req.body || {};
  if (!validCreds(creds)) return res.status(400).json({ error: 'Fehlende Felder.' });
  try {
    const profile = await withUntis(creds, async (u) => {
      const sess = u.sessionInformation || {};
      let foreName = '', longName = '';
      if (sess.personType === 5 && sess.personId) {
        try {
          const students = await u.getStudents();
          const me = (students || []).find(s => Number(s.id) === Number(sess.personId));
          if (me) {
            foreName = me.foreName || me.forename || '';
            longName = me.longName || me.longname || '';
          }
        } catch (err) {
          console.log('[Profile getStudents]', err.message);
        }
      }
      return {
        personId: sess.personId || null,
        personType: sess.personType || null,
        klasseId: sess.klasseId || null,
        foreName,
        longName,
        displayName: formatDisplayName(foreName, longName),
      };
    });
    res.json({ ok: true, profile });
  } catch (err) {
    console.error('[Profile Error]', err.message);
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

/* ============================================================
   LEADERBOARD
     ZSET  leaderboard:all    score=coins, member="username|school"
     HASH  leaderboard:names  member → displayName ("Enrique A.")
     HASH  leaderboard:klass  member → klass ("5A")
   Member id is the stable username|school tuple. Klass is stored in
   a separate hash because it can change (and used to be folded into
   the member id, which caused duplicate rows whenever the klass
   string changed or was missing during an early push).
   On every update we also opportunistically clean up any legacy
   member ids that share the same username|school but a different
   klass suffix, so the leaderboard self-heals.
============================================================ */
const LEADERBOARD_KEY = 'leaderboard:all';
const LEADERBOARD_NAMES_KEY = 'leaderboard:names';
const LEADERBOARD_KLASS_KEY = 'leaderboard:klass';

function leaderboardMember({ username, school }) {
  return [
    normalizeKeyPart(username),
    normalizeKeyPart(school)
  ].join('|');
}

// Removes any legacy "username|school|klass" entries that share the same
// username|school prefix as `stableMember`. Best-effort: a failure here
// must never block the actual score update.
async function purgeLegacyLeaderboardEntries(stableMember) {
  try {
    const prefix = stableMember + '|';
    // ZSCAN walks the sorted set in chunks. We MATCH on the legacy
    // 3-part shape (one or more chars after the second pipe).
    let cursor = '0';
    const toRemove = [];
    do {
      const out = await upstashCmd([
        'ZSCAN', LEADERBOARD_KEY, cursor, 'MATCH', prefix + '*', 'COUNT', '200'
      ]);
      const result = out && out.result;
      if (!Array.isArray(result) || result.length < 2) break;
      cursor = String(result[0]);
      const pairs = result[1] || [];
      for (let i = 0; i < pairs.length; i += 2) {
        const m = String(pairs[i]);
        // Only treat as legacy when it has an additional segment.
        if (m !== stableMember && m.startsWith(prefix)) toRemove.push(m);
      }
    } while (cursor !== '0' && toRemove.length < 50);
    if (toRemove.length) {
      await upstashCmd(['ZREM', LEADERBOARD_KEY, ...toRemove]);
      await upstashCmd(['HDEL', LEADERBOARD_NAMES_KEY, ...toRemove]);
    }
  } catch (err) {
    console.warn('[Leaderboard purge]', err.message);
  }
}

app.post('/api/leaderboard/update', async (req, res) => {
  const { server, school, username, password, coins, klass, displayName } = req.body || {};
  if (!school || !username || !password || typeof coins !== 'number' || !Number.isFinite(coins)) {
    return res.status(400).json({ error: 'data missing' });
  }
  if (!CLOUD_ENABLED) return res.json({ ok: false, cloudEnabled: false });
  const member = leaderboardMember({ username, school });
  const zadd = await upstashCmd(['ZADD', LEADERBOARD_KEY, String(Math.round(coins)), member]);
  if (displayName && String(displayName).trim()) {
    await upstashCmd(['HSET', LEADERBOARD_NAMES_KEY, member, String(displayName).trim()]);
  }
  const klassStr = String(klass || '').trim();
  if (klassStr) {
    await upstashCmd(['HSET', LEADERBOARD_KLASS_KEY, member, klassStr]);
  }
  // Fire-and-forget cleanup of legacy duplicate rows.
  purgeLegacyLeaderboardEntries(member);
  res.json({ ok: !!zadd, cloudEnabled: true });
});

app.get('/api/leaderboard/get', async (_req, res) => {
  if (!CLOUD_ENABLED) return res.json({ ok: true, entries: [], cloudEnabled: false });
  // Fetch a wider window than needed so we can drop legacy duplicates
  // (older entries with a klass suffix) and still return up to 100 rows.
  const out = await upstashCmd(['ZRANGE', LEADERBOARD_KEY, '0', '299', 'REV', 'WITHSCORES']);
  const raw = (out && Array.isArray(out.result)) ? out.result : [];
  if (!raw.length) return res.json({ ok: true, entries: [], cloudEnabled: true });

  const members = [];
  for (let i = 0; i < raw.length; i += 2) {
    members.push({ key: String(raw[i]), coins: Number(raw[i + 1]) || 0 });
  }
  // Batch-fetch display names + klass in two HMGET round-trips.
  const namesByMember = {};
  const klassByMember = {};
  try {
    const keys = members.map(m => m.key);
    const [namesOut, klassOut] = await Promise.all([
      upstashCmd(['HMGET', LEADERBOARD_NAMES_KEY, ...keys]),
      upstashCmd(['HMGET', LEADERBOARD_KLASS_KEY, ...keys]),
    ]);
    if (namesOut && Array.isArray(namesOut.result)) {
      members.forEach((m, i) => { namesByMember[m.key] = namesOut.result[i] || ''; });
    }
    if (klassOut && Array.isArray(klassOut.result)) {
      members.forEach((m, i) => { klassByMember[m.key] = klassOut.result[i] || ''; });
    }
  } catch (err) {
    console.warn('[Leaderboard HMGET]', err.message);
  }

  // De-duplicate: collapse any rows that share the same username|school
  // prefix (a legacy "user|school|klass" row + the new "user|school" row,
  // or several legacy rows from different klass values). Because raw is
  // already sorted by score DESC, the first time we see a prefix wins.
  const seen = new Set();
  const entries = [];
  for (const m of members) {
    const parts = m.key.split('|');
    const username = parts[0] || '';
    const school = parts[1] || '';
    const stableKey = `${username}|${school}`;
    if (seen.has(stableKey)) continue;
    seen.add(stableKey);
    entries.push({
      username,
      school,
      // Prefer the explicit klass hash; fall back to legacy 3-part key.
      klass: klassByMember[m.key] || parts[2] || '',
      displayName: namesByMember[m.key] || '',
      coins: m.coins,
    });
    if (entries.length >= 100) break;
  }
  res.json({ ok: true, entries, cloudEnabled: true });
});

/* ============================================================
   PREDICTIONS + SPIN THE WHEEL
   Redis keys:
     predictions:pending          SET of prediction ids
     predictions:user:{hash}      SET of ids per account
     prediction:{id}              JSON blob
     spinthewheel:user:{hash}     LIST/SET of recent spins (last 20)
============================================================ */
const PRED_PENDING_KEY = 'predictions:pending';
const PRED_PAYOUT_MULT = 2;
const PRED_HOUR_TOLERANCE = 1;
const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];

function accountHash(creds) {
  return userKey(creds).replace(/^gs:/, '');
}

function predUserSetKey(creds) {
  return `predictions:user:${accountHash(creds)}`;
}

function spinUserKey(creds) {
  return `spinthewheel:user:${accountHash(creds)}`;
}

function predRecordKey(id) {
  return `prediction:${id}`;
}

async function cloudSAdd(key, member) {
  const d = await upstashCmd(['SADD', key, member]);
  return d && (d.result === 1 || d.result === 0);
}

async function cloudSRem(key, member) {
  await upstashCmd(['SREM', key, member]);
}

async function cloudSMembers(key) {
  const d = await upstashCmd(['SMEMBERS', key]);
  return Array.isArray(d?.result) ? d.result.map(String) : [];
}

function newPredId() {
  return crypto.randomBytes(12).toString('hex');
}

function parseLessonDate(l) {
  if (!l || l.date == null) return null;
  if (l.date instanceof Date) {
    const y = l.date.getFullYear();
    const m = String(l.date.getMonth() + 1).padStart(2, '0');
    const d = String(l.date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const n = Number(l.date);
  if (Number.isFinite(n) && n > 19000000) {
    const s = String(Math.trunc(n));
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  const s = String(l.date);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function mondayOfWeek(weekStart) {
  const d = new Date(weekStart + 'T12:00:00');
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayIsoForPrediction(weekStart, dayOfWeek) {
  const d = mondayOfWeek(weekStart);
  d.setDate(d.getDate() + Number(dayOfWeek));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function countDayFromLessons(lessons, dayIso) {
  let cancelled = 0;
  let substituted = 0;
  for (const l of lessons || []) {
    if (parseLessonDate(l) !== dayIso) continue;
    const c = classifyLesson(l);
    if (c.status === 'cancelled' || c.status === 'ausflug') cancelled += 1;
    else if (c.status === 'suppliert') substituted += 1;
  }
  return { cancelled, substituted };
}

function evaluatePredictionResult(pred, actual) {
  const hours = Number(pred.hours) || 0;
  if (pred.claim === 'no_change') {
    const win = actual.cancelled === 0 && actual.substituted === 0;
    return { win, actualCount: 0, actualCancelled: actual.cancelled, actualSubstituted: actual.substituted };
  }
  const actualCount = pred.claim === 'cancelled' ? actual.cancelled : actual.substituted;
  const win = Math.abs(actualCount - hours) <= PRED_HOUR_TOLERANCE;
  return { win, actualCount, actualCancelled: actual.cancelled, actualSubstituted: actual.substituted };
}

async function loadPrediction(id) {
  const raw = await cloudGet(predRecordKey(id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function savePrediction(pred) {
  await cloudSet(predRecordKey(pred.id), JSON.stringify(pred));
}

async function applyPredictionPayout(creds, pred, payout) {
  const key = userKey(creds);
  const raw = await cloudGet(key);
  let gameState = null;
  if (raw) {
    try { gameState = JSON.parse(raw); } catch (_) {}
  }
  if (!gameState || typeof gameState !== 'object') {
    gameState = { coins: 1000, predTotal: 0, predWon: 0, predLost: 0, predCoinsWon: 0 };
  }
  gameState.coins = Math.max(0, Math.round((gameState.coins || 0) + payout));
  gameState.predTotal = (gameState.predTotal || 0) + 1;
  if (pred.status === 'won') {
    gameState.predWon = (gameState.predWon || 0) + 1;
    gameState.predCoinsWon = (gameState.predCoinsWon || 0) + payout;
    const dayName = DAY_NAMES[pred.dayOfWeek] || '';
    if (!gameState.predBestDay) gameState.predBestDay = dayName;
  } else {
    gameState.predLost = (gameState.predLost || 0) + 1;
  }
  await cloudSet(key, JSON.stringify(gameState));
  return gameState;
}

async function evaluateOnePrediction(pred, credsOverride) {
  if (!pred || pred.status !== 'pending') return pred;
  const creds = credsOverride || pred._creds;
  if (!validCreds(creds)) return pred;

  const dayIso = dayIsoForPrediction(pred.weekStart, pred.dayOfWeek);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const dayEnd = new Date(dayIso + 'T23:59:59');
  if (dayEnd > today) return pred;

  let lessons = [];
  try {
    const target = new Date(dayIso + 'T12:00:00');
    lessons = await withUntis(creds, u => u.getOwnTimetableFor(target));
    annotateLessons(lessons);
  } catch (err) {
    console.error('[Prediction eval Untis]', pred.id, err.message);
    return pred;
  }

  const actual = countDayFromLessons(lessons, dayIso);
  const { win, actualCount, actualCancelled, actualSubstituted } = evaluatePredictionResult(pred, actual);
  const payout = win ? Math.round(pred.wager * PRED_PAYOUT_MULT) : 0;

  pred.status = win ? 'won' : 'lost';
  pred.evaluatedAt = new Date().toISOString();
  pred.actualCount = actualCount;
  pred.actualCancelled = actualCancelled;
  pred.actualSubstituted = actualSubstituted;
  pred.payout = payout;
  delete pred._creds;

  await savePrediction(pred);
  await cloudSRem(PRED_PENDING_KEY, pred.id);
  await applyPredictionPayout(creds, pred, win ? payout : 0);
  return pred;
}

app.post('/api/prediction/create', async (req, res) => {
  const { week, dayOfWeek, claim, wager, hours, ...creds } = req.body || {};
  if (!validCreds(creds)) return res.status(400).json({ error: 'Login fehlt.' });
  if (!CLOUD_ENABLED) return res.json({ ok: false, error: 'Cloud nicht aktiv.' });

  const weekStart = String(week || '').slice(0, 10);
  const day = Number(dayOfWeek);
  const validClaims = ['cancelled', 'substituted', 'no_change'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || day < 0 || day > 4 || !validClaims.includes(claim)) {
    return res.status(400).json({ error: 'Ungültige Vorhersage.' });
  }
  const hrs = claim === 'no_change' ? 0 : Math.min(8, Math.max(1, Number(hours) || 1));
  const bet = Math.round(Number(wager) || 0);
  if (bet < 1) return res.status(400).json({ error: 'Einsatz mindestens 1 Coin.' });

  const gsKey = userKey(creds);
  const raw = await cloudGet(gsKey);
  let gameState = { coins: 1000 };
  if (raw) { try { gameState = JSON.parse(raw); } catch (_) {} }
  if ((gameState.coins || 0) < bet) {
    return res.status(400).json({ error: 'Nicht genug Coins.' });
  }

  const dayIso = dayIsoForPrediction(weekStart, day);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const predDay = new Date(dayIso + 'T00:00:00');
  if (predDay < now) {
    return res.status(400).json({ error: 'Tag liegt in der Vergangenheit.' });
  }

  gameState.coins = Math.round(gameState.coins - bet);
  await cloudSet(gsKey, JSON.stringify(gameState));

  const id = newPredId();
  const pred = {
    id,
    username: creds.username,
    school: creds.school,
    server: creds.server,
    weekStart,
    dayOfWeek: day,
    dayIso,
    claim,
    hours: hrs,
    wager: bet,
    status: 'pending',
    createdAt: new Date().toISOString(),
    payout: 0,
    _creds: { server: creds.server, school: creds.school, username: creds.username, password: creds.password },
  };

  await savePrediction(pred);
  await cloudSAdd(predUserSetKey(creds), id);
  await cloudSAdd(PRED_PENDING_KEY, id);

  res.json({ ok: true, prediction: sanitizePrediction(pred), state: gameState });
});

function sanitizePrediction(p) {
  if (!p) return null;
  const { _creds, password, ...rest } = p;
  return rest;
}

app.post('/api/prediction/list', async (req, res) => {
  const creds = req.body || {};
  if (!validCreds(creds)) return res.status(400).json({ error: 'Login fehlt.' });
  if (!CLOUD_ENABLED) return res.json({ ok: true, predictions: [], cloudEnabled: false });

  const ids = await cloudSMembers(predUserSetKey(creds));
  const preds = [];
  for (const id of ids) {
    const p = await loadPrediction(id);
    if (p) preds.push(p);
  }

  for (const p of preds) {
    if (p.status === 'pending') {
      await evaluateOnePrediction(p, creds);
    }
  }

  const refreshed = [];
  for (const id of ids) {
    const p = await loadPrediction(id);
    if (p) refreshed.push(sanitizePrediction(p));
  }
  refreshed.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const gsRaw = await cloudGet(userKey(creds));
  let gameState = null;
  if (gsRaw) try { gameState = JSON.parse(gsRaw); } catch (_) {}

  let spinHistory = [];
  const spinRaw = await cloudGet(spinUserKey(creds));
  if (spinRaw) try { spinHistory = JSON.parse(spinRaw); } catch (_) {}
  if (!Array.isArray(spinHistory)) spinHistory = [];

  res.json({ ok: true, predictions: refreshed, spinHistory, state: gameState, cloudEnabled: true });
});

app.post('/api/prediction/evaluate', async (req, res) => {
  const { secret, ...creds } = req.body || {};
  const cronOk = secret && process.env.CRON_SECRET && secret === process.env.CRON_SECRET;

  if (!cronOk && !validCreds(creds)) {
    return res.status(401).json({ error: 'Nicht autorisiert.' });
  }
  if (!CLOUD_ENABLED) return res.json({ ok: false, cloudEnabled: false });

  const ids = cronOk
    ? await cloudSMembers(PRED_PENDING_KEY)
    : await cloudSMembers(predUserSetKey(creds));

  let evaluated = 0;
  for (const id of ids) {
    const p = await loadPrediction(id);
    if (!p || p.status !== 'pending') continue;
    const useCreds = cronOk ? p._creds : creds;
    if (!validCreds(useCreds)) continue;
    await evaluateOnePrediction(p, useCreds);
    evaluated += 1;
  }
  res.json({ ok: true, evaluated, cloudEnabled: true });
});

/* Spin the wheel — 4 segments: 0×, ½×, 1×, 2× */
const SPIN_MULTIPLIERS = [
  { m: 0, w: 28 },
  { m: 0.5, w: 32 },
  { m: 1, w: 28 },
  { m: 2, w: 12 },
];

function pickSpinMultiplier() {
  const total = SPIN_MULTIPLIERS.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const x of SPIN_MULTIPLIERS) {
    r -= x.w;
    if (r <= 0) return x.m;
  }
  return 1;
}

app.post('/api/spinthewheel', async (req, res) => {
  const { wager, ...creds } = req.body || {};
  if (!validCreds(creds)) return res.status(400).json({ error: 'Login fehlt.' });
  if (!CLOUD_ENABLED) return res.json({ ok: false, error: 'Cloud nicht aktiv.' });

  const bet = Math.round(Number(wager) || 0);
  if (bet < 1) return res.status(400).json({ error: 'Einsatz mindestens 1 Coin.' });

  const gsKey = userKey(creds);
  const raw = await cloudGet(gsKey);
  let gameState = { coins: 1000 };
  if (raw) { try { gameState = JSON.parse(raw); } catch (_) {} }
  if ((gameState.coins || 0) < bet) {
    return res.status(400).json({ error: 'Nicht genug Coins.' });
  }

  const mult = pickSpinMultiplier();
  const payout = Math.round(bet * mult);
  const net = payout - bet;
  gameState.coins = Math.max(0, Math.round(gameState.coins - bet + payout));
  gameState.spinTotal = (gameState.spinTotal || 0) + 1;
  await cloudSet(gsKey, JSON.stringify(gameState));

  const spin = { at: new Date().toISOString(), wager: bet, multiplier: mult, payout, net };
  const spinKey = spinUserKey(creds);
  const prev = await cloudGet(spinKey);
  let history = [];
  if (prev) try { history = JSON.parse(prev); } catch (_) {}
  if (!Array.isArray(history)) history = [];
  history.unshift(spin);
  history = history.slice(0, 20);
  await cloudSet(spinKey, JSON.stringify(history));

  let message;
  if (mult === 0) message = `0× — ${bet} Coins verloren`;
  else if (mult >= 2) message = `Du hast ${mult}× gewonnen! +${fmtCoins(payout)} Coins!`;
  else if (net > 0) message = `${mult}× — +${fmtCoins(net)} Coins`;
  else if (net < 0) message = `${mult}× — ${fmtCoins(net)} Coins`;
  else message = `${mult}× — Einsatz zurück`;

  res.json({
    ok: true,
    multiplier: mult,
    resultCoins: payout,
    message,
    spin,
    history,
    state: gameState,
  });
});

function fmtCoins(n) {
  return Math.round(Number(n) || 0).toLocaleString('de-DE');
}

/* Daily evaluation scheduler (23:55 server local time) */
let lastCronDay = '';
function schedulePredictionCron() {
  if (!CLOUD_ENABLED) return;
  setInterval(async () => {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const hm = now.getHours() * 60 + now.getMinutes();
    if (hm === 23 * 60 + 55 && lastCronDay !== dayKey) {
      lastCronDay = dayKey;
      try {
        const ids = await cloudSMembers(PRED_PENDING_KEY);
        for (const id of ids) {
          const p = await loadPrediction(id);
          if (p && p.status === 'pending' && p._creds) {
            await evaluateOnePrediction(p, p._creds);
          }
        }
        console.log('[Prediction cron] evaluated', ids.length, 'pending');
      } catch (err) {
        console.error('[Prediction cron]', err.message);
      }
    }
  }, 30000);
}
schedulePredictionCron();

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
