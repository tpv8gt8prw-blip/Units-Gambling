// untis-sync-test / server.js
// Backend mit Day- und Week-Endpoint

const express = require('express');
const path = require('path');
const { WebUntis } = require('webuntis');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    const timetable = await withUntis(creds, u => u.getOwnTimetableForRange(start, end));
    timetable.sort((a, b) => (a.date - b.date) || (a.startTime - b.startTime));
    res.json({ ok: true, rangeStart, rangeEnd, timetable });
  } catch (err) {
    console.error('[Untis Week Error]', err.message);
    res.status(401).json({ error: err.message || 'Login fehlgeschlagen' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  untis.sync running -> http://localhost:${PORT}\n`);
});
