# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at

#    http://www.apache.org/licenses/LICENSE-2.0

# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.



FROM node:18-alpine


WORKDIR /usr/src/app


COPY package*.json ./


RUN npm install


RUN apk add --no-cache curl && \
    curl -L https://dl.pyroscope.io/release/pyroscope-0.37.1-linux-amd64.tar.gz | tar xz && \
    mv pyroscope /usr/local/bin/pyroscope && \
    pyroscope --version # Verify the installation of Pyroscope CLI


COPY . .


EXPOSE 4040


CMD ["sh", "-c", "if [ \"$ROLE\" = \"server\" ]; then pyroscope server --log-level info --storage-path /host/pyroscope-data --retention 24h; else node connect_pyroscope.js; fi"]