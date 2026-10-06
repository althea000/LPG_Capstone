-- Converts existing incremental ProductID values (e.g. P-001) into randomized
-- P-style IDs (e.g. P-7KF29M3Q) and updates every referencing table.
--
-- IMPORTANT:
-- 1) Back up your database before running this patch.
-- 2) Run while the app is stopped to avoid concurrent writes.

START TRANSACTION;

CREATE TEMPORARY TABLE ProductIdMap (
  old_id VARCHAR(20) PRIMARY KEY,
  new_id VARCHAR(20) NOT NULL UNIQUE
);

INSERT INTO ProductIdMap (old_id, new_id)
SELECT p.ProductID,
       CONCAT('P-', UPPER(SUBSTRING(REPLACE(UUID(), '-', ''), 1, 8))) AS new_id
FROM Product p
WHERE p.ProductID REGEXP '^P-[0-9]+$';

SET FOREIGN_KEY_CHECKS = 0;

UPDATE Inventory i
JOIN ProductIdMap m ON m.old_id = i.ProductID
SET i.ProductID = m.new_id;

UPDATE OrderDetails od
JOIN ProductIdMap m ON m.old_id = od.ProductID
SET od.ProductID = m.new_id;

UPDATE RestockRecommendation rr
JOIN ProductIdMap m ON m.old_id = rr.ProductID
SET rr.ProductID = m.new_id;

UPDATE PurchaseOrderItem poi
JOIN ProductIdMap m ON m.old_id = poi.ProductID
SET poi.ProductID = m.new_id;

UPDATE TransferDetail td
JOIN ProductIdMap m ON m.old_id = td.ProductID
SET td.ProductID = m.new_id;

UPDATE Product p
JOIN ProductIdMap m ON m.old_id = p.ProductID
SET p.ProductID = m.new_id;

SET FOREIGN_KEY_CHECKS = 1;

COMMIT;
