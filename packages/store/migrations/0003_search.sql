-- v2 F2a: search over the message mirror.
--
-- A contentless trigram FTS5 index beside inbound_messages. Contentless
-- (content='') means the index holds no second copy of any message: hits
-- are joined back to the mirror. contentless_delete=1 lets a row leave the
-- index by rowid, and secure-delete overwrites its bytes when it does, so
-- an unsent message is scrubbed, not just unlinked.
--
-- remove_diacritics 1 folds "Café" to "cafe"; the trigram tokenizer folds
-- case. A MATCH term under three characters returns nothing WITHOUT an
-- error, so the store never sends one: short terms go through instr().
CREATE VIRTUAL TABLE message_fts USING fts5(body, tokenize='trigram remove_diacritics 1', content='', contentless_delete=1);
INSERT INTO message_fts(message_fts, rank) VALUES('secure-delete', 1);

-- The FTS rowid is search_doc.doc_id, never inbound_messages' implicit
-- rowid, which VACUUM is free to renumber.
CREATE TABLE search_doc (doc_id INTEGER PRIMARY KEY, guid TEXT NOT NULL UNIQUE);

-- The mirror's first indexes (C-8 kept it index-free until search needed
-- them): newest-first filter-only queries, in: by chat, and the backfill's
-- walk in chat.db ROWID order.
CREATE INDEX inbound_sent ON inbound_messages(sent_at, guid);
CREATE INDEX inbound_chat_sent ON inbound_messages(chat_guid, sent_at);
CREATE INDEX inbound_rowid_src ON inbound_messages(rowid_src);
