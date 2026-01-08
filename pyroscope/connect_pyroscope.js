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

const { exec } = require("child_process");

const server_addr = process.env.PYROSCOPE_SERVER_ADDRESS || "http://localhost:4040";

// Connect all kv_service replicas
exec("pgrep -f kv_service", (err, stdout, stderr) => {
  if (err) {
    console.error(`Error finding kv_service processes: ${stderr}`);
    return;
  }

  const pids = stdout.trim().split('\n').filter(pid => pid && /^\d+$/.test(pid));

  if (pids.length > 0) {
    let replicaNum = 1;
    pids.forEach((pid) => {
      console.log(`PID of CPP Client-${replicaNum} (kv_service): ${pid}`);
      const command = `pyroscope connect --server-address ${server_addr} --application-name cpp_client_${replicaNum} --spy-name ebpfspy --pid ${pid}`;
      exec(command, (err, stdout, stderr) => {
        if (err) {
          console.error(`Error running pyroscope connect for kv_service replica ${replicaNum}: ${stderr}`);
          return;
        }
        console.log(`Pyroscope connected to kv_service replica ${replicaNum} successfully:\n${stdout}`);
      });
      replicaNum++;
    });
  } else {
    console.log("kv_service processes not found.");
  }
});

// Connect crow_service
exec("pgrep -f crow_service_main | head -n 1", (err, stdout, stderr) => {
  if (err) {
    console.error(`Error finding crow_service_main process: ${stderr}`);
    return;
  }

  const pid = stdout.trim();

  if (pid) {
    console.log("PID of Crow Service (GraphQL HTTP Server):", pid);
    const command = `pyroscope connect --server-address ${server_addr} --application-name crow_service_main --spy-name ebpfspy --pid ${pid}`;
    exec(command, (err, stdout, stderr) => {
      if (err) {
        console.error(`Error running pyroscope connect for crow_service: ${stderr}`);
        return;
      }
      console.log(`Pyroscope connected to crow_service successfully:\n${stdout}`);
    });
  } else {
    console.log("crow_service_main process not found.");
  }
});