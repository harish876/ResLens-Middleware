const { BpfProgram } = require('./base');

const LINE_RE = /^\s*(?<nsecs>\d+)\s+(?<epoch_ns>-?\d+)\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<phase>\S+)\s+(?<seq>\d+)\s+sender=(?<sender>\d+)\s+self=(?<self>\d+)\s+proxy=(?<proxy>\d+)\s+req=0x(?<req>[0-9a-fA-F]+)\s+type=(?<type>\d+)\s*$/;

function newAccumulator(selfId, seq) {
  return {
    replica_id: selfId,
    primary_id: null,
    txn_number: seq,

    propose_pre_prepare_time: null,
    prepare_time: null,
    commit_time: null,
    execution_time: null,

    prepare_message_timestamps: [],
    commit_message_timestamps: [],
    timeline_events: [],

    proxy_id: null,
    req_ptr: null,
    type: null,

    ip: null,
    port: null,
    ext_cache_hit_ratio: 0.0,
    level_db_stats: null,
    level_db_approx_mem_size: null,
    txn_commands: [],
    txn_keys: [],
    txn_values: [],
  };
}

function minAssign(obj, k, v) {
  if (v == null) return;
  if (obj[k] == null || v < obj[k]) obj[k] = v;
}

function maxAssign(obj, k, v) {
  if (v == null) return;
  if (obj[k] == null || v > obj[k]) obj[k] = v;
}

class PbftPhasesProgram extends BpfProgram {
  parseLine(line) {
    const m = line.match(LINE_RE);
    if (!m || !m.groups) return null;
    const g = m.groups;
    return {
      nsecs: Number(g.nsecs),
      epoch_ns: Number(g.epoch_ns),
      pid: Number(g.pid),
      tid: Number(g.tid),
      phase: g.phase,
      seq: Number(g.seq),
      sender: Number(g.sender),
      self: Number(g.self),
      proxy: Number(g.proxy),
      req_ptr: `0x${g.req.toLowerCase()}`,
      type: Number(g.type),
    };
  }

  async handleEvent(ev) {
    const aggKey = this.dbKey('agg', this.id, ev.self, ev.seq);

    /** @type {any} */
    let obj;
    try {
      obj = await this.db.get(aggKey);
    } catch (e) {
      // level throws NotFoundError; treat as new
      obj = newAccumulator(ev.self, ev.seq);
    }

    obj.replica_id = ev.self;
    obj.txn_number = ev.seq;
    obj.proxy_id = ev.proxy;
    obj.req_ptr = ev.req_ptr;
    if (obj.type == null) obj.type = ev.type;

    if (ev.phase === 'pre_prepare' && obj.primary_id == null) {
      obj.primary_id = ev.sender;
    }

    if (ev.phase === 'request' || ev.phase === 'pre_prepare') {
      minAssign(obj, 'propose_pre_prepare_time', ev.epoch_ns);
    } else if (ev.phase === 'prepare_state') {
      minAssign(obj, 'prepare_time', ev.epoch_ns);
    } else if (ev.phase === 'commit_state') {
      minAssign(obj, 'commit_time', ev.epoch_ns);
    } else if (ev.phase === 'execute_end') {
      maxAssign(obj, 'execution_time', ev.epoch_ns);
    }

    if (ev.phase === 'prepare_recv') {
      obj.prepare_message_timestamps.push(ev.epoch_ns);
      obj.timeline_events.push({ phase: 'prepare_recv', sender_id: ev.sender, timestamp: ev.epoch_ns });
    } else if (ev.phase === 'commit_recv') {
      obj.commit_message_timestamps.push(ev.epoch_ns);
      obj.timeline_events.push({ phase: 'commit_recv', sender_id: ev.sender, timestamp: ev.epoch_ns });
    } else if (ev.phase === 'execute_start' || ev.phase === 'execute_end') {
      obj.timeline_events.push({ phase: ev.phase, timestamp: ev.epoch_ns });
    }

    // Keep events sorted-ish and bounded.
    if (obj.prepare_message_timestamps.length > 4096) obj.prepare_message_timestamps.splice(0, obj.prepare_message_timestamps.length - 4096);
    if (obj.commit_message_timestamps.length > 4096) obj.commit_message_timestamps.splice(0, obj.commit_message_timestamps.length - 4096);
    if (obj.timeline_events.length > 8192) obj.timeline_events.splice(0, obj.timeline_events.length - 8192);

    await this.db.put(aggKey, obj);

    // Also persist raw event row for later replay/debug
    const evKey = this.dbKey('ev', this.id, ev.self, ev.seq, ev.epoch_ns, ev.pid, ev.tid);
    await this.db.put(evKey, ev);
  }

  async getBySeq(seq, { self } = {}) {
    if (self == null) {
      // Return all replicas that have an aggregate for this seq.
      const replicas = {};
      const prefix = this.dbKey('agg', this.id, '');
      for await (const [k, v] of this.db.iterator({ gte: prefix, lt: prefix + '\uffff' })) {
        // key parts: agg, id, self, seq
        const parts = String(k).split('\x1f');
        const kSelf = Number(parts[2]);
        const kSeq = Number(parts[3]);
        if (kSeq === seq) replicas[String(kSelf)] = v;
      }
      if (Object.keys(replicas).length === 0) return null;
      return { seq, replicas };
    }

    const aggKey = this.dbKey('agg', this.id, Number(self), Number(seq));
    try {
      return await this.db.get(aggKey);
    } catch {
      return null;
    }
  }

  async getLatestSeq({ self } = {}) {
    // Find the highest sequence number recorded for this program
    let latestSeq = -1;
    const prefix = this.dbKey('agg', this.id, '');
    
    for await (const [k, _v] of this.db.iterator({ gte: prefix, lt: prefix + '\uffff' })) {
      // key parts: agg, id, self, seq
      const parts = String(k).split('\x1f');
      const kSeq = Number(parts[3]);
      if (kSeq > latestSeq) {
        latestSeq = kSeq;
      }
    }
    
    if (latestSeq === -1) return null;
    
    // Now return the data for this latest sequence
    return this.getBySeq(latestSeq, { self });
  }
}

module.exports = { PbftPhasesProgram };
