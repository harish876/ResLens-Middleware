const { BpfProgram } = require('./base');

const LINE_RE = /^\s*(?<nsecs>\d+)\s+(?<epoch_ns>-?\d+)\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<phase>(?:view_change_trigger|view_change_send|view_change_recv|new_view_send|new_view_recv|new_view_install))\s+view=(?<view>\d+)\s+(?<rest>.*)$/;

function parseKeyValues(rest) {
  const out = {};
  for (const tok of rest.trim().split(/\s+/)) {
    const m = tok.match(/^(?<k>[A-Za-z_]+)=(?<v>.+)$/);
    if (!m) continue;
    out[m.groups.k] = m.groups.v;
  }
  return out;
}

function newAccumulator(selfId, view) {
  return {
    replica_id: selfId,
    view: view,
    checkpoint_seq: null,
    old_primary_id: null,
    new_primary_id: null,
    
    view_change_trigger_time: null,
    view_change_send_time: null,
    view_change_recv_times: [],
    new_view_send_time: null,
    new_view_recv_time: null,
    new_view_install_time: null,
    
    timeline_events: [],
    view_change_reasons: {},
    primary_candidates: new Set(),
  };
}

function minAssign(obj, k, v) {
  if (v == null) return;
  if (obj[k] == null || v < obj[k]) obj[k] = v;
}

class PbftViewChangeProgram extends BpfProgram {
  parseLine(line) {
    const m = line.match(LINE_RE);
    if (!m || !m.groups) return null;
    const g = m.groups;
    const kv = parseKeyValues(g.rest);

    // rest includes one of reason/checkpoint_seq/new_primary_id, plus sender/self, plus req/msg, plus type
    return {
      nsecs: Number(g.nsecs),
      epoch_ns: Number(g.epoch_ns),
      pid: Number(g.pid),
      tid: Number(g.tid),
      phase: g.phase,
      view: Number(g.view),
      sender: kv.sender != null ? Number(kv.sender) : null,
      self: kv.self != null ? Number(kv.self) : null,
      req: kv.req || null,
      msg: kv.msg || null,
      type: kv.type != null ? Number(kv.type) : null,
      reason: kv.reason != null ? Number(kv.reason) : null,
      checkpoint_seq: kv.checkpoint_seq != null ? Number(kv.checkpoint_seq) : null,
      new_primary_id: kv.new_primary_id != null ? Number(kv.new_primary_id) : null,
    };
  }

  async handleEvent(ev) {
    // Aggregate by view and self (replica)
    const aggKey = this.dbKey('agg', this.id, ev.self, ev.view);

    /** @type {any} */
    let obj;
    try {
      obj = await this.db.get(aggKey);
    } catch (e) {
      // level throws NotFoundError; treat as new
      obj = newAccumulator(ev.self, ev.view);
    }

    obj.replica_id = ev.self;
    obj.view = ev.view;

    // Track checkpoint sequence when available
    if (ev.checkpoint_seq != null) {
      obj.checkpoint_seq = ev.checkpoint_seq;
    }

    // Track primary transitions
    if (ev.sender != null && ev.phase === 'view_change_recv') {
      obj.primary_candidates.add(ev.sender);
    }
    if (ev.new_primary_id != null) {
      obj.new_primary_id = ev.new_primary_id;
    }

    // Record phase times
    if (ev.phase === 'view_change_trigger') {
      minAssign(obj, 'view_change_trigger_time', ev.epoch_ns);
      if (ev.reason != null) {
        obj.view_change_reasons[String(ev.reason)] = (obj.view_change_reasons[String(ev.reason)] || 0) + 1;
      }
    } else if (ev.phase === 'view_change_send') {
      minAssign(obj, 'view_change_send_time', ev.epoch_ns);
    } else if (ev.phase === 'view_change_recv') {
      obj.view_change_recv_times.push(ev.epoch_ns);
    } else if (ev.phase === 'new_view_send') {
      minAssign(obj, 'new_view_send_time', ev.epoch_ns);
    } else if (ev.phase === 'new_view_recv') {
      minAssign(obj, 'new_view_recv_time', ev.epoch_ns);
    } else if (ev.phase === 'new_view_install') {
      minAssign(obj, 'new_view_install_time', ev.epoch_ns);
    }

    // Add to timeline
    const timelineEvent = {
      phase: ev.phase,
      timestamp: ev.epoch_ns,
    };

    if (ev.sender != null) timelineEvent.sender_id = ev.sender;
    if (ev.reason != null) timelineEvent.reason = ev.reason;
    if (ev.checkpoint_seq != null) timelineEvent.checkpoint_seq = ev.checkpoint_seq;
    if (ev.new_primary_id != null) timelineEvent.new_primary_id = ev.new_primary_id;

    obj.timeline_events.push(timelineEvent);

    // Keep timeline bounded
    if (obj.view_change_recv_times.length > 1024) {
      obj.view_change_recv_times.splice(0, obj.view_change_recv_times.length - 1024);
    }
    if (obj.timeline_events.length > 8192) {
      obj.timeline_events.splice(0, obj.timeline_events.length - 8192);
    }

    // Convert Set to Array for JSON serialization
    obj.primary_candidates = Array.from(obj.primary_candidates);

    await this.db.put(aggKey, obj);

    // Also persist raw event row for later replay/debug
    const evKey = this.dbKey('ev', this.id, ev.self, ev.view, ev.epoch_ns, ev.pid, ev.tid);
    await this.db.put(evKey, ev);
  }

  async getByView(view, { self } = {}) {
    if (self == null) {
      // Return all replicas that have an aggregate for this view
      const replicas = {};
      const prefix = this.dbKey('agg', this.id, '');
      for await (const [k, v] of this.db.iterator({ gte: prefix, lt: prefix + '\uffff' })) {
        // key parts: agg, id, self, view
        const parts = String(k).split('\x1f');
        const kSelf = Number(parts[2]);
        const kView = Number(parts[3]);
        if (kView === view) {
          // Ensure primary_candidates is an array
          if (v.primary_candidates && !Array.isArray(v.primary_candidates)) {
            v.primary_candidates = Array.from(v.primary_candidates);
          }
          replicas[String(kSelf)] = v;
        }
      }
      if (Object.keys(replicas).length === 0) return null;
      return { view, replicas };
    }

    const aggKey = this.dbKey('agg', this.id, Number(self), Number(view));
    try {
      const obj = await this.db.get(aggKey);
      if (obj.primary_candidates && !Array.isArray(obj.primary_candidates)) {
        obj.primary_candidates = Array.from(obj.primary_candidates);
      }
      return obj;
    } catch {
      return null;
    }
  }

  async getLatestView({ self } = {}) {
    // Find the highest view number recorded for this program
    let latestView = -1;
    let latestReplicas = {};
    const prefix = this.dbKey('agg', this.id, '');
    
    for await (const [k, v] of this.db.iterator({ gte: prefix, lt: prefix + '\uffff' })) {
      // key parts: agg, id, self, view
      const parts = String(k).split('\x1f');
      const kSelf = Number(parts[2]);
      const kView = Number(parts[3]);
      
      if (kView > latestView) {
        latestView = kView;
        latestReplicas = {};
      }
      if (kView === latestView) {
        // Ensure primary_candidates is an array
        if (v.primary_candidates && !Array.isArray(v.primary_candidates)) {
          v.primary_candidates = Array.from(v.primary_candidates);
        }
        latestReplicas[String(kSelf)] = v;
      }
    }

    if (latestView === -1) return null;
    return { view: latestView, replicas: latestReplicas };
  }

  async listByView(view, { limit = 2000 } = {}) {
    const prefix = this.dbKey('ev', this.id, '', view, '');
    const out = [];
    for await (const [_k, v] of this.db.iterator({ gte: prefix, lt: prefix + '\uffff' })) {
      out.push(v);
      if (out.length >= limit) break;
    }
    return out;
  }
}

module.exports = { PbftViewChangeProgram };
