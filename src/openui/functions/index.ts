import { dataFunctions } from "./data";
import { dateFunctions } from "./dates";
import { listFunctions } from "./lists";
import { numberFunctions } from "./numbers";
import { textFunctions } from "./text";

/**
 * Every function vendored from open-intelligent-ui. Pure except @Random,
 * @Pick, @Shuffle and @Now; bad arguments make a call evaluate to null.
 */
export const allFunctions = [...listFunctions, ...numberFunctions, ...textFunctions, ...dateFunctions, ...dataFunctions];

// What bots get: the dashboard set. Every name costs prompt bytes on every
// turn the skill loads, so a function earns its place by showing up in answers.
const BOS = new Set([
  "GroupBy", "Top", "Bucket", "Change",
  "Format", "Percent", "FormatDate", "Today",
]);
export const functions = allFunctions.filter((f) => BOS.has(f.name));
