const express = require('express');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const { createDb, key: dbKey } = require('./src/db');
const { ProgramManager } = require('./src/manager');

const PORT = Number(process.env.PORT || '7500');
const RESILIENTDB_ROOT = process.env.RESILIENTDB_ROOT || '/home/ubuntu/production/incubator-resilientdb';
// Default to a local folder so running "node server.js" works without root/volume mounts.
// Can be overridden via DB_PATH.
const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'bpftrace-agent-db');
const BPFTRACE_BIN = process.env.BPFTRACE_BIN || 'bpftrace';
const RING_SIZE = Number(process.env.RING_SIZE || '50000');

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS Middleware - Allow requests from frontend applications
app.use((req, res, next) => {
  // Allow requests from any origin (can be restricted to specific domains in production)
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

// Express 4 doesn't automatically catch promise rejections from async route handlers.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const db = createDb(DB_PATH);
const mgr = new ProgramManager({
  db,
  dbKey,
  bpftraceBin: BPFTRACE_BIN,
  resilientdbRoot: RESILIENTDB_ROOT,
  ringSize: RING_SIZE,
});

app.get('/health', asyncHandler(async (_req, res) => {
  res.json({ ok: true, port: PORT, resilientdbRoot: RESILIENTDB_ROOT, dbPath: DB_PATH, programs: mgr.list() });
}));

app.get('/bpf/programs', (_req, res) => {
  res.json(mgr.list());
});

function programFromReq(req, res) {
  try {
    return mgr.get(req.params.program);
  } catch (e) {
    res.status(404).json({ error: e.message });
    return null;
  }
}

app.post('/bpf/:program/attach', asyncHandler(async (req, res) => {
  const p = programFromReq(req, res);
  if (!p) return;
  const scriptPath = req.body?.scriptPath;
  const out = await p.attach({ scriptPath });
  res.json(out);
}));

app.post('/bpf/:program/detach', asyncHandler(async (req, res) => {
  const p = programFromReq(req, res);
  if (!p) return;
  const out = await p.detach();
  res.json(out);
}));

app.get('/bpf/:program/status', (req, res) => {
  const p = programFromReq(req, res);
  if (!p) return;
  res.json(p.status());
});

app.get('/bpf/:program/raw', (req, res) => {
  const p = programFromReq(req, res);
  if (!p) return;
  const tail = Number(req.query.tail || '2000');
  res.json({ program: p.id, count: Math.min(tail, p.ringSize), lines: p.ringTail(tail) });
});

app.get('/bpf/commitment', asyncHandler(async (req, res) => {
  const p = mgr.get('commitment');
  const self = req.query.self != null ? Number(req.query.self) : null;

  const out = await p.getLatestSeq({ self });
  if (!out) return res.status(404).json({ error: 'no commitments found' });
  res.json(out);
}));

app.get('/bpf/commitment/:seq', asyncHandler(async (req, res) => {
  const p = mgr.get('commitment');
  const seq = Number(req.params.seq);
  const self = req.query.self != null ? Number(req.query.self) : null;

  if (!Number.isFinite(seq)) return res.status(400).json({ error: 'invalid seq' });
  const out = await p.getBySeq(seq, { self });
  if (!out) return res.status(404).json({ error: 'not found', seq, self });
  res.json(out);
}));

app.get('/bpf/checkpointing/:ckpt_seq', asyncHandler(async (req, res) => {
  const p = mgr.get('checkpointing');
  const ckptSeq = Number(req.params.ckpt_seq);
  const limit = req.query.limit != null ? Number(req.query.limit) : 2000;
  if (!Number.isFinite(ckptSeq)) return res.status(400).json({ error: 'invalid ckpt_seq' });
  const events = await p.listByCheckpointSeq(ckptSeq, { limit });
  res.json({ ckpt_seq: ckptSeq, count: events.length, events });
}));

app.get('/bpf/viewchange', asyncHandler(async (req, res) => {
  const useStatic = req.query.static === 'true';

  if (useStatic) {
    const logPath = path.join(RESILIENTDB_ROOT, 'view_change.log');
    
    try {
      if (!fs.existsSync(logPath)) {
        return res.status(404).json({ error: 'log file not found', path: logPath });
      }

      const lineRegex = /^\s*(?<nsecs>\d+)\s+(?<epoch_ns>-?\d+)\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<phase>(?:view_change_trigger|view_change_send|view_change_recv|new_view_send|new_view_recv|new_view_install))\s+view=(?<view>\d+)\s+(?<rest>.*)$/;

      function parseKeyValues(rest) {
        const out = {};
        for (const tok of rest.trim().split(/\s+/)) {
          const m = tok.match(/^(?<k>[A-Za-z_]+)=(?<v>.+)$/);
          if (!m) continue;
          out[m.groups.k] = m.groups.v;
        }
        return out;
      }

      const aggregatedData = {};
      let latestView = -1;

      const fileStream = fs.createReadStream(logPath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        const m = line.match(lineRegex);
        if (!m || !m.groups) continue;

        const g = m.groups;
        const kv = parseKeyValues(g.rest);
        
        const view = Number(g.view);
        const self = kv.self != null ? Number(kv.self) : null;

        if (self === null) continue;

        latestView = Math.max(latestView, view);
        const key = `${self}_${view}`;

        if (!aggregatedData[key]) {
          aggregatedData[key] = {
            replica_id: self,
            view: view,
            checkpoint_seq: null,
            old_primary_id: null,
            new_primary_id: null,
            primary_candidates: new Set(),
            view_change_trigger_time: null,
            view_change_send_time: null,
            view_change_recv_times: [],
            new_view_send_time: null,
            new_view_recv_time: null,
            new_view_install_time: null,
            timeline_events: [],
            view_change_reasons: {}
          };
        }

        const entry = aggregatedData[key];

        // Track checkpoint sequence
        if (kv.checkpoint_seq != null) {
          entry.checkpoint_seq = Number(kv.checkpoint_seq);
        }

        // Track primary transitions
        if (kv.sender != null && g.phase === 'view_change_recv') {
          entry.primary_candidates.add(Number(kv.sender));
        }
        if (kv.new_primary_id != null) {
          entry.new_primary_id = Number(kv.new_primary_id);
        }

        // Record phase times
        const epochNs = Number(g.epoch_ns);
        if (g.phase === 'view_change_trigger') {
          if (entry.view_change_trigger_time === null || epochNs < entry.view_change_trigger_time) {
            entry.view_change_trigger_time = epochNs;
          }
          if (kv.reason != null) {
            const reason = String(kv.reason);
            entry.view_change_reasons[reason] = (entry.view_change_reasons[reason] || 0) + 1;
          }
        } else if (g.phase === 'view_change_send') {
          if (entry.view_change_send_time === null || epochNs < entry.view_change_send_time) {
            entry.view_change_send_time = epochNs;
          }
        } else if (g.phase === 'view_change_recv') {
          entry.view_change_recv_times.push(epochNs);
        } else if (g.phase === 'new_view_send') {
          if (entry.new_view_send_time === null || epochNs < entry.new_view_send_time) {
            entry.new_view_send_time = epochNs;
          }
        } else if (g.phase === 'new_view_recv') {
          if (entry.new_view_recv_time === null || epochNs < entry.new_view_recv_time) {
            entry.new_view_recv_time = epochNs;
          }
        } else if (g.phase === 'new_view_install') {
          if (entry.new_view_install_time === null || epochNs < entry.new_view_install_time) {
            entry.new_view_install_time = epochNs;
          }
        }

        // Add to timeline
        const timelineEvent = {
          phase: g.phase,
          timestamp: epochNs
        };
        if (kv.sender != null) timelineEvent.sender_id = Number(kv.sender);
        if (kv.reason != null) timelineEvent.reason = Number(kv.reason);
        if (kv.checkpoint_seq != null) timelineEvent.checkpoint_seq = Number(kv.checkpoint_seq);
        if (kv.new_primary_id != null) timelineEvent.new_primary_id = Number(kv.new_primary_id);

        entry.timeline_events.push(timelineEvent);
      }

      // Find latest view data
      if (latestView === -1) {
        return res.status(404).json({ error: 'no view changes found in log' });
      }

      const latestReplicas = {};
      for (const [key, entry] of Object.entries(aggregatedData)) {
        if (entry.view === latestView) {
          entry.primary_candidates = Array.from(entry.primary_candidates);
          latestReplicas[String(entry.replica_id)] = entry;
        }
      }

      res.json({ view: latestView, replicas: latestReplicas });
    } catch (error) {
      console.error('[viewchange static] error reading log:', error);
      return res.status(500).json({ error: 'failed to read log file', message: error.message });
    }
  } else {
    // Use live database
    const p = mgr.get('viewchange');
    const self = req.query.self != null ? Number(req.query.self) : null;

    const out = await p.getLatestView({ self });
    if (!out) return res.status(404).json({ error: 'no view changes found' });
    res.json(out);
  }
}));

app.get('/bpf/viewchange/:view', asyncHandler(async (req, res) => {
  const p = mgr.get('viewchange');
  const view = Number(req.params.view);
  const limit = req.query.limit != null ? Number(req.query.limit) : 2000;
  if (!Number.isFinite(view)) return res.status(400).json({ error: 'invalid view' });
  const events = await p.listByView(view, { limit });
  res.json({ view, count: events.length, events });
}));

// Central error handler for async routes.
app.use((err, _req, res, _next) => {
  console.error('[bpftrace-agent] unhandled error:', err);
  res.status(500).json({ error: 'internal error', message: err?.message || String(err) });
});

async function start() {
  // level@8 requires explicit open() before iterator()/get()/put() usage.
  await db.open();

  app.listen(PORT, () => {
    console.log(`[bpftrace-agent] listening on :${PORT}`);
    console.log(`[bpftrace-agent] RESILIENTDB_ROOT=${RESILIENTDB_ROOT}`);
    console.log(`[bpftrace-agent] DB_PATH=${DB_PATH}`);
    console.log(`[bpftrace-agent] programs: ${Object.keys(mgr.programs).join(', ')}`);
  });
}

start().catch((e) => {
  console.error('[bpftrace-agent] failed to start:', e);
  process.exit(1);
});
