'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function openLeaderboard(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'flip-blocks.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY,
      room TEXT NOT NULL,
      match_key TEXT NOT NULL UNIQUE,
      winner_name TEXT NOT NULL,
      loser_name TEXT NOT NULL,
      winner_pct REAL NOT NULL,
      loser_pct REAL NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_matches_winner ON matches(winner_name);
  `);
  const insert = db.prepare(`
    INSERT INTO matches (room, match_key, winner_name, loser_name, winner_pct, loser_pct, created_at)
    VALUES (@room, @matchKey, @winnerName, @loserName, @winnerPct, @loserPct, @createdAt)
  `);
  const topStmt = db.prepare(`
    SELECT winner_name AS name, COUNT(*) AS wins
    FROM matches
    GROUP BY winner_name
    ORDER BY wins DESC, name ASC
    LIMIT ?
  `);

  function record(entry) {
    if (!entry || typeof entry.matchKey !== 'string' || !entry.matchKey) return false;
    if (typeof entry.winnerName !== 'string' || typeof entry.loserName !== 'string') return false;
    try {
      insert.run({
        room: String(entry.room || ''),
        matchKey: entry.matchKey,
        winnerName: entry.winnerName,
        loserName: entry.loserName,
        winnerPct: Number(entry.winnerPct) || 0,
        loserPct: Number(entry.loserPct) || 0,
        createdAt: Date.now()
      });
      return true;
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
      console.error('無法寫入排行榜：', error);
      return false;
    }
  }

  return {
    record,
    top(limit = 20) {
      const n = Number.isInteger(limit) && limit > 0 && limit <= 20 ? limit : 20;
      return topStmt.all(n);
    },
    close() { db.close(); }
  };
}

module.exports = { openLeaderboard };
