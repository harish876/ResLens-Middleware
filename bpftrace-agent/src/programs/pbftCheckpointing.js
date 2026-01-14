const { BpfProgram } = require('./base');

const LINE_RE = /^\s*(?<nsecs>\d+)\s+(?<epoch_ns>-?\d+)\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<phase>checkpoint_(?:send|recv|committable|stable))\s+ckpt_seq=(?<seq>\d+)\s+(?<rest>.*)$/;

function parseKeyValues(rest) {
  const out = {};
  for (const tok of rest.trim().split(/\s+/)) {
    const m = tok.match(/^(?<k>[A-Za-z_]+)=(?<v>.+)$/);
    if (!m) continue;
    out[m.groups.k] = m.groups.v;
  }
  return out;
}

class PbftCheckpointingProgram extends BpfProgram {
  parseLine(line) {
    const m = line.match(LINE_RE);
    if (!m || !m.groups) return null;
    const g = m.groups;
    const kv = parseKeyValues(g.rest);
    return {
      nsecs: Number(g.nsecs),
      epoch_ns: Number(g.epoch_ns),
      pid: Number(g.pid),
      tid: Number(g.tid),
      phase: g.phase,
      ckpt_seq: Number(g.seq),
      sender: kv.sender != null ? Number(kv.sender) : null,
      self: kv.self != null ? Number(kv.self) : null,
      msg: kv.msg || null,
      type: kv.type != null ? Number(kv.type) : null,
      aux: kv.aux != null ? Number(kv.aux) : null,
      num_votes: kv.num_votes != null ? Number(kv.num_votes) : null,
    };
  }

  async handleEvent(ev) {
    const evKey = this.dbKey('ev', this.id, ev.ckpt_seq, ev.epoch_ns, ev.pid, ev.tid);
    await this.db.put(evKey, ev);
  }

  async listByCheckpointSeq(ckptSeq, { limit = 2000 } = {}) {
    const prefix = this.dbKey('ev', this.id, Number(ckptSeq), '');
    const out = [];
    for await (const [_k, v] of this.db.iterator({ gte: prefix, lt: prefix + '\uffff' })) {
      out.push(v);
      if (out.length >= limit) break;
    }
    return out;
  }
}

module.exports = { PbftCheckpointingProgram };
