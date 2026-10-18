'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
function openDatabase(filename){
  if(filename!==':memory:')fs.mkdirSync(path.dirname(filename),{recursive:true});
  const db=new DatabaseSync(filename,{timeout:5000});
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT, role TEXT NOT NULL CHECK(role IN ('Admin','Staff')),
      status TEXT NOT NULL CHECK(status IN ('Active','Invited','Disabled')), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      purpose TEXT NOT NULL CHECK(purpose IN ('reset','invite')), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE,
      role TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Pending',
      created_at TEXT NOT NULL, reviewed_by INTEGER REFERENCES users(id), user_id INTEGER REFERENCES users(id),
      reviewed_at TEXT, email_status TEXT NOT NULL DEFAULT 'Not sent'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pending_request_email ON account_requests(email) WHERE status='Pending';
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL,
      visits INTEGER NOT NULL DEFAULT 0 CHECK(visits>=0), last_visit TEXT, deleted INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK(price_cents>0), category TEXT NOT NULL CHECK(category IN ('Food','Beverages')),
      image TEXT NOT NULL DEFAULT 'pasta', available INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS dining_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT, seats INTEGER NOT NULL CHECK(seats BETWEEN 1 AND 50),
      status TEXT NOT NULL CHECK(status IN ('Available','Occupied','Reserved')), version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER REFERENCES customers(id), customer_name TEXT NOT NULL,
      table_id INTEGER NOT NULL REFERENCES dining_tables(id),
      status TEXT NOT NULL CHECK(status IN ('Pending','Preparing','Served','Completed','Cancelled')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      menu_id INTEGER NOT NULL REFERENCES menu_items(id), name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK(price_cents>0), qty INTEGER NOT NULL CHECK(qty BETWEEN 1 AND 999)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      subtotal_cents INTEGER NOT NULL, vat_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
      tendered_cents INTEGER NOT NULL, method TEXT NOT NULL CHECK(method IN ('Cash','Card','GCash')),
      reference TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
      cashier_id INTEGER NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_preferences (user_id INTEGER PRIMARY KEY REFERENCES users(id), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS email_deliveries (user_id INTEGER NOT NULL REFERENCES users(id), date_key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_attempt INTEGER NOT NULL, PRIMARY KEY(user_id,date_key));
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS tokens_expiry ON auth_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS orders_table ON orders(table_id,status);
    CREATE INDEX IF NOT EXISTS transaction_date ON transactions(created_at);
    PRAGMA user_version=1;
  `);
  const profile={name:'Dine Flow',address:'1805 Sto. Niño, Marikina City, Philippines',phone:'+63 2 8123 4567',email:''};
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run('profile',JSON.stringify(profile));
  return db;
}
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value}catch(error){db.exec('ROLLBACK');throw error}}
module.exports={openDatabase,transaction};
