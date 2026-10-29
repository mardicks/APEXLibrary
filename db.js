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

// ─── Safe migrations (idempotent) ─────────────────────────────────────────────
try { db.exec(`ALTER TABLE items ADD COLUMN apex_id TEXT NOT NULL DEFAULT ''`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_items_apex_id ON items(apex_id)`); } catch(e) {}
// Multi-copy support: parent_item_id links copies to their canonical record
try { db.exec(`ALTER TABLE items ADD COLUMN parent_item_id INTEGER REFERENCES items(id)`) } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_item_id)`) } catch(e) {}

// ─── Prepared Statements ───────────────────────────────────────────────────────
const q = {
  // Items — canonical records only (no copies in list views)
  getAll:      db.prepare(`SELECT * FROM items WHERE parent_item_id IS NULL ORDER BY title COLLATE NOCASE ASC`),
  getAllWithCopies: db.prepare(`SELECT * FROM items ORDER BY title COLLATE NOCASE ASC`),
  getById:     db.prepare('SELECT * FROM items WHERE id = ?'),
  getByParent: db.prepare('SELECT * FROM items WHERE parent_item_id = ? ORDER BY added_date ASC'),
  search:      db.prepare(`
    SELECT * FROM items
    WHERE parent_item_id IS NULL
      AND (title LIKE ? OR author LIKE ? OR isbn LIKE ? OR barcode LIKE ? OR publisher LIKE ? OR apex_id LIKE ?)
    ORDER BY title COLLATE NOCASE ASC
  `),
  // Count copies (including the canonical record itself)
  copyCount: db.prepare(`
    SELECT COUNT(*) AS cnt FROM items WHERE id = ?1 OR parent_item_id = ?1
  `),
  availCount: db.prepare(`
    SELECT COUNT(*) AS cnt FROM items
    WHERE (id = ?1 OR parent_item_id = ?1) AND status = 'Available'
  `),
  // Get all physical copies (canonical + linked copies)
  allCopies: db.prepare(`
    SELECT * FROM items WHERE id = ?1 OR parent_item_id = ?1 ORDER BY added_date ASC
  `),
  // First available copy for a group (used for checkout when patron picks a title)
  firstAvailCopy: db.prepare(`
    SELECT * FROM items
    WHERE (id = ?1 OR parent_item_id = ?1) AND status = 'Available'
    ORDER BY added_date ASC LIMIT 1
  `),
  insert:   db.prepare(`
    INSERT INTO items (title,type,author,publisher,year,description,isbn,barcode,apex_id,condition,cover_url,location,notes)
    VALUES (@title,@type,@author,@publisher,@year,@description,@isbn,@barcode,@apex_id,@condition,@cover_url,@location,@notes)
  `),
  // Insert a copy — shares metadata from parent, has its own apex_id/condition/location
  insertCopy: db.prepare(`
    INSERT INTO items (parent_item_id,title,type,author,publisher,year,description,isbn,barcode,apex_id,condition,cover_url,location,notes)
    VALUES (@parent_item_id,@title,@type,@author,@publisher,@year,@description,@isbn,@barcode,@apex_id,@condition,@cover_url,@location,@notes)
  `),
  update:   db.prepare(`
    UPDATE items
    SET title=@title, type=@type, author=@author, publisher=@publisher, year=@year,
        description=@description, isbn=@isbn, barcode=@barcode, apex_id=@apex_id, condition=@condition,
        cover_url=@cover_url, location=@location, notes=@notes
    WHERE id=@id
  `),
  // Cascade shared metadata from parent to all copies — does NOT touch copy-specific fields
  // (barcode, apex_id, condition, location, notes stay unique per physical copy)
  syncCopies: db.prepare(`
    UPDATE items SET title=@title, type=@type, author=@author, publisher=@publisher, year=@year,
      description=@description, isbn=@isbn, cover_url=@cover_url
    WHERE parent_item_id=@id
  `),
  setStatus: db.prepare('UPDATE items SET status = ? WHERE id = ?'),
  delete:    db.prepare('DELETE FROM items WHERE id = ?'),
  // Delete all copies when parent is deleted
  deleteCopies: db.prepare('DELETE FROM items WHERE parent_item_id = ?'),
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
    SELECT c.*, i.title, i.type, i.author, i.cover_url, i.apex_id
    FROM checkouts c JOIN items i ON c.item_id = i.id
    WHERE c.return_date IS NULL
    ORDER BY c.due_date ASC
  `),
  historyAll: db.prepare(`
    SELECT c.*, i.title, i.type, i.author, i.apex_id
    FROM checkouts c JOIN items i ON c.item_id = i.id
    ORDER BY c.checkout_date DESC LIMIT 300
  `),
  overdue: db.prepare(`
    SELECT c.*, i.title, i.type, i.author, i.apex_id
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

  // Copy linking
  setParent:   db.prepare('UPDATE items SET parent_item_id = ? WHERE id = ?'),
  clearParent: db.prepare('UPDATE items SET parent_item_id = NULL WHERE id = ?'),

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
