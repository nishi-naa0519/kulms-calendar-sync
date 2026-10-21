const KULMS = 'https://lms.gakusei.kyoto-u.ac.jp';
const API = 'https://www.googleapis.com/calendar/v3';
const FULL_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const SUBMISSION_CHECK_COOLDOWN_MS = 10 * 1000;
const DAY = 86400000;
const EVENT_DURATION_MS = 5 * 60 * 1000;
const LABEL_NAME = 'マンゴー';
const NEXT_DUE_ALARM = 'kulms-next-due';
const ALARM_GRACE_MS = 5 * 1000;

let inflight = null;
let submissionCheckInflight = null;

chrome.webNavigation.onCompleted.addListener(({url, frameId}) => {
  if (frameId === 0 && url.startsWith(KULMS + '/portal')) {
    handleKulmsNavigation().catch(console.error);
  }
}, {url: [{hostEquals: 'lms.gakusei.kyoto-u.ac.jp'}]});

chrome.webNavigation.onHistoryStateUpdated.addListener(({url, frameId}) => {
  if (frameId === 0 && url.startsWith(KULMS + '/portal')) {
    handleKulmsNavigation().catch(console.error);
  }
}, {url: [{hostEquals: 'lms.gakusei.kyoto-u.ac.jp'}]});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NEXT_DUE_ALARM) {
    cleanupExpiredEvents().catch(console.error);
  }
});

chrome.runtime.onStartup.addListener(() => {
  cleanupExpiredEvents().catch(console.error);
});

chrome.runtime.onInstalled.addListener(() => {
  cleanupExpiredEvents().catch(console.error);
});

chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (msg.type === 'SYNC') {
    runSync(true)
      .then(result => sendResponse({ok: true, result}))
      .catch(e => sendResponse({ok: false, error: e.message}));
    return true;
  }

  if (msg.type === 'CONNECT') {
    chrome.identity.getAuthToken({interactive: true})
      .then(({token}) => {
        if (!token) throw new Error('Google認証トークンが取得できません');
        return chrome.storage.local.set({connected: true});
      })
      .then(() => sendResponse({ok: true}))
      .catch(e => sendResponse({ok: false, error: e.message}));
    return true;
  }
});

async function handleKulmsNavigation() {
  const {lastFetch} = await chrome.storage.local.get('lastFetch');
  if (!lastFetch || Date.now() - lastFetch >= FULL_SYNC_COOLDOWN_MS) {
    await runSync(false);
  } else {
    // 通常同期のクールダウン中でも、提出直後の削除だけは確認する。
    await runSubmissionCheck(false);
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {credentials: 'include', cache: 'no-store', redirect: 'follow'});
  if (!res.ok) throw new Error(`KULMS HTTP ${res.status}: ${new URL(url).pathname}`);
  if (!(res.headers.get('content-type') || '').includes('json')) {
    throw new Error('KULMSはJSON以外を返しました。ログイン状態を確認してください');
  }
  return res.json();
}

function timestamp(v) {
  if (!v || !Number.isFinite(v.epochSecond)) return null;
  const nano = v.nano ?? 0;
  if (!Number.isFinite(nano) || nano < 0 || nano >= 1e9) return null;
  const t = v.epochSecond * 1000 + Math.floor(nano / 1e6);
  return Number.isFinite(t) && !Number.isNaN(new Date(t).getTime()) ? t : null;
}

async function getCourseTitle(context, overrides) {
  if (overrides[context]?.trim()) return overrides[context].trim();
  try {
    const site = await fetchJson(`${KULMS}/direct/site/${encodeURIComponent(context)}.json`);
    if (typeof site.title === 'string' && site.title.trim()) return site.title.trim();
  } catch (e) {
    console.info('授業名取得不可', context, e.message);
  }
  return null;
}

async function buildAssignments(items, overrides) {
  const contexts = [...new Set(items.map(x => x.context).filter(x => typeof x === 'string'))];
  const titles = Object.fromEntries(
    await Promise.all(contexts.map(async id => [id, await getCourseTitle(id, overrides)]))
  );

  return items.map(a => {
    const due = timestamp(a.dueTime);
    if (!a.id || !a.context || !due) return null;
    return {
      key: `${a.context}:${a.id}`,
      courseId: a.context,
      assignmentId: a.id,
      courseName: titles[a.context],
      assignmentName: String(a.title || a.entityTitle || a.gradebookItemName || ''),
      due
    };
  }).filter(Boolean);
}

function boolTrue(v) {
  return v === true || v === 'true';
}

function submissionObjects(data) {
  // KULMSでは itemSubmission API の応答が
  // { assignment_collection: [ { submitted, draft, ... } ] }
  // という形になることを実環境で確認済み。Sakaiのバージョン差にも耐えるよう、
  // キー名を決め打ちせずネストしたオブジェクトを再帰的に探索する。
  const out = [];
  const seen = new Set();

  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }

    if (
      'submitted' in value ||
      'draft' in value ||
      'dateSubmitted' in value ||
      'dateSubmittedEpochSeconds' in value
    ) {
      out.push(value);
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
  }

  visit(data);
  return out;
}

async function getSubmissionState(assignmentId) {
  const url = `${KULMS}/direct/assignment/itemSubmission/${encodeURIComponent(assignmentId)}.json`;
  const res = await fetch(url, {credentials: 'include', cache: 'no-store', redirect: 'follow'});

  // Sakaiは「このユーザーのsubmissionがまだ存在しない」場合に400を返す実装がある。
  // これは未提出として扱う。ただし削除は submitted=true を明示確認した場合だけ行う。
  if (res.status === 400 || res.status === 404) {
    return {known: true, submitted: false, exists: false};
  }

  if (!res.ok) {
    return {known: false, submitted: false, error: `HTTP ${res.status}`};
  }

  if (!(res.headers.get('content-type') || '').includes('json')) {
    return {known: false, submitted: false, error: 'non-json'};
  }

  const data = await res.json();
  const submissions = submissionObjects(data);

  // KULMSでは未開始の課題でも submitted=true が返るケースがある。
  // そのため submitted フラグ単独では提出済みとみなさず、実際の提出日時も必須にする。
  // 誤って未提出課題を消すより、提出済み課題が締切まで残る方を安全側とする。
  function submittedAtSeconds(s) {
    const epoch = Number(s.dateSubmittedEpochSeconds);
    if (Number.isFinite(epoch) && epoch > 0) return epoch;

    const raw = typeof s.dateSubmitted === 'string' ? s.dateSubmitted.trim() : '';
    if (raw) {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
    }
    return 0;
  }

  const latestDateSubmitted = submissions
    .map(submittedAtSeconds)
    .filter(v => v > 0)
    .sort((a, b) => b - a)[0] ?? null;

  const submitted = submissions.some(s =>
    boolTrue(s.submitted) &&
    !boolTrue(s.draft) &&
    submittedAtSeconds(s) > 0
  );

  return {
    known: submissions.length > 0,
    submitted,
    exists: submissions.length > 0,
    dateSubmittedEpochSeconds: latestDateSubmitted
  };
}

async function google(path, method = 'GET', body = null, retry = true) {
  const {token} = await chrome.identity.getAuthToken({interactive: false});
  if (!token) throw new Error('Google認証が必要です。拡張機能でGoogle接続を押してください');

  const resp = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(body ? {'Content-Type': 'application/json'} : {})
    },
    ...(body ? {body: JSON.stringify(body)} : {})
  });

  if (resp.status === 401 && retry) {
    await chrome.identity.removeCachedAuthToken({token});
    return google(path, method, body, false);
  }

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Google Calendar HTTP ${resp.status}: ${txt.slice(0, 350)}`);
  }
  return resp.status === 204 ? null : resp.json();
}

const enc = encodeURIComponent;

async function allManagedEvents(calendarId) {
  const result = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      privateExtendedProperty: 'kulmsManaged=v1',
      maxResults: '2500',
      showDeleted: 'false'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await google(`/calendars/${enc(calendarId)}/events?${params}`);
    result.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return result;
}

async function ensureMangoLabel(calendarId) {
  const calendar = await google(`/calendars/${enc(calendarId)}`);
  const labels = calendar.labelProperties?.eventLabels || [];
  return labels.find(l => l.name === LABEL_NAME)?.id || null;
}

function eventBody(a, labelId) {
  const start = a.due - DAY;
  return {
    summary: a.courseName,
    description: `課題: ${a.assignmentName}\n提出期限: ${new Date(a.due).toLocaleString('ja-JP', {timeZone: 'Asia/Tokyo'})} (JST)\nKULMSから自動同期`,
    start: {dateTime: new Date(start).toISOString(), timeZone: 'Asia/Tokyo'},
    end: {dateTime: new Date(start + EVENT_DURATION_MS).toISOString(), timeZone: 'Asia/Tokyo'},
    eventLabelId: labelId,
    reminders: {useDefault: false, overrides: []},
    extendedProperties: {
      private: {
        kulmsManaged: 'v1',
        kulmsKey: a.key,
        kulmsCourseId: a.courseId,
        kulmsAssignmentId: a.assignmentId,
        kulmsDue: String(a.due)
      }
    }
  };
}

function managedEventDue(event) {
  const raw = event.extendedProperties?.private?.kulmsDue;
  const due = Number(raw);
  return Number.isFinite(due) ? due : null;
}

async function scheduleNextDueAlarm(calendarId, events = null) {
  const managed = events || await allManagedEvents(calendarId);
  const now = Date.now();
  const futureDue = managed
    .map(managedEventDue)
    .filter(due => due !== null && due > now);

  await chrome.alarms.clear(NEXT_DUE_ALARM);
  if (!futureDue.length) return null;

  const nextDue = Math.min(...futureDue);
  chrome.alarms.create(NEXT_DUE_ALARM, {
    when: Math.max(nextDue + ALARM_GRACE_MS, Date.now() + 1000)
  });
  return nextDue;
}

async function deleteExpiredFromEvents(calendarId, events, now = Date.now()) {
  const expired = events.filter(event => {
    const due = managedEventDue(event);
    return due !== null && due <= now;
  });
  const expiredIds = new Set(expired.map(e => e.id));
  const deleted = expired.length ? await deleteEvents(calendarId, expired) : 0;
  const remaining = events.filter(e => !expiredIds.has(e.id));
  return {deleted, remaining};
}

async function cleanupExpiredEvents() {
  const cfg = await chrome.storage.local.get(['connected', 'calendarId']);
  if (!cfg.connected) {
    await chrome.alarms.clear(NEXT_DUE_ALARM);
    return {skipped: 'Google未接続'};
  }

  const calendarId = cfg.calendarId || 'primary';
  const events = await allManagedEvents(calendarId);
  const {deleted, remaining} = await deleteExpiredFromEvents(calendarId, events);
  const nextDue = await scheduleNextDueAlarm(calendarId, remaining);
  const result = {
    at: new Date().toISOString(),
    deleted,
    nextDue: nextDue ? new Date(nextDue).toISOString() : null
  };
  await chrome.storage.local.set({lastDeadlineCleanup: result});
  return result;
}

async function deleteEvents(calendarId, events) {
  let deleted = 0;
  for (const e of events) {
    await google(`/calendars/${enc(calendarId)}/events/${enc(e.id)}`, 'DELETE');
    deleted++;
  }
  return deleted;
}

async function runSubmissionCheck(force) {
  if (submissionCheckInflight) return submissionCheckInflight;
  submissionCheckInflight = submissionCheckImpl(force).finally(() => {
    submissionCheckInflight = null;
  });
  return submissionCheckInflight;
}

async function submissionCheckImpl(force) {
  const cfg = await chrome.storage.local.get(['connected', 'calendarId', 'lastSubmissionCheck']);
  if (!cfg.connected) return {skipped: 'Google未接続'};
  if (!force && cfg.lastSubmissionCheck && Date.now() - cfg.lastSubmissionCheck < SUBMISSION_CHECK_COOLDOWN_MS) {
    return {skipped: '提出状態チェックのクールダウン中'};
  }

  const calendarId = cfg.calendarId || 'primary';
  const allEvents = await allManagedEvents(calendarId);

  // 締切到来済みは提出状態に関係なく削除する。
  const expiry = await deleteExpiredFromEvents(calendarId, allEvents);
  const events = expiry.remaining;
  const byAssignmentId = new Map();

  for (const event of events) {
    const id = event.extendedProperties?.private?.kulmsAssignmentId;
    if (!id) continue;
    if (!byAssignmentId.has(id)) byAssignmentId.set(id, []);
    byAssignmentId.get(id).push(event);
  }

  let checked = 0;
  let submittedDeleted = 0;
  let unknown = 0;
  const submittedDeletedIds = new Set();

  for (const [assignmentId, relatedEvents] of byAssignmentId) {
    const state = await getSubmissionState(assignmentId);
    checked++;
    if (!state.known && !state.submitted) unknown++;
    if (state.submitted) {
      submittedDeleted += await deleteEvents(calendarId, relatedEvents);
      for (const e of relatedEvents) submittedDeletedIds.add(e.id);
    }
  }

  const remaining = events.filter(e => !submittedDeletedIds.has(e.id));
  const nextDue = await scheduleNextDueAlarm(calendarId, remaining);
  const at = Date.now();
  const result = {
    at: new Date(at).toISOString(),
    checked,
    submittedDeleted,
    deadlineDeleted: expiry.deleted,
    deleted: submittedDeleted + expiry.deleted,
    unknown,
    nextDue: nextDue ? new Date(nextDue).toISOString() : null
  };
  await chrome.storage.local.set({
    lastSubmissionCheck: at,
    lastSubmissionResult: result,
    lastDeadlineCleanup: {
      at: result.at,
      deleted: expiry.deleted,
      nextDue: result.nextDue
    }
  });
  return result;
}

async function runSync(force) {
  if (inflight) return inflight;
  inflight = syncImpl(force).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function syncImpl(force) {
  const settings = await chrome.storage.local.get([
    'lastFetch',
    'connected',
    'calendarId',
    'courseOverrides'
  ]);

  if (!force && settings.lastFetch && Date.now() - settings.lastFetch < FULL_SYNC_COOLDOWN_MS) {
    return runSubmissionCheck(false);
  }

  try {
    const data = await fetchJson(KULMS + '/direct/assignment/my.json');
    if (!Array.isArray(data.assignment_collection)) {
      throw new Error('assignment_collectionがありません');
    }

    const items = await buildAssignments(data.assignment_collection, settings.courseOverrides || {});
    const now = Date.now();

    await chrome.storage.local.set({
      coursesMissing: [...new Set(items.filter(a => !a.courseName).map(a => a.courseId))],
      assignmentCount: data.assignment_collection.length
    });

    const stats = {
      found: items.length,
      created: 0,
      updated: 0,
      submittedDeleted: 0,
      deadlineDeleted: 0,
      duplicatesDeleted: 0,
      unchanged: 0,
      alreadySubmitted: 0,
      missingNames: items.filter(a => !a.courseName).length,
      submissionUnknown: 0
    };

    if (settings.connected) {
      const calendarId = settings.calendarId || 'primary';
      const labelId = await ensureMangoLabel(calendarId);
      if (!labelId) {
        throw new Error('マンゴーのイベントラベルが見つかりません。Googleカレンダーで「マンゴー」ラベルを作成してから再試行してください。');
      }

      const currentAll = await allManagedEvents(calendarId);
      const initialExpiry = await deleteExpiredFromEvents(calendarId, currentAll, now);
      stats.deadlineDeleted += initialExpiry.deleted;
      const current = initialExpiry.remaining;

      const byKey = new Map();
      for (const e of current) {
        const key = e.extendedProperties?.private?.kulmsKey;
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(e);
      }

      const itemByKey = new Map(items.map(a => [a.key, a]));
      const submissionCache = new Map();

      async function stateFor(assignmentId) {
        if (!submissionCache.has(assignmentId)) {
          submissionCache.set(assignmentId, await getSubmissionState(assignmentId));
        }
        return submissionCache.get(assignmentId);
      }

      // 既存イベントは「提出済み」または「締切到来済み」のどちらかで削除する。
      for (const [key, matches] of [...byKey.entries()]) {
        const p = matches[0]?.extendedProperties?.private || {};
        const item = itemByKey.get(key);
        const assignmentId = p.kulmsAssignmentId || item?.assignmentId;
        const due = item?.due ?? Number(p.kulmsDue);

        // KULMS側で期限変更され、現在の期限がすでに過ぎている場合もここで削除する。
        if (Number.isFinite(due) && due <= now) {
          stats.deadlineDeleted += await deleteEvents(calendarId, matches);
          byKey.delete(key);
          continue;
        }

        if (!assignmentId) continue;
        const state = await stateFor(assignmentId);
        if (!state.known && !state.submitted) stats.submissionUnknown++;
        if (state.submitted) {
          stats.submittedDeleted += await deleteEvents(calendarId, matches);
          byKey.delete(key);
        }
      }

      for (const a of items) {
        let matches = byKey.get(a.key) || [];

        // 締切到来済みは提出状態に関係なく削除し、新規作成もしない。
        if (a.due <= now) {
          if (matches.length) {
            stats.deadlineDeleted += await deleteEvents(calendarId, matches);
            byKey.delete(a.key);
          }
          continue;
        }

        const state = await stateFor(a.assignmentId);
        if (!state.known && !state.submitted) stats.submissionUnknown++;

        if (state.submitted) {
          stats.alreadySubmitted++;
          if (matches.length) {
            stats.submittedDeleted += await deleteEvents(calendarId, matches);
            byKey.delete(a.key);
          }
          continue;
        }

        if (!a.courseName) continue;

        const body = eventBody(a, labelId);
        const old = matches[0];

        if (!old) {
          await google(`/calendars/${enc(calendarId)}/events?eventLabelVersion=1`, 'POST', body);
          stats.created++;
        } else {
          const p = old.extendedProperties?.private || {};
          if (
            old.summary !== body.summary ||
            p.kulmsDue !== String(a.due) ||
            p.kulmsAssignmentId !== a.assignmentId ||
            old.eventLabelId !== labelId ||
            old.description !== body.description
          ) {
            await google(`/calendars/${enc(calendarId)}/events/${enc(old.id)}?eventLabelVersion=1`, 'PATCH', body);
            stats.updated++;
          } else {
            stats.unchanged++;
          }

          if (matches.length > 1) {
            stats.duplicatesDeleted += await deleteEvents(calendarId, matches.slice(1));
          }
        }
      }

      const nextDue = await scheduleNextDueAlarm(calendarId);
      await chrome.storage.local.set({
        lastSubmissionCheck: Date.now(),
        lastSubmissionResult: {
          at: new Date().toISOString(),
          checked: submissionCache.size,
          submittedDeleted: stats.submittedDeleted,
          deadlineDeleted: stats.deadlineDeleted,
          deleted: stats.submittedDeleted + stats.deadlineDeleted,
          unknown: stats.submissionUnknown,
          nextDue: nextDue ? new Date(nextDue).toISOString() : null
        },
        lastDeadlineCleanup: {
          at: new Date().toISOString(),
          deleted: stats.deadlineDeleted,
          nextDue: nextDue ? new Date(nextDue).toISOString() : null
        }
      });
    }

    await chrome.storage.local.set({
      lastFetch: Date.now(),
      lastResult: {
        at: new Date().toISOString(),
        state: 'success',
        stats,
        calendarConnected: !!settings.connected
      }
    });

    return stats;
  } catch (e) {
    await chrome.storage.local.set({
      lastResult: {at: new Date().toISOString(), state: 'error', error: e.message}
    });
    throw e;
  }
}
