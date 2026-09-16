// =============================================================================
// lib/memoryLessons.js - Procedural "lessons" learned from human edits.
//
// A lesson is a (surface, situation, bad -> good, reason) record written when
// a human changes or rejects a bot draft. Drafters search their own lessons
// for the same surface and inject a compact block into the per-draft context.
//
// Lessons are internal procedural knowledge, so every call uses the staff
// scope. All calls are best-effort: no MEMORY binding means a no-op, and a
// memory-worker failure is logged and swallowed so a draft or approval never
// breaks because learning did.
// =============================================================================

import { buildMemoryAuthHeaders } from './memoryAuth.js';

const LESSON_FIELD_MAX = 2000;
const LESSON_SEARCH_K_MAX = 5;
const LESSON_SEARCH_K_DEFAULT = 3;
const LESSON_EXCERPT_MAX = 400;
const SURFACE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const TAG = '[memoryLessons]';

/** Trim and cap a lesson field; non-strings become ''. */
function clipField(value, max = LESSON_FIELD_MAX) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

/**
 * POST a JSON body to the memory-worker with staff scope.
 * @returns {Promise<{status:number, json:object|null}|null>} null on transport failure
 */
async function lessonsPost(env, botId, path, body) {
  try {
    const auth = await buildMemoryAuthHeaders(env, botId);
    const resp = await env.MEMORY.fetch(new Request(`https://internal${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Memory-Bot': botId,
        'X-Memory-Scope': 'all',
        ...auth,
      },
      body: JSON.stringify(body),
    }));
    if (!resp.ok) {
      const detail = await resp.text().catch((err) => `unreadable body: ${err?.message}`);
      console.error(`${TAG} ${path} bot=${botId} status=${resp.status} ${String(detail).slice(0, 200)}`);
      return null;
    }
    return { status: resp.status, json: await resp.json() };
  } catch (err) {
    console.error(`${TAG} ${path} bot=${botId}: ${err?.message}`);
    return null;
  }
}

/**
 * Record a lesson learned from a human edit or rejection. Best-effort.
 *
 * @param {object} env - Worker env with MEMORY service binding
 * @param {string} botId - Bot identifier (data scope)
 * @param {object} lesson
 * @param {string} lesson.surface - e.g. 'jacob.cold_draft'
 * @param {string} lesson.situation - short, PII-free description of the context
 * @param {string} lesson.good - the approved text ('' for a rejection)
 * @param {string} [lesson.bad] - the original draft text
 * @param {string} [lesson.reason] - the human's note, if any
 * @param {string} [lesson.source] - provenance, e.g. 'hitl_edit:<id>'
 * @returns {Promise<object|null>} {id, created_at, embedded, audience} or null
 */
export async function recordLesson(env, botId, lesson = {}) {
  if (!env?.MEMORY || !botId) return null;
  const surface = String(lesson.surface || '');
  if (!SURFACE_RE.test(surface)) {
    console.error(`${TAG} recordLesson bot=${botId}: invalid surface "${surface.slice(0, 80)}"`);
    return null;
  }
  const situation = clipField(lesson.situation);
  if (!situation) {
    console.error(`${TAG} recordLesson bot=${botId} surface=${surface}: empty situation`);
    return null;
  }
  const body = { surface, situation, good: clipField(lesson.good) };
  for (const key of ['bad', 'reason', 'source']) {
    const value = clipField(lesson[key]);
    if (value) body[key] = value;
  }
  const result = await lessonsPost(env, botId, '/lessons', body);
  return result?.json || null;
}

/**
 * Search this bot's lessons for a surface. Best-effort.
 *
 * @param {object} env - Worker env with MEMORY service binding
 * @param {string} botId
 * @param {object} params
 * @param {string} params.surface
 * @param {string} [params.query] - situation text for semantic ranking
 * @param {number} [params.k] - result count, 1..5, default 3
 * @returns {Promise<Array<object>>} lessons, [] on any failure
 */
export async function searchLessons(env, botId, { surface, query, k } = {}) {
  if (!env?.MEMORY || !botId) return [];
  if (!SURFACE_RE.test(String(surface || ''))) {
    console.error(`${TAG} searchLessons bot=${botId}: invalid surface "${String(surface).slice(0, 80)}"`);
    return [];
  }
  const count = Math.min(LESSON_SEARCH_K_MAX, Math.max(1, Number(k) || LESSON_SEARCH_K_DEFAULT));
  const body = { surface, k: count };
  const q = clipField(query);
  if (q) body.query = q;
  const result = await lessonsPost(env, botId, '/lessons/search', body);
  return Array.isArray(result?.json?.lessons) ? result.json.lessons : [];
}

/** Collapse whitespace and cap to an excerpt length with an ellipsis marker. */
function excerpt(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > LESSON_EXCERPT_MAX ? `${flat.slice(0, LESSON_EXCERPT_MAX)}...` : flat;
}

/**
 * Render lessons as a compact prompt block for per-draft (uncached) context.
 * @param {Array<object>} lessons - from searchLessons
 * @returns {string} '' when there is nothing to render
 */
export function renderLessonsBlock(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) return '';
  const lines = ['LESSONS FROM PAST HUMAN EDITS (apply these, do not mention them):'];
  lessons.forEach((lesson, i) => {
    if (!lesson?.situation) return;
    lines.push(`${i + 1}. Situation: ${excerpt(lesson.situation)}`);
    const bad = excerpt(lesson.bad);
    const good = excerpt(lesson.good);
    if (good) lines.push(`   Changed: "${bad || '(draft)'}" -> "${good}"`);
    else lines.push(`   Rejected: "${bad || '(draft)'}"`);
    if (lesson.reason) lines.push(`   Reason: ${excerpt(lesson.reason)}`);
  });
  return lines.length > 1 ? lines.join('\n') : '';
}
