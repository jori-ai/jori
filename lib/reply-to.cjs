"use strict";
// reply-to — send a dispatched job's answer back to the conversation that asked.
//
// A job started on someone's behalf (`jori tasks run <job> --task … --reply-to
// <conversation>`, or `jori dispatch … --reply-to …`) runs in an ops session
// that cannot see who asked. Its chat reply used to land in the conversation
// of the role that owns the job (migration 0180 files a row by its sender), so
// car prices asked for in the chief of staff's thread arrived in the travel
// manager's (2026-11-18). The owner: "car price request should go back to the
// channel that requested them". `--reply-to` appends one fixed line to the
// task; the job passes the id to `jori-send-curl --conversation`, which writes
// it on the row, so the database files it where the user asked.

// Conversation ids (system/migrations/0180_team_conversations.sql): a role's
// own thread or a group.
const ROLE_CONV = /^role:[a-z0-9][a-z0-9-]{0,63}$/; // lang-regex-ok: machine id syntax
const GROUP_CONV = /^group:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // lang-regex-ok: machine id syntax

function validConversation(id) {
  const s = String(id || "").trim();
  return ROLE_CONV.test(s) || GROUP_CONV.test(s);
}

/** The line appended to a dispatched task. Throws on a malformed id. */
function replyToLine(id) {
  const s = String(id || "").trim();
  if (!validConversation(s)) throw new Error(`--reply-to: "${s}" is not a conversation id (role:<id> or group:<uuid>)`);
  return `Reply to: conversation ${s}. Send this request's chat reply there: pass \`--conversation ${s}\` to every jori-send-curl chat message about it.`;
}

/** Task text with the reply-to line added (no id: unchanged). */
function withReplyTo(task, id) {
  if (!id) return task;
  const line = replyToLine(id);
  return task ? `${task}\n\n${line}` : line;
}

module.exports = { validConversation, replyToLine, withReplyTo };
