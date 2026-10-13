export default async function handler(req, res) {
  // CORS 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Vercel 환경변수에서 Gemini API 키 가져오기 (대소문자 처리)
  const apiKey = process.env.GEMINI_API_KEY || process.env.gemini_api_key;

  // 1. GET 요청: 연결 테스트용 (/api/ai 브라우저 직접 접속)
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      keySet: !!apiKey,
      model: "gemini-2.5-flash"
    });
  }

  // 2. POST 요청: 실제 AI 기능 호출용
  if (req.method === 'POST') {
    if (!apiKey) {
      return res.status(500).json({ error: "Gemini API 키가 Vercel에 설정되지 않았습니다." });
    }

    const { prompt } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: "요청 내용(prompt)이 없습니다." });
    }

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        }
      );

      const data = await response.json();
      
      if (!response.ok) {
        return res.status(response.status).json({ error: data.error?.message || "Gemini API 오류" });
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return res.status(200).json({ ok: true, text });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: "허용되지 않는 요청 방식입니다." });
}
