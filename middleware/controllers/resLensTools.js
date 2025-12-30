/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*
*/

const { spawn } = require('child_process');
const logger = require('../utils/logger');

class ResLensToolsService {
  constructor() {
    this.projectRoot = process.env.RESILIENTDB_ROOT || '/home/ubuntu/incubator-resilientdb';
    this.workerRunning = false;
    this.workerType = null;
    this.workerProcess = null;
    logger.info(`ResLens Tools Service - Using project root: ${this.projectRoot}`);
  }

  getToolPath() {
    return `${this.projectRoot}/bazel-bin/service/tools/kv/api_tools/kv_service_tools`;
  }

  getConfigPath() {
    return `${this.projectRoot}/service/tools/config/interface/service.config`;
  }

  startSeeding(count) {
    if (this.workerRunning) {
      return {
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: 'Worker job already running'
      };
    }

    this.workerRunning = true;
    this.workerType = 'seeding';

    let completed = 0;
    const toolPath = this.getToolPath();
    const configPath = this.getConfigPath();

    const worker = () => {
      const executeNext = () => {
        if (completed >= count || !this.workerRunning) {
          this.workerRunning = false;
          this.workerType = null;
          logger.info(`Seeding job completed: ${completed}/${count} operations`);
          return;
        }

        const key = `key${Math.floor(Math.random() * 500)}`;
        const value = `value${Math.floor(Math.random() * 500)}`;

        const proc = spawn(toolPath, [
          '--config', configPath,
          '--cmd', 'set',
          '--key', key,
          '--value', value
        ]);

        let timeout = setTimeout(() => {
          proc.kill();
        }, 30000); // 30 second timeout

        proc.on('close', () => {
          clearTimeout(timeout);
          completed++;
          setTimeout(executeNext, 100); // 100ms delay between operations
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          logger.error(`Seeding operation error: ${err.message}`);
          completed++;
          setTimeout(executeNext, 100);
        });
      };

      executeNext();
    };

    // Run worker in background
    setImmediate(worker);

    return {
      service: 'ResLens Flamegraph Analysis Service',
      status: 'success',
      message: `Started seeding job with ${count} operations`
    };
  }

  stopSeeding() {
    if (!this.workerRunning || this.workerType !== 'seeding') {
      return {
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: 'No seeding job running'
      };
    }

    this.workerRunning = false;

    if (this.workerProcess) {
      this.workerProcess.kill();
    }

    return {
      service: 'ResLens Flamegraph Analysis Service',
      status: 'success',
      message: 'Seeding job stopped'
    };
  }

  getSeedingStatus() {
    return {
      service: 'ResLens Flamegraph Analysis Service',
      status: this.workerRunning && this.workerType === 'seeding' ? 'running' : 'stopped'
    };
  }

  startGetting(keys, count) {
    if (this.workerRunning) {
      return {
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: 'Worker job already running'
      };
    }

    if (!keys || keys.length === 0) {
      return {
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: 'Keys array cannot be empty'
      };
    }

    if (![100, 500, 1000].includes(count)) {
      return {
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: 'Count must be 100, 500, or 1000'
      };
    }

    this.workerRunning = true;
    this.workerType = 'getting';

    let completed = 0;
    const toolPath = this.getToolPath();
    const configPath = this.getConfigPath();

    const worker = () => {
      const executeNext = () => {
        if (completed >= count || !this.workerRunning) {
          this.workerRunning = false;
          this.workerType = null;
          logger.info(`GET job completed: ${completed}/${count} operations`);
          return;
        }

        const key = keys[Math.floor(Math.random() * keys.length)];

        const proc = spawn(toolPath, [
          '--config', configPath,
          '--cmd', 'get',
          '--key', key
        ]);

        let timeout = setTimeout(() => {
          proc.kill();
        }, 30000); // 30 second timeout

        proc.on('close', () => {
          clearTimeout(timeout);
          completed++;
          setTimeout(executeNext, 100); // 100ms delay between operations
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          logger.error(`GET operation error: ${err.message}`);
          completed++;
          setTimeout(executeNext, 100);
        });
      };

      executeNext();
    };

    // Run worker in background
    setImmediate(worker);

    return {
      service: 'ResLens Flamegraph Analysis Service',
      status: 'success',
      message: `Started GET job with ${count} operations sampling from ${keys.length} keys`
    };
  }

  stopGetting() {
    if (!this.workerRunning || this.workerType !== 'getting') {
      return {
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: 'No GET job running'
      };
    }

    this.workerRunning = false;

    if (this.workerProcess) {
      this.workerProcess.kill();
    }

    return {
      service: 'ResLens Flamegraph Analysis Service',
      status: 'success',
      message: 'GET job stopped'
    };
  }

  getGettingStatus() {
    return {
      service: 'ResLens Flamegraph Analysis Service',
      status: this.workerRunning && this.workerType === 'getting' ? 'running' : 'stopped'
    };
  }
}

// Global service instance
const service = new ResLensToolsService();

function health(req, res) {
  return res.json({
    service: 'ResLens Flamegraph Analysis Service',
    status: 'ok'
  });
}

function startSeeding(req, res) {
  try {
    const { count } = req.body;

    if (!count) {
      return res.status(400).json({
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: "Missing 'count' parameter"
      });
    }

    if (!Number.isInteger(count) || count <= 0) {
      return res.status(400).json({
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: 'Count must be a positive integer'
      });
    }

    const result = service.startSeeding(count);
    return res.json(result);
  } catch (error) {
    logger.error(`Error starting seeding: ${error.message}`);
    return res.status(500).json({
      service: 'ResLens Flamegraph Analysis Service',
      status: 'error',
      message: error.message
    });
  }
}

function stopSeeding(req, res) {
  const result = service.stopSeeding();
  return res.json(result);
}

function getSeedingStatus(req, res) {
  const result = service.getSeedingStatus();
  return res.json(result);
}

function startGetting(req, res) {
  try {
    const { keys, count } = req.body;

    if (!keys) {
      return res.status(400).json({
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: "Missing 'keys' parameter"
      });
    }

    if (!Array.isArray(keys) || keys.length === 0) {
      return res.status(400).json({
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: 'Keys must be a non-empty array'
      });
    }

    if (!count) {
      return res.status(400).json({
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: "Missing 'count' parameter"
      });
    }

    if (![100, 500, 1000].includes(count)) {
      return res.status(400).json({
        service: 'ResLens Flamegraph Analysis Service',
        status: 'error',
        message: 'Count must be 100, 500, or 1000'
      });
    }

    const result = service.startGetting(keys, count);
    return res.json(result);
  } catch (error) {
    logger.error(`Error starting GET job: ${error.message}`);
    return res.status(500).json({
      service: 'ResLens Flamegraph Analysis Service',
      status: 'error',
      message: error.message
    });
  }
}

function stopGetting(req, res) {
  const result = service.stopGetting();
  return res.json(result);
}

function getGettingStatus(req, res) {
  const result = service.getGettingStatus();
  return res.json(result);
}

function serviceInfo(req, res) {
  return res.json({
    service: 'ResLens Flamegraph Analysis Service',
    description: 'HTTP service for executing ResilientDB random data operations',
    endpoints: {
      'GET /reslens-tools/health': 'Health check',
      'POST /reslens-tools/seed': 'Start data seeding job (JSON body: {"count": 5})',
      'POST /reslens-tools/stop': 'Stop data seeding job',
      'GET /reslens-tools/status': 'Get seeding job status',
      'POST /reslens-tools/get': 'Start GET request job (JSON body: {"keys": ["key1", "key2"], "count": 100})',
      'POST /reslens-tools/stop_get': 'Stop GET request job',
      'GET /reslens-tools/status_get': 'Get GET job status'
    },
    example: {
      'POST /reslens-tools/seed': {
        body: { count: 10 },
        response: 'Starts background job to execute 10 random set operations'
      },
      'POST /reslens-tools/stop': {
        body: {},
        response: 'Stops the running seeding job'
      },
      'POST /reslens-tools/get': {
        body: { keys: ['key1', 'key2', 'key3'], count: 500 },
        response: 'Starts background job to execute 500 random GET operations sampling from provided keys'
      },
      'POST /reslens-tools/stop_get': {
        body: {},
        response: 'Stops the running GET job'
      }
    }
  });
}

module.exports = {
  health,
  startSeeding,
  stopSeeding,
  getSeedingStatus,
  startGetting,
  stopGetting,
  getGettingStatus,
  serviceInfo
};
