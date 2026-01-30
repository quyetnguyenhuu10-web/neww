import OpenAI from "openai";

function getApiKey() {
  return process.env.VITE_API_KEY || process.env.OPENAI_API_KEY || "";
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export function makeAIClient() {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Missing VITE_API_KEY / OPENAI_API_KEY");

  const client = new OpenAI({
    apiKey,
    timeout: 180000,
    maxRetries: 2
  });

  return {
    // CALL 1: AI returns plan JSON (not hard-coded)
    async planActions({ model, userText, paperHead, maxSteps = 6 }) {
      const schemaHint =
`Trả JSON DUY NHẤT theo schema:
{
  "steps":[
    {"op":"search","query":""},
    {"op":"read","startLine":1,"endLine":2},
    {"op":"write_append","text":"..."},
    {"op":"write_replace","line":2,"text":"..."},
    {"op":"clear_line","line":2},
    {"op":"clear_range","startLine":1,"endLine":5},
    {"op":"clear_all"}
  ]
}

Quy tắc:
- Nếu user hỏi paper có gì => 1 step: {"op":"search","query":""}
- Nếu user yêu cầu sửa dòng N => 2 step: read (N..N), rồi write_replace line:N
- Nếu user yêu cầu ghi/thêm => write_append (text là nội dung cần ghi)
- Nếu user yêu cầu xóa dòng N / làm rỗng dòng N => clear_line line:N
- Nếu user yêu cầu xóa từ dòng A đến B => clear_range startLine:A endLine:B
- Nếu user yêu cầu xóa hết / clear paper / làm rỗng tất cả => clear_all (KHÔNG được lập nhiều write_replace rỗng)
- Không bịa line số: chỉ dùng line/range nếu user chỉ rõ.
- steps tối đa ${maxSteps}.`;

      const r = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content:
              "Bạn là EXECUTOR trong workspace editor.\n" +
              "Bạn KHÔNG trả lời người dùng.\n" +
              "Bạn chỉ được xuất JSON plan để gọi actions.\n" +
              schemaHint
          },
          {
            role: "user",
            content:
              `USER_MESSAGE:\n${userText}\n\n` +
              `PAPER_HEAD (để tham chiếu):\n${paperHead || "(empty)"}\n\n` +
              `Hãy xuất JSON:`
          }
        ],
        temperature: 0.2,
        max_completion_tokens: 600
      });

      const raw = (r.choices[0]?.message?.content || "").trim();

      // Some models may wrap in ```json ... ```
      const cleaned = raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```$/g, "")
        .trim();

      const obj = safeJsonParse(cleaned);
      if (!obj || !Array.isArray(obj.steps)) return { steps: [], raw };

      // Hard guard: never allow executor to return too many steps
      const steps = obj.steps.slice(0, Math.max(0, maxSteps));
      return { steps, raw };
    },

    // CALL 2: Presenter streaming
    async streamPresenter({ model, userText, facts, onDelta }) {
      const stream = await client.chat.completions.create({
        model,
        stream: true,
        messages: [
          {
            role: "system",
            content:
              "Bạn là PRESENTER.\n" +
              "Trả lời người dùng dựa trên FACTS.\n" +
              "Không nhắc tới actions/tool, không nói về JSON plan.\n" +
              "Nếu không có thay đổi thì nói rõ.\n"
          },
          {
            role: "user",
            content: `USER:\n${userText}\n\nFACTS:\n${facts}\n\nTrả lời:`
          }
        ],
        temperature: 0.7,
        max_completion_tokens: 1200
      });

      let full = "";
      for await (const chunk of stream) {
        const d = chunk.choices[0]?.delta?.content;
        if (d) {
          full += d;
          onDelta?.(d, full);
        }
      }
      return full;
    }
  };
}
