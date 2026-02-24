export type JsonObject = Record<string, unknown>;

export type OpValidationFailure = {
  ok: false;
  code: "validation_failed" | "unknown_op";
  message: string;
};

export type OpValidationResult = { ok: true } | OpValidationFailure;

type OpPayloadValidator = (payload: JsonObject) => OpValidationResult;

const hasString = (payload: JsonObject, key: string) => {
  return typeof payload[key] === "string" && payload[key]!.toString().trim().length > 0;
};

const hasNumber = (payload: JsonObject, key: string) => {
  const value = Number(payload[key]);
  return Number.isFinite(value);
};

const hasStringArray = (payload: JsonObject, key: string) => {
  const value = payload[key];
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
};

const ok = (): OpValidationResult => ({ ok: true });

const fail = (message: string): OpValidationFailure => ({
  ok: false,
  code: "validation_failed",
  message,
});

const requireAny = (
  payload: JsonObject,
  keys: string[],
  message: string
): OpValidationResult => {
  if (keys.some((key) => hasString(payload, key))) {
    return ok();
  }
  return fail(message);
};

const registerOpValidators = (
  entries: Array<[string, OpPayloadValidator]>
): ReadonlyMap<string, OpPayloadValidator> => {
  const map = new Map<string, OpPayloadValidator>();
  for (const [opName, validator] of entries) {
    map.set(opName, validator);
  }
  return map;
};

const itemIdValidator: OpPayloadValidator = (payload) => {
  return requireAny(payload, ["item_id", "id"], "payload requires item_id or id.");
};

const blockIdValidator: OpPayloadValidator = (payload) => {
  if (hasString(payload, "block_id")) {
    return ok();
  }
  return fail("payload requires block_id.");
};

const opValidatorEntries: Array<[string, OpPayloadValidator]> = [
  ["create_item", (payload) => {
    if (hasString(payload, "id") && hasString(payload, "project_id") && hasString(payload, "type")) {
      return ok();
    }
    return fail("create_item payload requires id, project_id, and type.");
  }],
  ["update_item_fields", itemIdValidator],
  ["set_status", (payload) => {
    if (hasString(payload, "item_id") && hasString(payload, "status")) {
      return ok();
    }
    return fail("set_status payload requires item_id and status.");
  }],
  ["scheduled_block.create", (payload) => {
    if (hasString(payload, "block_id") && hasString(payload, "item_id") && hasNumber(payload, "start_at")) {
      return ok();
    }
    return fail("scheduled_block.create payload requires block_id, item_id, and start_at.");
  }],
  ["scheduled_block.update", blockIdValidator],
  ["scheduled_block.delete", blockIdValidator],
  ["create_block", (payload) => {
    if (hasString(payload, "block_id") && hasString(payload, "item_id") && hasNumber(payload, "start_at")) {
      return ok();
    }
    return fail("create_block payload requires block_id, item_id, and start_at.");
  }],
  ["move_block", blockIdValidator],
  ["resize_block", blockIdValidator],
  ["delete_block", blockIdValidator],
  ["item.archive", itemIdValidator],
  ["items.archive_many", (payload) => {
    if (hasStringArray(payload, "item_ids") && (payload.item_ids as unknown[]).length > 0) {
      return ok();
    }
    return fail("items.archive_many payload requires item_ids as a non-empty string array.");
  }],
  ["item.restore", itemIdValidator],
  ["items.restore_many", (payload) => {
    if (hasStringArray(payload, "item_ids") && (payload.item_ids as unknown[]).length > 0) {
      return ok();
    }
    return fail("items.restore_many payload requires item_ids as a non-empty string array.");
  }],
  ["delete_item", itemIdValidator],
  ["items.delete_many", (payload) => {
    if (hasStringArray(payload, "item_ids") && (payload.item_ids as unknown[]).length > 0) {
      return ok();
    }
    return fail("items.delete_many payload requires item_ids as a non-empty string array.");
  }],
  ["reorder_item", itemIdValidator],
  ["move_item", itemIdValidator],
  ["add_time_entry", (payload) => {
    return requireAny(payload, ["item_id", "entry_id"], "add_time_entry payload requires item_id or entry_id.");
  }],
  ["start_timer", (payload) => {
    if (hasString(payload, "item_id")) {
      return ok();
    }
    return fail("start_timer payload requires item_id.");
  }],
  ["stop_timer", (payload) => {
    return requireAny(payload, ["entry_id", "item_id"], "stop_timer payload requires entry_id or item_id.");
  }],
  ["dependency.create", (payload) => {
    if (hasString(payload, "item_id") && hasString(payload, "depends_on_id")) {
      return ok();
    }
    return fail("dependency.create payload requires item_id and depends_on_id.");
  }],
  ["dependency.update", (payload) => {
    return requireAny(payload, ["dependency_id", "id"], "dependency.update payload requires dependency_id or id.");
  }],
  ["dependency.delete", (payload) => {
    return requireAny(payload, ["dependency_id", "id"], "dependency.delete payload requires dependency_id or id.");
  }],
  ["add_dependency", (payload) => {
    if (hasString(payload, "item_id") && hasString(payload, "depends_on_id")) {
      return ok();
    }
    return fail("add_dependency payload requires item_id and depends_on_id.");
  }],
  ["remove_dependency", (payload) => {
    if (hasString(payload, "item_id") && hasString(payload, "depends_on_id")) {
      return ok();
    }
    return fail("remove_dependency payload requires item_id and depends_on_id.");
  }],
  ["add_blocker", (payload) => {
    if (hasString(payload, "item_id") && (hasString(payload, "blocker") || hasString(payload, "text"))) {
      return ok();
    }
    return fail("add_blocker payload requires item_id and blocker text.");
  }],
  ["clear_blocker", (payload) => {
    if (hasString(payload, "blocker_id")) {
      return ok();
    }
    return fail("clear_blocker payload requires blocker_id.");
  }],
  ["set_item_tags", (payload) => {
    if (hasString(payload, "item_id") && Array.isArray(payload.tags)) {
      return ok();
    }
    return fail("set_item_tags payload requires item_id and tags array.");
  }],
  ["user.create", (payload) => {
    if (hasString(payload, "display_name") || hasString(payload, "user_id")) {
      return ok();
    }
    return fail("user.create payload requires display_name or user_id.");
  }],
  ["user.update", (payload) => {
    if (hasString(payload, "user_id")) {
      return ok();
    }
    return fail("user.update payload requires user_id.");
  }],
  ["team.member.set_role", (payload) => {
    if (hasString(payload, "user_id") && hasString(payload, "role")) {
      return ok();
    }
    return fail("team.member.set_role payload requires user_id and role.");
  }],
  ["team.member.add", (payload) => {
    if (hasString(payload, "user_id")) {
      return ok();
    }
    return fail("team.member.add payload requires user_id.");
  }],
  ["item.set_assignee", itemIdValidator],
  ["set_item_assignees", (payload) => {
    if (hasString(payload, "item_id") && Array.isArray(payload.assignee_ids)) {
      return ok();
    }
    return fail("set_item_assignees payload requires item_id and assignee_ids array.");
  }],
];

export const OP_VALIDATOR_REGISTRY = registerOpValidators(opValidatorEntries);

export const getAllowedSyncOpNames = (): string[] => {
  return [...OP_VALIDATOR_REGISTRY.keys()];
};

export const validateRegisteredOpPayload = (
  opName: string,
  payload: JsonObject
): OpValidationResult => {
  const validator = OP_VALIDATOR_REGISTRY.get(opName);
  if (!validator) {
    return {
      ok: false,
      code: "unknown_op",
      message: `Unsupported op_name: ${opName}.`,
    };
  }
  return validator(payload);
};
