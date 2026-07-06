/**
 * db.js — SQLite via Node.js built-in node:sqlite (Node 24+, no compilation needed)
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'library.db'));

// ─── Pragmas ───────────────────────────────────────────────────────────────────
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ─── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    type         TEXT    NOT NULL DEFAULT 'book',
    author       TEXT    NOT NULL DEFAULT '',
    publisher    TEXT    NOT NULL DEFAULT '',
    year         TEXT    NOT NULL DEFAULT '',
    description  TEXT    NOT NULL DEFAULT '',
    isbn         TEXT    NOT NULL DEFAULT '',
    barcode      TEXT    NOT NULL DEFAULT '',
    apex_id      TEXT    NOT NULL DEFAULT '',
    condition    TEXT    NOT NULL DEFAULT 'Good',
    status       TEXT    NOT NULL DEFAULT 'Available',
    cover_url    TEXT    NOT NULL DEFAULT '',
    location     TEXT    NOT NULL DEFAULT '',
    notes        TEXT    NOT NULL DEFAULT '',
    added_date   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS checkouts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id       INTEGER NOT NULL,
    member_name   TEXT    NOT NULL,
    member_id     TEXT    NOT NULL DEFAULT '',
    checkout_date TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    due_date      TEXT,
    return_date   TEXT,
    notes         TEXT    NOT NULL DEFAULT '',
    FOREIGN KEY (item_id) REFERENCES items(id)
  );

  CREATE INDEX IF NOT EXISTS idx_items_status   ON items(status);
  CREATE INDEX IF NOT EXISTS idx_items_type     ON items(type);
  CREATE INDEX IF NOT EXISTS idx_items_barcode  ON items(barcode);
  CREATE INDEX IF NOT EXISTS idx_items_isbn     ON items(isbn);
  CREATE INDEX IF NOT EXISTS idx_co_item        ON checkouts(item_id);
  CREATE INDEX IF NOT EXISTS idx_co_return      ON checkouts(return_date);

  CREATE TABLE IF NOT EXISTS archives (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'photo',
    category    TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    file_url    TEXT    NOT NULL DEFAULT '',
    thumb_url   TEXT    NOT NULL DEFAULT '',
    date_label  TEXT    NOT NULL DEFAULT '',
    added_date  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_arch_type ON archives(type);
`);

// ─── Safe migration: add apex_id to existing databases ────────────────────────
try {
  db.exec(`ALTER TABLE items ADD COLUMN apex_id TEXT NOT NULL DEFAULT ''`);
} catch(e) { /* column already exists — ignore */ }
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_apex_id ON items(apex_id)`);
} catch(e) { /* index already exists — ignore */ }

// ─── Prepared Statements ───────────────────────────────────────────────────────
const q = {
  // Items
  getAll:   db.prepare('SELECT * FROM items ORDER BY title COLLATE NOCASE ASC'),
  getById:  db.prepare('SELECT * FROM items WHERE id = ?'),
  search:   db.prepare(`
    SELECT * FROM items
    WHERE title LIKE ? OR author LIKE ? OR isbn LIKE ? OR barcode LIKE ? OR publisher LIKE ? OR apex_id LIKE ?
    ORDER BY title COLLATE NOCASE ASC
  `),
  insert:   db.prepare(`
    INSERT INTO items (title,type,author,publisher,year,description,isbn,barcode,apex_id,condition,cover_url,location,notes)
    VALUES (@title,@type,@author,@publisher,@year,@description,@isbn,@barcode,@apex_id,@condition,@cover_url,@location,@notes)
  `),
  update:   db.prepare(`
    UPDATE items
    SET title=@title, type=@type, author=@author, publisher=@publisher, year=@year,
        description=@description, isbn=@isbn, barcode=@barcode, apex_id=@apex_id, condition=@condition,
        cover_url=@cover_url, location=@location, notes=@notes
    WHERE id=@id
  `),
  setStatus: db.prepare('UPDATE items SET status = ? WHERE id = ?'),
  delete:    db.prepare('DELETE FROM items WHERE id = ?'),
  stats:     db.prepare(`
    SELECT
      COUNT(*)                                                AS total,
      SUM(CASE WHEN status='Available'   THEN 1 ELSE 0 END)  AS available,
      SUM(CASE WHEN status='Checked Out' THEN 1 ELSE 0 END)  AS checked_out,
      SUM(CASE WHEN type='book'          THEN 1 ELSE 0 END)  AS books,
      SUM(CASE WHEN type='magazine'      THEN 1 ELSE 0 END)  AS magazines,
      SUM(CASE WHEN type='video'         THEN 1 ELSE 0 END)  AS videos,
      SUM(CASE WHEN type='game'          THEN 1 ELSE 0 END)  AS games,
      SUM(CASE WHEN type='puzzle'        THEN 1 ELSE 0 END)  AS puzzles
    FROM items
  `),

  // Checkouts
  activeAll: db.prepare(`
    SELECT c.*, i.title, i.type, i.author, i.cover_url
    FROM checkouts c JOIN items i ON c.item_id = i.id
    WHERE c.return_date IS NULL
    ORDER BY c.due_date ASC
  `),
  historyAll: db.prepare(`
    SELECT c.*, i.title, i.type, i.author
    FROM checkouts c JOIN items i ON c.item_id = i.id
    ORDER BY c.checkout_date DESC LIMIT 300
  `),
  overdue: db.prepare(`
    SELECT c.*, i.title, i.type, i.author
    FROM checkouts c JOIN items i ON c.item_id = i.id
    WHERE c.return_date IS NULL AND c.due_date < datetime('now','localtime')
    ORDER BY c.due_date ASC
  `),
  activeByItem: db.prepare('SELECT * FROM checkouts WHERE item_id = ? AND return_date IS NULL'),
  byMember:     db.prepare(`
    SELECT c.*, i.title, i.type, i.author, i.cover_url
    FROM checkouts c JOIN items i ON c.item_id = i.id
    WHERE c.member_name LIKE ? AND c.return_date IS NULL
    ORDER BY c.due_date ASC
  `),
  getCheckout: db.prepare('SELECT * FROM checkouts WHERE id = ?'),
  itemHistory: db.prepare('SELECT * FROM checkouts WHERE item_id = ? ORDER BY checkout_date DESC'),
  checkout:    db.prepare(`
    INSERT INTO checkouts (item_id, member_name, member_id, due_date, notes)
    VALUES (@item_id, @member_name, @member_id, @due_date, @notes)
  `),
  doReturn:    db.prepare(`
    UPDATE checkouts SET return_date = datetime('now','localtime') WHERE id = ?
  `),

  // Archives
  archiveAll:  db.prepare('SELECT * FROM archives ORDER BY added_date DESC'),
  archiveById: db.prepare('SELECT * FROM archives WHERE id = ?'),
  archiveIns:  db.prepare(`
    INSERT INTO archives (title,type,category,description,file_url,thumb_url,date_label)
    VALUES (@title,@type,@category,@description,@file_url,@thumb_url,@date_label)
  `),
  archiveUpd:  db.prepare(`
    UPDATE archives SET title=@title, type=@type, category=@category,
      description=@description, file_url=@file_url, thumb_url=@thumb_url, date_label=@date_label
    WHERE id=@id
  `),
  archiveDel:  db.prepare('DELETE FROM archives WHERE id = ?'),
};

module.exports = { db, q };
