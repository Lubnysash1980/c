CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT);
CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT, token TEXT UNIQUE, allowed_commands TEXT);
CREATE TABLE commands (id INTEGER PRIMARY KEY, agent_id INTEGER, command TEXT, signature TEXT, created_at INTEGER, status TEXT);
CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, cmd_id INTEGER, agent_result TEXT, created_at INTEGER);
