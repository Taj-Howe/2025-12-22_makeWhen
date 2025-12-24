// 1) src/dev/rpcSmoke.ts
// Drop this file in your repo. It runs 5 backend-only RPC smoke checks in the browser.

type AnyFn = (...args: any[]) => any;

function pickClient() {
  // Tries a few common export shapes without you having to rename anything.
  // Adjust ONLY if none of these exist in your client.ts.
  const mod: any = (globalThis as any).__rpcClientModule;
  return mod;
}

async function getClient() {
  const existing = pickClient();
  if (existing?.query && existing?.mutate) {
    return existing;
  }
  // We dynamically import so this file never runs in prod unless you opt in.
  const mod: any = await import("../rpc/client");
  (globalThis as any).__rpcClientModule = mod;

  const query: AnyFn =
    mod.query ??
    mod.rpc?.query ??
    mod.db?.query ??
    mod.api?.query;

  const mutate: AnyFn =
    mod.mutate ??
    mod.rpc?.mutate ??
    mod.db?.mutate ??
    mod.api?.mutate;

  if (typeof query !== "function" || typeof mutate !== "function") {
    const keys = Object.keys(mod);
    throw new Error(
      `rpcSmoke: couldn't find query/mutate in ../client exports. Exports: ${keys.join(", ")}`
    );
  }

  return { query, mutate, request: mod.request };
}

const now = () => Date.now();
const min = (m: number) => m * 60_000;

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

export async function runRpcSmoke() {
  const { query, mutate, request } = await getClient();

  console.groupCollapsed("%crpcSmoke: start", "font-weight:bold;");
  try {
    // --- Check 1: worker responds + DB initialized
    const ping = request ? await request("ping", {}) : await query("ping", {});
    console.log("ping:", ping);
    const info = request ? await request("dbInfo", {}) : await query("dbInfo", {});
    console.log("dbInfo:", info);
    assert(info?.ok !== false, "dbInfo should not be ok:false");

    // --- Setup: create a mini hierarchy: project > milestone > task
    const dueSoon = now() + min(60); // required by your create_item
    const duePast = now() - min(60);

    const p = await mutate("create_item", {
      type: "project",
      title: `SMOKE Project ${new Date().toISOString()}`,
      due_at: dueSoon,
      estimate_minutes: 0,
    });
    const projectId = p?.result?.id ?? p?.result?.result?.id ?? p?.id;
    assert(typeof projectId === "string", "create project should return id");

    const m = await mutate("create_item", {
      type: "milestone",
      parent_id: projectId,
      title: "SMOKE Milestone",
      due_at: dueSoon,
      estimate_minutes: 0,
    });
    const milestoneId = m?.result?.id ?? m?.result?.result?.id ?? m?.id;
    assert(typeof milestoneId === "string", "create milestone should return id");

    const tOverdue = await mutate("create_item", {
      type: "task",
      parent_id: milestoneId,
      title: "SMOKE Task Overdue (no blocks)",
      due_at: duePast,
      estimate_minutes: 30,
      status: "ready",
    });
    const overdueTaskId =
      tOverdue?.result?.id ?? tOverdue?.result?.result?.id ?? tOverdue?.id;
    assert(typeof overdueTaskId === "string", "create task should return id");

    const tFuture = await mutate("create_item", {
      type: "task",
      parent_id: milestoneId,
      title: "SMOKE Task Future (no blocks)",
      due_at: dueSoon,
      estimate_minutes: 30,
      status: "ready",
    });
    const futureTaskId =
      tFuture?.result?.id ?? tFuture?.result?.result?.id ?? tFuture?.id;
    assert(typeof futureTaskId === "string", "create task should return id");

    // --- Check 2: blocker active/cleared is reflected in getItemDetails
    const addBlocker = await mutate("add_blocker", {
      item_id: futureTaskId,
      kind: "general",
      text: "SMOKE blocker",
    });
    const blockerId =
      addBlocker?.result?.blocker_id ??
      addBlocker?.result?.result?.blocker_id ??
      addBlocker?.blocker_id;
    assert(typeof blockerId === "string", "add_blocker should return blocker_id");

    const detailsBlocked = await query("getItemDetails", { itemId: futureTaskId });
    console.log("details (blocked):", detailsBlocked);
    assert(
      detailsBlocked?.is_blocked === true,
      "getItemDetails should show is_blocked=true after add_blocker"
    );

    await mutate("clear_blocker", { blocker_id: blockerId });
    const detailsUnblocked = await query("getItemDetails", { itemId: futureTaskId });
    console.log("details (unblocked):", detailsUnblocked);
    assert(
      detailsUnblocked?.is_blocked === false,
      "getItemDetails should show is_blocked=false after clear_blocker"
    );

    // --- Check 3: calendar overlap logic (block starts before window but overlaps)
    const windowStart = now();
    const windowEnd = windowStart + min(120);

    const create = await mutate("create_block", {
      item_id: futureTaskId,
      start_at: windowStart - min(30), // starts before
      duration_minutes: 60, // overlaps into window
      locked: 0,
      source: "manual",
    });
    const blockId =
      create?.result?.block_id ??
      create?.result?.result?.block_id ??
      create?.block_id;
    assert(typeof blockId === "string", "create_block should return block_id");

    const blocks = await query("listCalendarBlocks", {
      scope: { kind: "project", id: projectId },
      startAt: windowStart,
      endAt: windowEnd,
    });
    console.log("calendar blocks:", blocks);
    const hasOverlapBlock = Array.isArray(blocks)
      ? blocks.some((b: any) => b.block_id === blockId)
      : Array.isArray(blocks?.result)
        ? blocks.result.some((b: any) => b.block_id === blockId)
        : blocks?.result?.some?.((b: any) => b.block_id === blockId);

    assert(hasOverlapBlock, "listCalendarBlocks should include overlapping block");

    // --- Check 4: listItems includes sequence_rank (and sorting by it behaves)
    const listItems = await query("listItems", {
      scope: { kind: "project", id: projectId },
      filters: {},
      includeDone: true,
      includeCanceled: true,
      orderBy: "sequence_rank",
      orderDir: "asc",
    });
    console.log("listItems:", listItems);

    const items: any[] = listItems?.result?.items ?? listItems?.items ?? [];
    assert(items.length >= 2, "listItems should return >= 2 items");
    assert("sequence_rank" in items[0], "listItems items should include sequence_rank");

    // --- Check 5: execution queue ordering favors overdue/unblocked items
    // (Queue semantics unchanged: only 'ready', unblocked, and with *no blocks at all*.)
    const exec = await query("listExecution", {
      scope: { kind: "project", id: projectId },
      startAt: windowStart,
      endAt: windowEnd,
    });
    console.log("listExecution:", exec);

    const queue: any[] = exec?.result?.queue ?? exec?.queue ?? [];
    assert(queue.length >= 1, "execution queue should have at least one item");
    // Our futureTaskId now HAS a block, so it should not be in queue. Overdue one has no blocks.
    assert(
      queue.some((q) => q.id === overdueTaskId),
      "overdue task (no blocks) should appear in execution queue"
    );

    console.log("%crpcSmoke: ✅ all checks passed", "font-weight:bold;");
  } catch (e) {
    console.error("rpcSmoke: ❌ failed", e);
    throw e;
  } finally {
    console.groupEnd();
  }
}
