import assert from "node:assert/strict";
import test from "node:test";
import { splitTargetInput } from "../src/target-input.ts";

test("target input accepts comma and new-line separators together", () => {
  assert.deepEqual(splitTargetInput("group_one, group_two\ngroup_three"), ["group_one", "group_two", "group_three"]);
});

test("target input trims whitespace and ignores empty entries", () => {
  assert.deepEqual(splitTargetInput("  @base_one,\n\n @base_two  , "), ["@base_one", "@base_two"]);
});

test("target input also normalizes arrays sent by older clients", () => {
  assert.deepEqual(splitTargetInput(["group_one, group_two", "group_three"]), ["group_one", "group_two", "group_three"]);
});
