const pool = require("../config/db");

async function nextUserActivityId(conn, prefix = "UA", pad = 3) {
  const [rows] = await conn.query(
    `SELECT UserActivityID AS id
     FROM UserActivity
     WHERE UserActivityID LIKE :pattern
     ORDER BY UserActivityID DESC
     LIMIT 500`,
    { pattern: `${prefix}-%` }
  );

  let max = 0;
  for (const row of rows) {
    const match = String(row.id || "").match(new RegExp(`^${prefix}-(\\d+)$`));
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > max) max = value;
  }

  return `${prefix}-${String(max + 1).padStart(pad, "0")}`;
}

async function logUserActivity(
  {
    userId,
    activityType,
    module,
    recordId = null,
    description = null,
  },
  conn = pool
) {
  if (!userId || !activityType || !module) return;

  const [recentRows] = await conn.query(
    `SELECT UserActivityID
     FROM UserActivity
     WHERE UserID = :userId
       AND ActivityType = :activityType
       AND Module = :module
       AND COALESCE(RecordID, '') = COALESCE(:recordId, '')
       AND COALESCE(Description, '') = COALESCE(:description, '')
       AND ActivityDate >= DATE_SUB(NOW(), INTERVAL 3 SECOND)
     LIMIT 1`,
    { userId, activityType, module, recordId, description }
  );

  if (recentRows[0]) return;

  const userActivityId = await nextUserActivityId(conn);
  await conn.query(
    `INSERT INTO UserActivity (UserActivityID, UserID, ActivityType, Module, RecordID, Description)
     VALUES (:userActivityId, :userId, :activityType, :module, :recordId, :description)`,
    { userActivityId, userId, activityType, module, recordId, description }
  );
}

module.exports = {
  logUserActivity,
};

