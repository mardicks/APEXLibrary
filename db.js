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
`);

// ─── Prepared Statements ───────────────────────────────────────────────────────
const q = {
  // Items
  getAll:   db.prepare('SELECT * FROM items ORDER BY title COLLATE NOCASE ASC'),
  getById:  db.prepare('SELECT * FROM items WHERE id = ?'),
  search:   db.prepare(`
    SELECT * FROM items
    WHERE title LIKE ? OR author LIKE ? OR isbn LIKE ? OR barcode LIKE ? OR publisher LIKE ?
    ORDER BY title COLLATE NOCASE ASC
  `),
  insert:   db.prepare(`
    INSERT INTO items (title,type,author,publisher,year,description,isbn,barcode,condition,cover_url,location,notes)
    VALUES (@title,@type,@author,@publisher,@year,@description,@isbn,@barcode,@condition,@cover_url,@location,@notes)
  `),
  update:   db.prepare(`
    UPDATE items
    SET title=@title, type=@type, author=@author, publisher=@publisher, year=@year,
        description=@description, isbn=@isbn, barcode=@barcode, condition=@condition,
        cover_url=@cover_url, location=@location, notes=@notes
    WHERE id=@id
  `),
  setStatus: db.prepare('UPDATE items SET status = ? WHERE id = ?'),
  delete:    db.prepare('DELETE FROM items WHERE id = ?'),
  stats:     db.prepare(`
    SELECT
      COUNT(*)                                              AS total,
      SUM(CASE WHEN status='Available'   THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN status='Checked Out' THEN 1 ELSE 0 END) AS checked_out,
      SUM(CASE WHEN type='book'          THEN 1 ELSE 0 END) AS books,
      SUM(CASE WHEN type='magazine'      THEN 1 ELSE 0 END) AS magazines,
      SUM(CASE WHEN type='video'         THEN 1 ELSE 0 END) AS videos
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
};

module.exports = { db, q };
