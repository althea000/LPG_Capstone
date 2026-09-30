ALTER TABLE User
  ADD COLUMN WarehouseID VARCHAR(20) NULL AFTER RoleID, -- Changed INT to VARCHAR(20)
  ADD COLUMN ModuleAccess JSON NULL AFTER Status,
  ADD CONSTRAINT fk_user_warehouse FOREIGN KEY (WarehouseID) REFERENCES Warehouse(WarehouseID);