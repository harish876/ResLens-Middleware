const { PbftPhasesProgram } = require('./programs/pbftPhases');
const { PbftCheckpointingProgram } = require('./programs/pbftCheckpointing');
const { PbftViewChangeProgram } = require('./programs/pbftViewChange');

class ProgramManager {
  /**
   * @param {{ db: import('level').Level, dbKey: (...parts: any[]) => string, bpftraceBin: string, resilientdbRoot: string, ringSize?: number }} opts
   */
  constructor(opts) {
    this.db = opts.db;
    this.dbKey = opts.dbKey;
    this.bpftraceBin = opts.bpftraceBin;
    this.resilientdbRoot = opts.resilientdbRoot;
    this.ringSize = opts.ringSize;

    this.programs = {
      commitment: new PbftPhasesProgram({
        id: 'commitment',
        scriptPath: `${this.resilientdbRoot}/track_pbft_phases.bt`,
        bpftraceBin: this.bpftraceBin,
        db: this.db,
        dbKey: this.dbKey,
        ringSize: this.ringSize,
      }),
      checkpointing: new PbftCheckpointingProgram({
        id: 'checkpointing',
        scriptPath: `${this.resilientdbRoot}/track_pbft_checkpointing.bt`,
        bpftraceBin: this.bpftraceBin,
        db: this.db,
        dbKey: this.dbKey,
        ringSize: this.ringSize,
      }),
      viewchange: new PbftViewChangeProgram({
        id: 'viewchange',
        scriptPath: `${this.resilientdbRoot}/track_pbft_view_changes.bt`,
        bpftraceBin: this.bpftraceBin,
        db: this.db,
        dbKey: this.dbKey,
        ringSize: this.ringSize,
      }),
    };
  }

  list() {
    const out = {};
    for (const [k, p] of Object.entries(this.programs)) {
      out[k] = p.status();
    }
    return out;
  }

  get(id) {
    const canonicalId = id === 'phases' ? 'commitment' : id;
    const p = this.programs[canonicalId];
    if (!p) {
      const err = new Error(`unknown program '${id}'`);
      err.code = 'UNKNOWN_PROGRAM';
      throw err;
    }
    return p;
  }
}

module.exports = { ProgramManager };
