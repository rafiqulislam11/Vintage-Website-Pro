const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const dbPath = path.resolve(process.env.DB_PATH || './data/vintage_saas.sqlite');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(dbPath);

// Enable WAL mode and foreign keys for high concurrency & integrity
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Run migrations from schema.sql
const schemaPath = path.join(__dirname, 'schema.sql');
if (fs.existsSync(schemaPath)) {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
}

// Ensure 'role' column exists in users table if upgrading existing db
try {
  const userCols = db.prepare("PRAGMA table_info(users)").all();
  const hasRole = userCols.some(c => c.name === 'role');
  if (!hasRole) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';");
  }
} catch (e) {
  console.error("Migration warning (users.role):", e.message);
}

// Seed initial system settings if empty
const defaultSettings = [
  ['bkash_number', '01930279175'],
  ['nagad_number', '01930279175'],
  ['whatsapp_number', '01310824987'],
  ['price_monthly', '500'],
  ['price_yearly', '1500'],
  ['price_lifetime', '3000'],
  ['duration_monthly', '30'],
  ['duration_yearly', '365']
];

const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
for (const [key, val] of defaultSettings) {
  const exists = db.prepare('SELECT key FROM system_settings WHERE key = ?').get(key);
  if (!exists) {
    db.prepare('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, val, now);
  }
}

module.exports = db;
