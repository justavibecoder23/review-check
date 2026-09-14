import { waitUntil } from '@vercel/functions';
import {
  persistPreparedResultChatContext,
  prepareResultChatContext
} from './result-chat-context.mjs';

export function attachResultChatContext(result, options = {}) {
  const prepared = prepareResultChatContext(result, options);
  result.chatContext = prepared.descriptor;
  return prepared;
}

export function scheduleResultChatContext(prepared, options = {}) {
  if (!prepared?.descriptor?.available) return false;
  const task = persistPreparedResultChatContext(prepared, options).catch(() => ({ available: false }));
  try {
    (options.waitUntilImpl || waitUntil)(task);
  } catch {
    // Local development does not expose a Vercel request context. The task has
    // already started and remains deliberately detached from the user response.
    void task;
  }
  return true;
}
