// Count source messages by role/kind and by payload classification on a
// marked migration copy. Prints counts only, never message text.
//
//   node kinds.mjs <copyDir>
import { inventory } from "../../migrate/tool.mjs";
import { payloadReason, servingView } from "../../migrate/serving.mjs";

const dir = process.argv[2];
if (!dir) throw new Error("usage: kinds.mjs <copyDir>");
const inv = await inventory(dir);
const kinds = {}, reasons = {};
for (const r of inv.records)
  if (r.type === "message" || r.type === "shared_message") {
    const m = servingView(r);
    const k = `${r.type}|${m.role}|${m.kind ?? "-"}`;
    kinds[k] = (kinds[k] ?? 0) + 1;
    const reason = payloadReason(m) ?? "text";
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
const sorted = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
console.log(JSON.stringify({ source_digest: inv.digest, role_kind: sorted(kinds), payload: sorted(reasons) }, null, 2));
