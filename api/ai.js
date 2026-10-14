// 버셀 서버 함수: /api/ai — 알림장 앱 ↔ 구글 제미나이(AI 스튜디오) 중계
// - 제미나이 키는 버셀 환경 변수 GEMINI_API_KEY 에만 둡니다. 화면 코드(index.html)에는 절대 넣지 않아요.
// - 담임 선생님(파이어스토어 config/owner 에 적힌 계정)만 쓸 수 있어요.
// - kind="json" : JSON 으로 답하게 함(기초자료·상담 정리) / 그 밖 : 일반 글(공지 정리, 메시지 다듬기)
// - 응답: {"text":"…","model":"…"}
// - 점검: 누리집주소/api/ai?check=1 을 열면 키와 모델이 실제로 답하는지 알려 줍니다(모델마다 아주 짧은 호출 1번).

// ===== 설정 (이 부분만 고치면 됩니다) =====
const FIREBASE_API_KEY = 'AIzaSyBBqBI1Fg-oOD7armN5BrkaO-Mq8n-L-eg';          // index.html 의 apiKey 와 같은 값(공개용, 로그인 확인에만 사용)
const FIREBASE_PROJECT_ID = 'class-noticeboard-4b9f3';    // index.html 의 projectId 와 같은 값
// 앞에서부터 차례로 시도합니다. 하나가 막히거나(404·429·503) 늦으면 다음 모델로 넘어가요. (2026-10-14 공식 목록에서 확인)
const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
const PER_MODEL_MS = 25000;       // 한 모델이 이 시간 안에 답하지 않으면 다음 모델로
// ==========================================

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const envName = (n) => Object.keys(process.env).find((k) => k.toUpperCase() === n);
const env = (n) => { const k = envName(n); return k ? String(process.env[k]).trim() : ''; };
const modelList = () => { const l = [env('GEMINI_MODEL')].concat(MODELS).filter(Boolean); return l.filter((m, i) => l.indexOf(m) === i); };

const hits = new Map();
const limited = (key, n) => {
  const now = Date.now(), h = (hits.get(key) || []).filter((x) => now - x < 60000);
  if (h.length >= n) return true;
  h.push(now); hits.set(key, h);
  if (hits.size > 5000) hits.clear();
  return false;
};
const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
async function errText(r) {
  let t = ''; try { t = await r.text(); } catch (e) { }
  try { const j = JSON.parse(t); if (j.error && j.error.message) t = j.error.message; } catch (e) { }
  return String(t).replace(/\s+/g, ' ').slice(0, 200);
}

export async function GET(request) {
  const key = env('GEMINI_API_KEY');
  const out = { ok: true, keySet: !!key, models: modelList(), check: [] };
  if (key && new URL(request.url).searchParams.get('check')) {
    for (const m of modelList()) {
      try {
        const r = await fetch(BASE + encodeURIComponent(m) + ':generateContent', {
          method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '"네"라고만 답하세요.' }] }], generationConfig: { maxOutputTokens: 20 } })
        });
        out.check.push(r.ok ? { model: m, ok: true } : { model: m, ok: false, status: r.status, error: await errText(r) });
      } catch (e) { out.check.push({ model: m, ok: false, error: e && e.name === 'TimeoutError' ? '응답 지연' : 'network' }); }
    }
  }
  return json(out, 200);
}

export async function POST(request) {
  const GKEY = env('GEMINI_API_KEY');
  const FB_KEY = env('FIREBASE_API_KEY') || FIREBASE_API_KEY, PID = env('FIREBASE_PROJECT_ID') || FIREBASE_PROJECT_ID;
  if (!GKEY) return json({ error: '서버 설정(환경 변수 GEMINI_API_KEY)이 비어 있어요' }, 500);

  const body = await request.json().catch(() => null);
  const prompt = body && typeof body.prompt === 'string' ? body.prompt : '';
  const asJson = body && body.kind === 'json';
  if (!prompt) return json({ error: '빈 요청' }, 400);
  if (prompt.length > 40000) return json({ error: '요청이 너무 길어요' }, 413);

  // 1) 파이어베이스 로그인 토큰 확인
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: '로그인이 필요해요' }, 401);
  const lk = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FB_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
  });
  if (!lk.ok) return json({ error: '로그인 확인 실패' }, 401);
  const uid = ((await lk.json()).users || [])[0]?.localId;
  if (!uid) return json({ error: '로그인 확인 실패' }, 401);

  // 2) 담임 선생님 확인: config/owner 문서의 uid 가 이 계정인지
  const o = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(PID)}/databases/(default)/documents/config/owner`,
    { headers: { Authorization: 'Bearer ' + token } });
  const ownerUid = o.ok ? (((await o.json()).fields || {}).uid || {}).stringValue : '';
  if (!ownerUid || ownerUid !== uid) return json({ error: '담임 선생님만 사용할 수 있어요' }, 403);
  if (limited('uid:' + uid, 30)) return json({ error: '잠시 후 다시 시도해 주세요' }, 429);

  // 3) 제미나이 호출: 모델을 차례로 시도해 처음 답한 모델을 씀
  const generationConfig = { maxOutputTokens: asJson ? 8000 : 1500, temperature: asJson ? 0.2 : 0.4 };
  if (asJson) generationConfig.responseMimeType = 'application/json';
  const payload = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig });

  let anyLimit = false; const errs = [];
  for (const m of modelList()) {
    try {
      const r = await fetch(`${BASE}${encodeURIComponent(m)}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(PER_MODEL_MS),
        headers: { 'x-goog-api-key': GKEY, 'Content-Type': 'application/json' }, body: payload
      });
      if (!r.ok) { if (r.status === 429) anyLimit = true; errs.push(`${m} ${r.status} ${await errText(r)}`); continue; }
      const j = await r.json(), c = (j.candidates || [])[0];
      const text = ((c && c.content && c.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
      if (!text) { errs.push(`${m} 빈 답(${(c && c.finishReason) || (j.promptFeedback && j.promptFeedback.blockReason) || '?'})`); continue; }
      return json({ text, model: m }, 200);
    } catch (e) { errs.push(m + (e && e.name === 'TimeoutError' ? ' 응답 지연' : ' 연결 실패')); }
  }
  return json({ error: '제미나이 오류: ' + errs.join(' | ').slice(0, 600) }, anyLimit ? 429 : 502);
}
