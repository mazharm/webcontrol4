// ---------------------------------------------------------------------------
// trending.js – SQLite-backed trending engine for device history & analytics
// ---------------------------------------------------------------------------
//
// Records every device variable-change event, computes daily rollups,
// maintains 14-day baselines, and detects anomalies (> 2 σ from mean).
//
// Storage: data/trending.db  (WAL mode for concurrent read performance)
// ---------------------------------------------------------------------------

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS device_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  var_name TEXT NOT NULL,
  value TEXT,
  old_value TEXT,
  timestamp INTEGER NOT NULL,
  date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_item_date ON device_events(item_id, date);
CREATE INDEX IF NOT EXISTS idx_events_ts ON device_events(timestamp);

CREATE TABLE IF NOT EXISTS daily_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  var_name TEXT NOT NULL,
  date TEXT NOT NULL,
  event_count INTEGER DEFAULT 0,
  min_value REAL,
  max_value REAL,
  avg_value REAL,
  total_on_minutes REAL,
  first_value TEXT,
  last_value TEXT,
  UNIQUE(item_id, var_name, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_item ON daily_summaries(item_id, date);

CREATE TABLE IF NOT EXISTS home_mode_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_minutes REAL,
  confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_mode_started ON home_mode_log(started_at);
`;

const FLUSH_INTERVAL_MS = 5000;
const BUFFER_MAX = 1000;
const RAW_RETENTION_DAYS = 30;
const BASELINE_DAYS = 14;

class TrendingEngine {
  /**
   * @param {object}   opts
   * @param {string}   opts.dbPath  – full path to SQLite file
   * @param {function} [opts.logger]
   */
  constructor({ dbPath, logger }) {
    this._dbPath = dbPath;
    this._logger = logger || (() => {});
    this._buffer = [];
    this._bufferTimer = null;
    this._rollupTimer = null;
    this._db = null;

    // Prepared statements (set in init)
    this._insertStmt = null;

    // Track current home mode for mode-log
    this._currentMode = null;
    this._currentModeStart = null;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  init() {
    // Ensure parent directory exists
    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._db = new Database(this._dbPath);
    this._db.pragma("journal_mode = WAL");
    this._db.pragma("synchronous = NORMAL");
    this._db.exec(SCHEMA_SQL);

    this._insertStmt = this._db.prepare(
      "INSERT INTO device_events (item_id, var_name, value, old_value, timestamp, date) VALUES (?, ?, ?, ?, ?, ?)"
    );

    this._startBufferTimer();
    this._scheduleDailyRollup();

    this._logger("trending-init", this._dbPath);
  }

  close() {
    this.flush();
    this._clearTimers();
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  // -----------------------------------------------------------------------
  // Write – buffered event recording
  // -----------------------------------------------------------------------

  /** Buffer a device event for batch writing. */
  recordEvent({ itemId, varName, value, oldValue, timestamp }) {
    this._buffer.push({
      itemId: Number(itemId),
      varName: String(varName),
      value: String(value ?? ""),
      oldValue: String(oldValue ?? ""),
      timestamp: timestamp || Date.now(),
    });

    if (this._buffer.length >= BUFFER_MAX) {
      this.flush();
    }
  }

  /** Flush buffer to SQLite in a single transaction. */
  flush() {
    if (!this._db || this._buffer.length === 0) return;

    const events = this._buffer.splice(0);

    const insertMany = this._db.transaction((rows) => {
      for (const e of rows) {
        const dateStr = new Date(e.timestamp).toISOString().slice(0, 10);
        this._insertStmt.run(e.itemId, e.varName, e.value, e.oldValue, e.timestamp, dateStr);
      }
    });

    try {
      insertMany(events);
    } catch (err) {
      this._logger("trending-flush-error", err.message);
    }
  }

  /** Record a home-mode transition. */
  recordModeChange(newMode, confidence) {
    if (!this._db) return;

    const now = Date.now();

    // Close previous mode entry
    if (this._currentMode && this._currentModeStart) {
      const duration = (now - this._currentModeStart) / 60000;
      try {
        this._db.prepare(
          "UPDATE home_mode_log SET ended_at = ?, duration_minutes = ? WHERE mode = ? AND started_at = ? AND ended_at IS NULL"
        ).run(now, duration, this._currentMode, this._currentModeStart);
      } catch (err) { this._logger("trending-mode-update-error", err.message); }
    }

    // Open new mode entry
    try {
      this._db.prepare(
        "INSERT INTO home_mode_log (mode, started_at, confidence) VALUES (?, ?, ?)"
      ).run(newMode, now, confidence === "high" ? 1.0 : confidence === "medium" ? 0.6 : 0.3);
    } catch (err) {
      this._logger("trending-mode-log-error", err.message);
    }

    this._currentMode = newMode;
    this._currentModeStart = now;
  }

  // -----------------------------------------------------------------------
  // Read API
  // -----------------------------------------------------------------------

  /** Raw events for a device within a time window. */
  getDeviceHistory(itemId, hours = 24) {
    if (!this._db) return [];
    const cutoff = Date.now() - hours * 3600 * 1000;
    return this._db.prepare(
      "SELECT item_id, var_name, value, old_value, timestamp FROM device_events WHERE item_id = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT 1000"
    ).all(Number(itemId), cutoff);
  }

  /** Daily summaries for a device. */
  getDailySummary(itemId, days = 7) {
    if (!this._db) return [];
    const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return this._db.prepare(
      "SELECT * FROM daily_summaries WHERE item_id = ? AND date >= ? ORDER BY date DESC"
    ).all(Number(itemId), cutoffDate);
  }

  /** Trend data: daily values for a specific variable. */
  getDeviceTrend(itemId, variable, days = 14) {
    if (!this._db) return [];
    const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return this._db.prepare(
      "SELECT date, event_count, min_value, max_value, avg_value, total_on_minutes FROM daily_summaries WHERE item_id = ? AND var_name = ? AND date >= ? ORDER BY date ASC"
    ).all(Number(itemId), variable, cutoffDate);
  }

  /** Detect anomalies in recent events (values > 2σ from baseline). */
  getAnomalies(hours = 24) {
    if (!this._db) return [];
    const cutoff = Date.now() - hours * 3600 * 1000;

    // Get recent daily summaries grouped by device+variable
    const todayStr = new Date().toISOString().slice(0, 10);
    const recentSummaries = this._db.prepare(
      "SELECT item_id, var_name, avg_value, event_count FROM daily_summaries WHERE date = ? AND avg_value IS NOT NULL"
    ).all(todayStr);

    const anomalies = [];
    const baselineCache = new Map();

    for (const summary of recentSummaries) {
      const key = `${summary.item_id}:${summary.var_name}`;
      let baseline = baselineCache.get(key);
      if (!baseline) {
        baseline = this._computeBaseline(summary.item_id, summary.var_name);
        baselineCache.set(key, baseline);
      }

      if (!baseline || baseline.samples < 5) continue;

      const deviation = Math.abs(summary.avg_value - baseline.mean);
      if (deviation > 2 * baseline.stddev && baseline.stddev > 0) {
        anomalies.push({
          itemId: summary.item_id,
          varName: summary.var_name,
          todayAvg: Math.round(summary.avg_value * 100) / 100,
          baselineMean: baseline.mean,
          baselineStddev: baseline.stddev,
          deviationSigma: Math.round((deviation / baseline.stddev) * 10) / 10,
          todayCount: summary.event_count,
        });
      }
    }

    return anomalies;
  }

  /** 14-day rolling baseline for a device. */
  getBaseline(itemId) {
    if (!this._db) return {};

    // Get all variable names for this device
    const varNames = this._db.prepare(
      "SELECT DISTINCT var_name FROM daily_summaries WHERE item_id = ?"
    ).all(Number(itemId));

    const result = {};
    for (const { var_name } of varNames) {
      result[var_name] = this._computeBaseline(Number(itemId), var_name);
    }
    return result;
  }

  _computeBaseline(itemId, varName) {
    const cutoffDate = new Date(Date.now() - BASELINE_DAYS * 86400000).toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);

    const rows = this._db.prepare(
      "SELECT avg_value, event_count FROM daily_summaries WHERE item_id = ? AND var_name = ? AND date >= ? AND date < ? AND avg_value IS NOT NULL"
    ).all(itemId, varName, cutoffDate, todayStr);

    if (rows.length === 0) return null;

    const values = rows.map(r => r.avg_value);
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);

    return {
      mean: Math.round(mean * 100) / 100,
      stddev: Math.round(stddev * 100) / 100,
      min: values.reduce((a, b) => Math.min(a, b), Infinity),
      max: values.reduce((a, b) => Math.max(a, b), -Infinity),
      samples: n,
    };
  }

  /** Home mode history. */
  getModeHistory(hours = 24) {
    if (!this._db) return [];
    const cutoff = Date.now() - hours * 3600 * 1000;
    return this._db.prepare(
      "SELECT * FROM home_mode_log WHERE started_at > ? ORDER BY started_at DESC"
    ).all(cutoff);
  }

  /** DB stats for health endpoint. */
  getStats() {
    if (!this._db) return { events: 0, summaries: 0, modes: 0 };
    try {
      const events = this._db.prepare("SELECT COUNT(*) as c FROM device_events").get().c;
      const summaries = this._db.prepare("SELECT COUNT(*) as c FROM daily_summaries").get().c;
      const modes = this._db.prepare("SELECT COUNT(*) as c FROM home_mode_log").get().c;
      return { events, summaries, modes, bufferSize: this._buffer.length };
    } catch (err) {
      this._logger("trending-stats-error", err.message);
      return { events: 0, summaries: 0, modes: 0, bufferSize: this._buffer.length };
    }
  }

  // -----------------------------------------------------------------------
  // Maintenance
  // -----------------------------------------------------------------------

  _startBufferTimer() {
    this._bufferTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    if (this._bufferTimer.unref) this._bufferTimer.unref();
  }

  _scheduleDailyRollup() {
    const scheduleNext = () => {
      const now = new Date();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 5, 0); // 5 seconds past midnight
      const msUntilMidnight = midnight.getTime() - now.getTime();

      this._rollupTimer = setTimeout(() => {
        this._rollupDaily();
        this._pruneOldEvents();
        scheduleNext(); // re-schedule based on next midnight to avoid drift
      }, msUntilMidnight);

      if (this._rollupTimer.unref) this._rollupTimer.unref();
      this._logger("trending-rollup-scheduled", `in ${Math.round(msUntilMidnight / 60000)}m`);
    };

    scheduleNext();
  }

  _rollupDaily() {
    if (!this._db) return;

    // Flush any pending events first
    this.flush();

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().slice(0, 10);

    this._logger("trending-rollup", dateStr);

    try {
      // Get distinct item_id + var_name combos for yesterday
      const combos = this._db.prepare(
        "SELECT DISTINCT item_id, var_name FROM device_events WHERE date = ?"
      ).all(dateStr);

      const upsert = this._db.prepare(`
        INSERT OR REPLACE INTO daily_summaries
          (item_id, var_name, date, event_count, min_value, max_value, avg_value, total_on_minutes, first_value, last_value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const rollup = this._db.transaction(() => {
        for (const { item_id, var_name } of combos) {
          const events = this._db.prepare(
            "SELECT value, timestamp FROM device_events WHERE item_id = ? AND var_name = ? AND date = ? ORDER BY timestamp ASC"
          ).all(item_id, var_name, dateStr);

          if (events.length === 0) continue;

          const numericValues = events.map(e => parseFloat(e.value)).filter(v => Number.isFinite(v));
          const minVal = numericValues.length > 0 ? numericValues.reduce((a, b) => Math.min(a, b), Infinity) : null;
          const maxVal = numericValues.length > 0 ? numericValues.reduce((a, b) => Math.max(a, b), -Infinity) : null;
          const avgVal = numericValues.length > 0
            ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length
            : null;

          // Calculate total on-time for binary states (lights, HVAC)
          let totalOnMinutes = null;
          if (var_name === "LIGHT_STATE" || var_name === "HVAC_STATE" || var_name === "POWER_STATE") {
            totalOnMinutes = 0;
            let lastOnTs = null;
            for (const e of events) {
              const isOn = e.value === "1" || e.value === "Running" || e.value === "true";
              if (isOn && lastOnTs === null) {
                lastOnTs = e.timestamp;
              } else if (!isOn && lastOnTs !== null) {
                totalOnMinutes += (e.timestamp - lastOnTs) / 60000;
                lastOnTs = null;
              }
            }
            // If still on at end of day, count up to midnight
            if (lastOnTs !== null) {
              const endOfDay = new Date(dateStr + "T23:59:59.999Z").getTime();
              totalOnMinutes += (endOfDay - lastOnTs) / 60000;
            }
            totalOnMinutes = Math.round(totalOnMinutes * 10) / 10;
          }

          upsert.run(
            item_id, var_name, dateStr,
            events.length,
            minVal, maxVal, avgVal,
            totalOnMinutes,
            events[0].value,
            events[events.length - 1].value
          );
        }
      });

      rollup();
      this._logger("trending-rollup-complete", { date: dateStr, combos: combos.length });
    } catch (err) {
      this._logger("trending-rollup-error", err.message);
    }
  }

  _pruneOldEvents() {
    if (!this._db) return;
    const cutoff = Date.now() - RAW_RETENTION_DAYS * 24 * 3600 * 1000;
    try {
      const result = this._db.prepare("DELETE FROM device_events WHERE timestamp < ?").run(cutoff);
      this._logger("trending-prune", { deleted: result.changes });
    } catch (err) {
      this._logger("trending-prune-error", err.message);
    }
  }

  _clearTimers() {
    if (this._bufferTimer) { clearInterval(this._bufferTimer); this._bufferTimer = null; }
    if (this._rollupTimer) { clearTimeout(this._rollupTimer); this._rollupTimer = null; }
  }
}

module.exports = { TrendingEngine };
