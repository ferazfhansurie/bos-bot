import assert from 'node:assert/strict';
import { digest } from './oracle.mjs';

export const BASE = '06036613d';
export const WIRE = ['invocation.offered', 'claimed', 'stream.delta', 'final.commit', 'stop.requested', 'stop.observed'];
// These are verifier adapter names, not invented HTTP routes or additional wire names.
const rows = [
  ['a02', 'two-human-native', 'source,ingress,provider,recipients'],
  ['a17', 'model-pinned-no-fallback', 'source,ingress,provider,recipients'],
  ['a17', 'explicit-steer-and-two-bot-no-loop', 'invocations,controls,provider'],
  ['a02', 'host-crash-mid-stream', 'invocations,events,recipients'],
  ['a03', 'response-loss-before-after-commit', 'operations,outbox,recipients'],
  ['a03', 'terminal-seal-delayed-submit', 'operations,admission,recipients'],
  ['a04', 'changed-envelope-window-swap', 'operations,outbox'],
  ['a04', 'expired-key-missing-key-restore-unknown', 'operations,authority'],
  ['a04', 'expiry-policy-invalid-mention-at-lock', 'operations,admission,recipients'],
  ['a04', 'draft-23h-25h-review', 'outbox,client'],
  ['a05', 'duplicate-lost-queue-dispatch-outage', 'operations,invocations,outbox'],
  ['a06', 'stream-reorder-duplicate-edit-delete', 'events,projection,cursor'],
  ['a06', 'crash-apply-checkpoint-filtered-empty', 'events,projection,cursor'],
  ['a07', 'reset-continuous-write-page-expiry', 'projection,cursor,watermarks'],
  ['a07', 'discovery-grant-removal-during-reset', 'discovery,projection,denials'],
  ['a08', 'slow-consumer-overflow-corrupt-cache', 'bounds,projection,outbox'],
  ['a08', 'sparse-read-bound-concurrent-devices', 'read_coverage,projection'],
  ['a08', 'provisional-seen-final-unseen', 'read_coverage,events'],
  ['a13', 'revoke-stream-replay-upload-job-range', 'denials,streams,objects,jobs'],
  ['a14', 'host-session-revoked-issuer-outage', 'denials,invocations,identity'],
  ['a14', 'identity-stall-15s-renewal-loss-20-concurrent', 'identity,streams,denials'],
  ['a15', 'cross-tenant-all-indirect-routes', 'route_matrix,denials,sentinels'],
  ['a16', 'invite-expiry-replay-revoke-last-owner', 'membership,admission,denials'],
  ['a19', 'guest-death-recorded-unrecorded-intent', 'storage,operations,client'],
  ['a19', 'account-switch-logout-unresolved-send', 'storage,outbox,client'],
  ['a19', 'late-old-account-callback-push-deeplink', 'storage,push,client'],
  ['a19', 'web-ios-offline-background-replay', 'operations,outbox,recipients'],
  ['a20', 'attachment-interrupt-malformed-size-type', 'objects,denials,recipients'],
  ['a20', 'attachment-quarantine-checksum-orphan', 'objects,denials'],
  ['a20', 'attachment-revoked-download-every-range', 'objects,denials'],
  ['a19', 'approval-expired-revoked-version-digest', 'approvals,denials'],
  ['a19', 'push-redacted-committed-event-dedupe', 'push,events'],
];
const invariants = [
  { canonical_finals_per_trigger: 1, private_task_count: 0 },
  { fallback_count: 0, queued_model_mutation_count: 0 },
  { implicit_steer_count: 0, automatic_bot_reply_trigger_count: 0 },
  { duplicate_finals: 0, uncertain_provider_auto_replay: 0 },
  { duplicate_messages: 0, duplicate_invocations: 0, unknown_replaced: 0 },
  { terminal_state_changes: 0, duplicate_messages: 0 },
  { changed_envelope_admitted: 0, window_swap_admitted: 0 },
  { expired_never_seen_admitted: 0, restore_unknown_sealed: 0 },
  { expired_at_lock_admitted: 0, invalid_mentions_committed: 0 },
  { reviewed_25h: true, unchanged_unknown_replay: true },
  { lost_accepted_messages: 0, duplicate_finals: 0 },
  { projection_digest_matches_manifest: true },
  { cursor_projection_atomic: true, filtered_empty_advances: true },
  { snapshot_live_gap: 0, expired_snapshot_reused: 0 },
  { removals_before_reopen: true, inaccessible_metadata_count: 0 },
  { bounded_buffer: true, unresolved_outbox_lost: 0, corrupt_cursor_advanced: 0 },
  { sparse_interval_max: 256, unseen_gap_marked_read: 0 },
  { provisional_only_marks_final_read: false },
  { post_revocation_protected_admissions: 0 },
  { unverifiable_privileged_admissions: 0 },
  { protected_publications_after_15s: 0, renewed_bearer_changed_on_response_loss: false },
  { sentinel_leaks: 0, unauthorized_invocations: 0 },
  { ownerless_workspaces: 0, invalid_invite_privilege_gains: 0 },
  { persistent_guest_payloads: 0, unrecorded_guest_intent_recreated: 0 },
  { cross_account_content: 0, automatic_original_account_resend: 0 },
  { old_account_callback_applied: 0, unauthorized_deeplink_content: 0 },
  { lost_accepted_messages: 0, duplicate_messages: 0, ordinary_background_socket_released: true },
  { unready_attachment_messages: 0, oversized_ready_objects: 0, wrong_type_ready_objects: 0 },
  { quarantine_downloads: 0, checksum_mismatch_ready: 0, expired_orphan_downloads: 0 },
  { post_removal_range_admissions: 0 },
  { invalid_approval_decisions: 0, automatic_offline_control_replay: 0 },
  { duplicate_committed_event_hints: 0, sensitive_preview_fields: 0, real_push_dispatches: 0 },
];
export const SCENARIOS = rows.map(([requirement, name, evidence], index) => ({ requirement, name, evidence: evidence.split(','), expected: invariants[index], status: 'unrun' }));
export const RACES = ['stale-host-stream', 'stale-host-final', 'approval-double-decision', 'seal-delayed-submit'];
export const FAULTS = ['normal', 'response-lost-before-commit', 'response-lost-after-commit', 'duplicate-delivery', 'reordered-stream', 'dropped-wakeup', 'crash-after-apply-before-checkpoint', 'expired-cursor-reset', 'filtered-empty-batch', 'slow-consumer-overflow'];
export const FIXTURES = {
  actors: ['fictional-alice', 'fictional-bob', 'fictional-guest', 'fictional-foreign-owner'],
  tenant_sentinel: 'fictional-other-tenant-sentinel-slice34',
  draft_ages_hours: [23, 25], guest_intent_states: ['never-submitted', 'submitted-unknown', 'accepted'],
  lifecycle: ['foreground', 'background', 'process-death', 'account-switch', 'logout', 'revoked'],
  attachment_cases: ['interrupted', 'malformed', 'over-limit', 'wrong-type', 'checksum-mismatch', 'quarantined', 'orphan-expired', 'ready', 'foreign-room', 'foreign-workspace'],
  approval_cases: ['opposite-decisions', 'wrong-actor', 'stale-version', 'changed-digest', 'wrong-effect', 'wrong-run-generation', 'expired', 'revoked'],
  indirect_routes: ['stream', 'replay', 'snapshot-page', 'history', 'discovery', 'operation-lookup', 'operation-list', 'invocation-claim', 'context', 'approval-view', 'approval-decide', 'attachment-allocate', 'attachment-complete', 'attachment-download-range', 'pending-job', 'push-payload'],
  read_cases: ['unseen-gap', '256-interval-bound', 'concurrent-device', 'provisional-only', 'late-final', 'deleted', 'own-message', 'chunk', 'edit', 'control', 'root-multiple-views'],
};
export function recoveryOperations(count = 1000) {
  assert.ok(Number.isInteger(count) && count >= 1000, 'at least 1000 independent intents');
  return Array.from({ length: count }, (_, index) => {
    const id = `fictional-recovery-${String(index).padStart(5, '0')}`;
    const envelope = { operation_id: id, actor_alias: index % 2 ? 'fictional-bob' : 'fictional-alice',
      room_alias: 'fictional-slice34-room', text: `slice34 ${index} e\u0301 \u0000 🦊\nexact`, mentions: [], attachments: [] };
    return { id, envelope, expected: { state: 'accepted', message: { text: envelope.text } }, fault: FAULTS[index % FAULTS.length] };
  });
}
export function plan(count = 1000) {
  return { version: 1, base: BASE, frozen_wire: WIRE, invocation_fields: ['invocation_id', 'attempt', 'fence_gen'],
    approval_run_state: 'waiting_for_human', attachment_namespace: ['workspace', 'room', 'attachment_id'],
    fixtures: FIXTURES, scenarios: SCENARIOS, races: RACES.flatMap(name => ['first-before-second', 'second-before-first'].map(order => ({ name, order, repetitions: 100 }))),
    recovery: recoveryOperations(count), product_status: 'unrun' };
}
export const planDigest = p => digest(p);
