# bpftrace-agent (ResLens PBFT Tracing)

This service is a small **Node.js + Express** API that manages long-running **bpftrace** programs to observe PBFT execution on a ResilientDB node.

It:

- **spawns** `bpftrace` as a child process (`src/programs/base.js`)
- **parses** each output line into structured events (per program)
- **persists** aggregates + raw events into **LevelDB**
- exposes a simple HTTP API to **attach/detach** tracing and to **query** stored results

> Important: **bpftrace requires root privileges**, so attaching programs typically requires running this service as root or inside a privileged container.

---

## Programs

The agent manages three programs (see `src/manager.js`):

- `commitment` (PBFT phases/commitment timeline)
- `checkpointing`
- `viewchange`

Backwards compatibility:

- `phases` is treated as an alias for `commitment` (older clients may still call `phases`).

The default bpftrace scripts are expected to exist under `${RESILIENTDB_ROOT}`:

- `track_pbft_phases.bt`
- `track_pbft_checkpointing.bt`
- `track_pbft_view_changes.bt`

---

## Requirements

- Node.js **>= 16** (recommended: 20+)
- `bpftrace` installed on the host (or available in the container)
- Linux kernel features required for eBPF/bpftrace

---

## Running locally (host)

### 1) Install dependencies

From `bpftrace-agent/`:

- `npm install`

### 2) Start the server

The server listens on **port 7500** by default.

If you have `nvm` installed, it’s common to have a modern Node in your shell, but an older system Node under `sudo`.

Example from this environment:

- user shell `node`: v20.x (`~/.nvm/.../node`)
- `sudo node`: v12.x (`/usr/bin/node`) → **will fail to parse modern JS** (e.g., optional chaining `?.`)

To run as root **and** use your modern NVM Node, start it like this:

```bash
sudo /home/ubuntu/.nvm/versions/node/v20.19.2/bin/node server.js
```

> Replace the Node path with your actual NVM Node path.

---

## Configuration

Environment variables:

- `PORT` (default: `7500`)
- `RESILIENTDB_ROOT` (default: `/home/ubuntu/production/incubator-resilientdb`)
- `DB_PATH`
  - default: `./bpftrace-agent-db` (created in the current working directory)
  - override if you want the DB elsewhere
- `BPFTRACE_BIN` (default: `bpftrace`)
- `RING_SIZE` (default: `50000`) – number of raw output lines kept in memory per program

Note on DB permissions:

- If you start the server with `sudo`, the DB directory may be created as **root-owned**.
- If you later run without `sudo`, you may need to delete/chown `./bpftrace-agent-db` or set `DB_PATH` to a user-writable location.

---

## API

### Health and program status

- `GET /health` – server status + all programs
- `GET /bpf/programs` – program status only
- `GET /bpf/:program/status` – status for a single program
- `GET /bpf/:program/raw?tail=2000` – tail recent raw bpftrace output

### Attach / Detach (start/stop tracing)

Attach starts a **long-running** `bpftrace` subprocess. No sequence number is passed here.

- `POST /bpf/:program/attach`
  - optional JSON body: `{ "scriptPath": "/path/to/script.bt" }`

- `POST /bpf/:program/detach`

Examples:

```bash
curl -X POST http://localhost:7500/bpf/commitment/attach
curl -X POST http://localhost:7500/bpf/commitment/detach
```

> Note: Using a browser to visit an attach URL sends a **GET**, which is not supported.

### Query stored data (sequence number is used here)

- `GET /bpf/commitment/:seq?self=<replicaId>`
  - If `self` is omitted, returns all replicas that have data for that `seq`.

- `GET /bpf/checkpointing/:ckpt_seq?limit=2000`
- `GET /bpf/viewchange/:view?limit=2000`

Examples:

```bash
curl http://localhost:7500/bpf/commitment/12345
curl http://localhost:7500/bpf/commitment/12345?self=2
```

---

## How it works (internals)

- Child process creation happens in `src/programs/base.js`:
  - `spawn(this.bpftraceBin, ['-v', this.scriptPath], ...)`
- Each program implements:
  - `parseLine(line)` → parse a bpftrace line into a structured event
  - `handleEvent(event)` → store aggregates and/or raw events into LevelDB

The `commitment` program implementation is in `src/programs/pbftPhases.js`.

---

## Docker usage (recommended)

This repository also ships a `docker-compose.yml` at the repo root that runs `bpftrace-agent` with:

- `privileged: true`
- `pid: "host"`
- mounts for `/sys`, `/sys/kernel/tracing`, etc.

That setup is typically the easiest way to satisfy bpftrace’s privilege requirements.
