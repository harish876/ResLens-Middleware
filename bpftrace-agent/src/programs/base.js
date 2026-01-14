const { spawn } = require('child_process');
const readline = require('readline');

class BpfProgram {
  /**
   * @param {{
   *   id: string,
   *   scriptPath: string,
   *   bpftraceBin: string,
   *   db: import('level').Level,
   *   dbKey: (...parts: any[]) => string,
   *   ringSize?: number
   * }} opts
   */
  constructor(opts) {
    this.id = opts.id;
    this.scriptPath = opts.scriptPath;
    this.bpftraceBin = opts.bpftraceBin;
    this.db = opts.db;
    this.dbKey = opts.dbKey;

    this.ringSize = Number(opts.ringSize || 50000);
    this._ring = [];
    this._ringPos = 0;

    this._proc = null;
    this._startedAt = null;

    // Serialize event handling to avoid DB races under high trace volume.
    this._eventQueue = Promise.resolve();
  }

  status() {
    return {
      id: this.id,
      running: !!(this._proc && this._proc.exitCode === null),
      pid: this._proc?.pid ?? null,
      scriptPath: this.scriptPath,
      startedAt: this._startedAt,
      exitCode: this._proc?.exitCode ?? null,
    };
  }

  isRunning() {
    return !!(this._proc && this._proc.exitCode === null);
  }

  ringTail(tail) {
    const n = Math.max(1, Math.min(Number(tail || 2000), this.ringSize));
    if (this._ring.length === 0) return [];

    let ordered;
    if (this._ring.length < this.ringSize) {
      ordered = this._ring;
    } else {
      ordered = this._ring.slice(this._ringPos).concat(this._ring.slice(0, this._ringPos));
    }

    return ordered.slice(Math.max(0, ordered.length - n));
  }

  _ringPush(line) {
    if (this._ring.length < this.ringSize) {
      this._ring.push(line);
    } else {
      this._ring[this._ringPos] = line;
      this._ringPos = (this._ringPos + 1) % this.ringSize;
    }
  }

  /** Override: parse a raw bpftrace line. Return null to ignore. */
  parseLine(_line) {
    throw new Error('parseLine not implemented');
  }

  /** Override: apply parsed event to DB (and optionally store raw event). */
  async handleEvent(_event) {
    throw new Error('handleEvent not implemented');
  }

  async attach({ scriptPath } = {}) {
    if (this.isRunning()) return this.status();

    if (scriptPath) this.scriptPath = scriptPath;

    this._startedAt = Date.now();
    this._proc = spawn(this.bpftraceBin, ['-v', this.scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._proc.on('exit', (code, signal) => {
      this._ringPush(`[exit] code=${code} signal=${signal}`);
    });

    const rlOut = readline.createInterface({ input: this._proc.stdout });
    rlOut.on('line', (line) => {
      this._ringPush(line);
      const ev = this.parseLine(line);
      if (!ev) return;

      this._eventQueue = this._eventQueue
        .then(() => this.handleEvent(ev))
        .catch((e) => {
          this._ringPush(`[handler-error] ${e?.stack || e}`);
        });
    });

    const rlErr = readline.createInterface({ input: this._proc.stderr });
    rlErr.on('line', (line) => {
      this._ringPush(`[stderr] ${line}`);
    });

    return this.status();
  }

  async detach() {
    if (!this._proc) return this.status();

    if (this._proc.exitCode !== null) return this.status();

    // Prefer graceful, then force.
    this._proc.kill('SIGINT');

    await new Promise((resolve) => setTimeout(resolve, 750));
    if (this._proc.exitCode === null) {
      this._proc.kill('SIGKILL');
    }

    return this.status();
  }
}

module.exports = { BpfProgram };
