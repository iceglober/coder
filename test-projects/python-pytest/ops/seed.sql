CREATE TABLE config (key TEXT PRIMARY KEY, value INTEGER);
INSERT INTO config (key, value) VALUES ('max_order_cents', 50000);
INSERT INTO config (key, value) VALUES ('max_cart_items', 100);

CREATE TABLE orders (id TEXT PRIMARY KEY, amount_cents INTEGER, status TEXT);
INSERT INTO orders VALUES ('ord_2999', 2999, 'created');
INSERT INTO orders VALUES ('ord_14900', 14900, 'created');
INSERT INTO orders VALUES ('ord_4200', 4200, 'created');
