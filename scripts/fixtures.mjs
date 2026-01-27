export const FIXTURE_IDS = {
  project: "proj-1",
  milestone: "ms-1",
  taskMain: "task-1",
  subtask: "sub-1",
  taskUngrouped: "task-ungrouped",
  taskGlobal: "task-global",
  taskBlocked: "task-blocked",
  taskDone: "task-done",
  taskArchived: "task-archived",
  assignee: "user-1",
};

export const FIXTURE_UUIDS = {
  project: "00000000-0000-0000-0000-000000000001",
  milestone: "00000000-0000-0000-0000-000000000002",
  taskMain: "00000000-0000-0000-0000-000000000003",
  subtask: "00000000-0000-0000-0000-000000000004",
  taskUngrouped: "00000000-0000-0000-0000-000000000005",
  taskGlobal: "00000000-0000-0000-0000-000000000006",
  taskBlocked: "00000000-0000-0000-0000-000000000007",
  taskDone: "00000000-0000-0000-0000-000000000008",
  taskArchived: "00000000-0000-0000-0000-000000000009",
  assignee: "00000000-0000-0000-0000-000000000010",
  owner: "00000000-0000-0000-0000-000000000011",
};

export const FIXTURE_BLOCK_IDS = {
  block1: "block-1",
  block2: "block-2",
  block3: "block-3",
};

export const FIXTURE_BLOCK_UUIDS = {
  block1: "00000000-0000-0000-0000-000000000012",
  block2: "00000000-0000-0000-0000-000000000013",
  block3: "00000000-0000-0000-0000-000000000014",
};

export const FIXTURE_OTHER_IDS = {
  blocker1: "blocker-1",
  time1: "time-1",
};

export const FIXTURE_OTHER_UUIDS = {
  blocker1: "00000000-0000-0000-0000-000000000015",
  time1: "00000000-0000-0000-0000-000000000016",
};

export const FIXTURE_SERVER_ID_MAP = new Map([
  ...Object.entries(FIXTURE_UUIDS).map(([key, value]) => [value, FIXTURE_IDS[key]]),
  ...Object.entries(FIXTURE_BLOCK_UUIDS).map(([key, value]) => [
    value,
    FIXTURE_BLOCK_IDS[key],
  ]),
  ...Object.entries(FIXTURE_OTHER_UUIDS).map(([key, value]) => [
    value,
    FIXTURE_OTHER_IDS[key],
  ]),
]);

const base = 1700000000000;
const hour = 60 * 60 * 1000;
const day = 24 * hour;

export const seedFixtures = (db) => {
  const usersPayload = JSON.stringify([
    {
      user_id: FIXTURE_IDS.assignee,
      display_name: "Alex",
      avatar_url: null,
    },
  ]);

  db.exec(
    "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;",
    {
      bind: ["users_registry", usersPayload],
    }
  );

  const insertItem = (item) => {
    db.exec(
      `INSERT INTO items (
        id, type, title, parent_id, status, priority, due_at,
        estimate_mode, estimate_minutes, health, health_mode, notes,
        created_at, updated_at, sort_order, completed_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      { bind: item }
    );
  };

  insertItem([
    FIXTURE_IDS.project,
    "project",
    "Sample Project",
    null,
    "backlog",
    1,
    base + day * 7,
    "rollup",
    0,
    "unknown",
    "auto",
    null,
    base - day * 10,
    base - day * 10,
    1,
    null,
    null,
  ]);

  insertItem([
    FIXTURE_IDS.milestone,
    "milestone",
    "Milestone A",
    FIXTURE_IDS.project,
    "ready",
    2,
    base + day * 4,
    "rollup",
    0,
    "unknown",
    "auto",
    "Kickoff milestone",
    base - day * 9,
    base - day * 8,
    1,
    null,
    null,
  ]);

  insertItem([
    FIXTURE_IDS.taskMain,
    "task",
    "Main Task",
    FIXTURE_IDS.milestone,
    "ready",
    3,
    base + day * 2,
    "manual",
    180,
    "unknown",
    "auto",
    "Primary work item",
    base - day * 8,
    base - day * 2,
    1,
    null,
    null,
  ]);

  insertItem([
    FIXTURE_IDS.subtask,
    "task",
    "Subtask A",
    FIXTURE_IDS.taskMain,
    "backlog",
    2,
    null,
    "manual",
    45,
    "unknown",
    "auto",
    null,
    base - day * 7,
    base - day * 6,
    1,
    null,
    null,
  ]);

  insertItem([
    FIXTURE_IDS.taskUngrouped,
    "task",
    "Ungrouped Task",
    FIXTURE_IDS.project,
    "ready",
    1,
    base + day * 3,
    "manual",
    90,
    "unknown",
    "auto",
    null,
    base - day * 5,
    base - day * 4,
    2,
    null,
    null,
  ]);

  insertItem([
    FIXTURE_IDS.taskGlobal,
    "task",
    "Global Task",
    null,
    "ready",
    1,
    base + day,
    "manual",
    25,
    "unknown",
    "auto",
    null,
    base - day * 5,
    base - day * 3,
    1,
    null,
    null,
  ]);

  insertItem([
    FIXTURE_IDS.taskBlocked,
    "task",
    "Blocked Task",
    FIXTURE_IDS.project,
    "ready",
    4,
    base + day * 5,
    "manual",
    60,
    "unknown",
    "auto",
    "Waiting on review",
    base - day * 6,
    base - day * 1,
    3,
    null,
    null,
  ]);

  insertItem([
    FIXTURE_IDS.taskDone,
    "task",
    "Completed Task",
    FIXTURE_IDS.milestone,
    "done",
    2,
    base - day,
    "manual",
    30,
    "unknown",
    "auto",
    null,
    base - day * 3,
    base - day * 1,
    3,
    base - day,
    null,
  ]);

  insertItem([
    FIXTURE_IDS.taskArchived,
    "task",
    "Archived Task",
    FIXTURE_IDS.project,
    "done",
    1,
    base - day * 2,
    "manual",
    15,
    "unknown",
    "auto",
    null,
    base - day * 4,
    base - day * 2,
    4,
    base - day * 2,
    base - day,
  ]);

  db.exec(
    "INSERT INTO item_assignees (item_id, assignee_id) VALUES (?, ?);",
    { bind: [FIXTURE_IDS.taskMain, FIXTURE_IDS.assignee] }
  );
  db.exec(
    "INSERT INTO item_assignees (item_id, assignee_id) VALUES (?, ?);",
    { bind: [FIXTURE_IDS.taskBlocked, FIXTURE_IDS.assignee] }
  );

  db.exec(
    "INSERT INTO scheduled_blocks (block_id, item_id, start_at, duration_minutes, locked, source) VALUES (?, ?, ?, ?, ?, ?);",
    {
      bind: [
        FIXTURE_BLOCK_IDS.block1,
        FIXTURE_IDS.taskMain,
        base + hour * 9,
        60,
        0,
        "user",
      ],
    }
  );
  db.exec(
    "INSERT INTO scheduled_blocks (block_id, item_id, start_at, duration_minutes, locked, source) VALUES (?, ?, ?, ?, ?, ?);",
    {
      bind: [
        FIXTURE_BLOCK_IDS.block2,
        FIXTURE_IDS.taskMain,
        base + hour * 13,
        90,
        0,
        "user",
      ],
    }
  );
  db.exec(
    "INSERT INTO scheduled_blocks (block_id, item_id, start_at, duration_minutes, locked, source) VALUES (?, ?, ?, ?, ?, ?);",
    {
      bind: [
        FIXTURE_BLOCK_IDS.block3,
        FIXTURE_IDS.taskBlocked,
        base + day + hour * 10,
        30,
        0,
        "user",
      ],
    }
  );

  db.exec(
    "INSERT INTO dependencies (item_id, depends_on_id, type, lag_minutes) VALUES (?, ?, ?, ?);",
    {
      bind: [FIXTURE_IDS.taskBlocked, FIXTURE_IDS.taskMain, "FS", 30],
    }
  );
  db.exec(
    "INSERT INTO dependencies (item_id, depends_on_id, type, lag_minutes) VALUES (?, ?, ?, ?);",
    {
      bind: [FIXTURE_IDS.subtask, FIXTURE_IDS.taskMain, "SS", 0],
    }
  );

  db.exec(
    "INSERT INTO blockers (blocker_id, item_id, kind, text, created_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?);",
    {
      bind: [
        FIXTURE_OTHER_IDS.blocker1,
        FIXTURE_IDS.taskBlocked,
        "general",
        "Awaiting approval",
        base - hour * 5,
        null,
      ],
    }
  );

  db.exec(
    "INSERT INTO time_entries (entry_id, item_id, start_at, end_at, duration_minutes, note, source) VALUES (?, ?, ?, ?, ?, ?, ?);",
    {
      bind: [
        FIXTURE_OTHER_IDS.time1,
        FIXTURE_IDS.taskMain,
        base + hour * 9,
        base + hour * 9 + 30 * 60000,
        30,
        "focus session",
        "manual",
      ],
    }
  );
};

export const fixtureWindow = {
  start: base - day,
  end: base + day * 7,
};

const iso = (ms) => new Date(ms).toISOString();

export const seedServerFixtures = async (db) => {
  await db
    .insertInto("users")
    .values([
      {
        id: FIXTURE_UUIDS.owner,
        email: "owner@example.com",
        name: "Owner",
        image: null,
        created_at: iso(base - day * 20),
      },
      {
        id: FIXTURE_UUIDS.assignee,
        email: "alex@example.com",
        name: "Alex",
        image: null,
        created_at: iso(base - day * 18),
      },
    ])
    .execute();

  await db
    .insertInto("projects")
    .values({
      id: FIXTURE_UUIDS.project,
      title: "Sample Project",
      owner_user_id: FIXTURE_UUIDS.owner,
      created_at: iso(base - day * 12),
      updated_at: iso(base - day * 10),
    })
    .execute();

  await db
    .insertInto("project_members")
    .values([
      {
        project_id: FIXTURE_UUIDS.project,
        user_id: FIXTURE_UUIDS.owner,
        role: "owner",
      },
      {
        project_id: FIXTURE_UUIDS.project,
        user_id: FIXTURE_UUIDS.assignee,
        role: "editor",
      },
    ])
    .execute();

  await db
    .insertInto("items")
    .values([
      {
        id: FIXTURE_UUIDS.project,
        project_id: FIXTURE_UUIDS.project,
        parent_id: null,
        type: "project",
        title: "Sample Project",
        status: "backlog",
        priority: 1,
        due_at: iso(base + day * 7),
        estimate_mode: "rollup",
        estimate_minutes: 0,
        notes: null,
        created_at: iso(base - day * 10),
        updated_at: iso(base - day * 10),
        sequence_rank: 1,
        completed_at: null,
        archived_at: null,
        assignee_user_id: null,
        health: "unknown",
      },
      {
        id: FIXTURE_UUIDS.milestone,
        project_id: FIXTURE_UUIDS.project,
        parent_id: FIXTURE_UUIDS.project,
        type: "milestone",
        title: "Milestone A",
        status: "ready",
        priority: 2,
        due_at: iso(base + day * 4),
        estimate_mode: "rollup",
        estimate_minutes: 0,
        notes: "Kickoff milestone",
        created_at: iso(base - day * 9),
        updated_at: iso(base - day * 8),
        sequence_rank: 1,
        completed_at: null,
        archived_at: null,
        assignee_user_id: null,
        health: "unknown",
      },
      {
        id: FIXTURE_UUIDS.taskMain,
        project_id: FIXTURE_UUIDS.project,
        parent_id: FIXTURE_UUIDS.milestone,
        type: "task",
        title: "Main Task",
        status: "ready",
        priority: 3,
        due_at: iso(base + day * 2),
        estimate_mode: "manual",
        estimate_minutes: 180,
        notes: "Primary work item",
        created_at: iso(base - day * 8),
        updated_at: iso(base - day * 2),
        sequence_rank: 1,
        completed_at: null,
        archived_at: null,
        assignee_user_id: FIXTURE_UUIDS.assignee,
        health: "unknown",
      },
      {
        id: FIXTURE_UUIDS.subtask,
        project_id: FIXTURE_UUIDS.project,
        parent_id: FIXTURE_UUIDS.taskMain,
        type: "task",
        title: "Subtask A",
        status: "backlog",
        priority: 2,
        due_at: null,
        estimate_mode: "manual",
        estimate_minutes: 45,
        notes: null,
        created_at: iso(base - day * 7),
        updated_at: iso(base - day * 6),
        sequence_rank: 1,
        completed_at: null,
        archived_at: null,
        assignee_user_id: null,
        health: "unknown",
      },
      {
        id: FIXTURE_UUIDS.taskUngrouped,
        project_id: FIXTURE_UUIDS.project,
        parent_id: FIXTURE_UUIDS.project,
        type: "task",
        title: "Ungrouped Task",
        status: "ready",
        priority: 1,
        due_at: iso(base + day * 3),
        estimate_mode: "manual",
        estimate_minutes: 90,
        notes: null,
        created_at: iso(base - day * 5),
        updated_at: iso(base - day * 4),
        sequence_rank: 2,
        completed_at: null,
        archived_at: null,
        assignee_user_id: null,
        health: "unknown",
      },
      {
        id: FIXTURE_UUIDS.taskGlobal,
        project_id: FIXTURE_UUIDS.project,
        parent_id: null,
        type: "task",
        title: "Global Task",
        status: "ready",
        priority: 1,
        due_at: iso(base + day),
        estimate_mode: "manual",
        estimate_minutes: 25,
        notes: null,
        created_at: iso(base - day * 5),
        updated_at: iso(base - day * 3),
        sequence_rank: 1,
        completed_at: null,
        archived_at: null,
        assignee_user_id: null,
        health: "unknown",
      },
      {
        id: FIXTURE_UUIDS.taskBlocked,
        project_id: FIXTURE_UUIDS.project,
        parent_id: FIXTURE_UUIDS.project,
        type: "task",
        title: "Blocked Task",
        status: "ready",
        priority: 4,
        due_at: iso(base + day * 5),
        estimate_mode: "manual",
        estimate_minutes: 60,
        notes: "Waiting on review",
        created_at: iso(base - day * 6),
        updated_at: iso(base - day),
        sequence_rank: 3,
        completed_at: null,
        archived_at: null,
        assignee_user_id: FIXTURE_UUIDS.assignee,
        health: "unknown",
      },
      {
        id: FIXTURE_UUIDS.taskDone,
        project_id: FIXTURE_UUIDS.project,
        parent_id: FIXTURE_UUIDS.milestone,
        type: "task",
        title: "Completed Task",
        status: "done",
        priority: 2,
        due_at: iso(base - day),
        estimate_mode: "manual",
        estimate_minutes: 30,
        notes: null,
        created_at: iso(base - day * 3),
        updated_at: iso(base - day),
        sequence_rank: 3,
        completed_at: iso(base - day),
        archived_at: null,
        assignee_user_id: null,
        health: "unknown",
      },
      {
        id: FIXTURE_UUIDS.taskArchived,
        project_id: FIXTURE_UUIDS.project,
        parent_id: FIXTURE_UUIDS.milestone,
        type: "task",
        title: "Archived Task",
        status: "done",
        priority: 1,
        due_at: iso(base - day * 2),
        estimate_mode: "manual",
        estimate_minutes: 15,
        notes: null,
        created_at: iso(base - day * 4),
        updated_at: iso(base - day * 2),
        sequence_rank: 4,
        completed_at: iso(base - day * 2),
        archived_at: iso(base - day),
        assignee_user_id: null,
        health: "unknown",
      },
    ])
    .execute();

  await db
    .insertInto("scheduled_blocks")
    .values([
      {
        id: FIXTURE_BLOCK_UUIDS.block1,
        item_id: FIXTURE_UUIDS.taskMain,
        start_at: iso(base + hour * 9),
        duration_minutes: 60,
        created_at: iso(base - day * 2),
        updated_at: iso(base - day * 2),
      },
      {
        id: FIXTURE_BLOCK_UUIDS.block2,
        item_id: FIXTURE_UUIDS.taskMain,
        start_at: iso(base + hour * 13),
        duration_minutes: 90,
        created_at: iso(base - day * 2),
        updated_at: iso(base - day * 2),
      },
      {
        id: FIXTURE_BLOCK_UUIDS.block3,
        item_id: FIXTURE_UUIDS.taskBlocked,
        start_at: iso(base + day + hour * 10),
        duration_minutes: 30,
        created_at: iso(base - day * 2),
        updated_at: iso(base - day * 2),
      },
    ])
    .execute();

  await db
    .insertInto("dependencies")
    .values([
      {
        id: FIXTURE_BLOCK_UUIDS.block1,
        item_id: FIXTURE_UUIDS.taskBlocked,
        depends_on_id: FIXTURE_UUIDS.taskMain,
        type: "FS",
        lag_minutes: 30,
        created_at: iso(base - day * 2),
      },
      {
        id: FIXTURE_BLOCK_UUIDS.block2,
        item_id: FIXTURE_UUIDS.subtask,
        depends_on_id: FIXTURE_UUIDS.taskMain,
        type: "SS",
        lag_minutes: 0,
        created_at: iso(base - day * 2),
      },
    ])
    .execute();

  await db
    .insertInto("blockers")
    .values({
      id: FIXTURE_OTHER_UUIDS.blocker1,
      item_id: FIXTURE_UUIDS.taskBlocked,
      kind: "general",
      reason: "Awaiting approval",
      created_at: iso(base - hour * 5),
      cleared_at: null,
    })
    .execute();

  await db
    .insertInto("time_entries")
    .values({
      id: FIXTURE_OTHER_UUIDS.time1,
      item_id: FIXTURE_UUIDS.taskMain,
      start_at: iso(base + hour * 9),
      end_at: iso(base + hour * 9 + 30 * 60000),
      duration_minutes: 30,
      created_at: iso(base + hour * 9),
    })
    .execute();
};
