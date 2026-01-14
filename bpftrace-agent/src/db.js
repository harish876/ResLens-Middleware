const { Level } = require('level');

function createDb(dbPath) {
  return new Level(dbPath, { valueEncoding: 'json' });
}

function key(...parts) {
  // Use \x1f as a separator to avoid ambiguity with ':' that may appear in fields.
  return parts.map(String).join('\x1f');
}

module.exports = { createDb, key };
