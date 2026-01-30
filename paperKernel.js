// paperKernel.js (ESM)
// SSOT = paper.text
// - Word-like wrap with offsets
// - Diff visuals:
//   * green highlight lines = highlightLines + annot.htmlLines with <span class="newLineFull">
//   * red ghost line(s) = diff.removedLines (array of strings)
// - Preview HTML uses annot.htmlLines (already escaped) for client innerHTML

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[m]));
}

// ===== Word-like wrap with offsets (SSOT = paper.text) =====
function layoutWordWrapWithOffsets(buffer, cols) {
  const out = [];
  let lineNo = 1;
  let i = 0;
  const s = String(buffer);

  while (i <= s.length) {
    let pEnd = s.indexOf("\n", i);
    if (pEnd === -1) pEnd = s.length;
    const pStart = i;
    const para = s.slice(pStart, pEnd);

    let cursor = 0;
    while (cursor < para.length) {
      while (cursor < para.length && para[cursor] === " ") cursor++;
      if (cursor >= para.length) break;

      let lineStartAbs = pStart + cursor;
      let lineEndAbs = lineStartAbs;
      let lineText = "";

      while (cursor < para.length) {
        let wStart = cursor;
        while (wStart < para.length && para[wStart] === " ") wStart++;
        if (wStart >= para.length) break;

        let wEnd = wStart;
        while (wEnd < para.length && para[wEnd] !== " ") wEnd++;

        const word = para.slice(wStart, wEnd);
        const candidate = lineText ? (lineText + " " + word) : word;

        if (candidate.length <= cols) {
          if (!lineText) lineStartAbs = pStart + wStart;
          lineText = candidate;
          lineEndAbs = pStart + wEnd;
          cursor = wEnd;
          while (cursor < para.length && para[cursor] === " ") cursor++;
        } else {
          // single word longer than cols => cut
          if (!lineText) {
            const cut = word.slice(0, cols);
            lineText = cut;
            lineStartAbs = pStart + wStart;
            lineEndAbs = pStart + wStart + cut.length;
            cursor = wStart + cut.length;
          }
          break;
        }
      }

      out.push({ lineNo, text: lineText, start: lineStartAbs, end: lineEndAbs });
      lineNo++;
    }

    // empty paragraph still yields one visual line
    if (para.length === 0) {
      out.push({ lineNo, text: "", start: pStart, end: pStart });
      lineNo++;
    }

    i = pEnd + 1;
    if (pEnd === s.length) break;
  }

  if (!out.length) out.push({ lineNo: 1, text: "", start: 0, end: 0 });
  return out;
}

// ===== compute which visual lines overlap a [absStart, absEnd) range in paper.text =====
function computeHighlightLinesByAbsRange(visLines, absStart, absEnd) {
  const hl = [];
  const a = Math.max(0, Number(absStart) || 0);
  const b = Math.max(a, Number(absEnd) || a);

  for (const v of visLines) {
    const s = v.start ?? 0;
    const e = v.end ?? s;
    const overlap = (s < b) && (e > a);
    if (overlap) hl.push(v.lineNo);
  }
  return hl;
}

// ===== Annot: only green-full on highlight lines; others plain =====
function buildAnnotWindow(afterVis, startLine, windowSize, highlightSet) {
  const slice = afterVis.slice(startLine - 1, startLine - 1 + windowSize);
  const htmlLines = slice.map((v) => {
    const t = v.text ?? "";
    if (!t) return "";
    if (highlightSet && highlightSet.has(v.lineNo)) {
      return `<span class="newLineFull">${escHtml(t)}</span>`;
    }
    return escHtml(t);
  });
  return { startLine, htmlLines };
}

export function createPaperKernel({ cols = 26 } = {}) {
  const paper = {
    cols,
    rev: 0,
    text: "",
    diff: null,
    // diff:
    // {
    //   anchorLine,
    //   removedText?: string | null,
    //   removedLines?: string[] | null,
    //   highlightLines?: number[],
    //   annot:{startLine, htmlLines[]}
    // }
  };

  function getVisualLines() {
    return layoutWordWrapWithOffsets(paper.text, paper.cols);
  }

  function getState({ includeVisual = true } = {}) {
    const vis = getVisualLines();
    return {
      paper_rev: paper.rev,
      cols: paper.cols,
      text: paper.text,
      lineCount: vis.length,
      head: vis
        .slice(0, Math.min(12, vis.length))
        .map((v) => `${v.lineNo}| ${v.text}`)
        .join("\n"),
      diff: paper.diff,
      visual: includeVisual ? vis.map((v) => ({ lineNo: v.lineNo, text: v.text })) : undefined,
    };
  }

  function clearDiff() {
    paper.diff = null;
  }

  function _setDiff({ anchorLine, removedText = null, removedLines = null, highlightLines = [] }) {
    const afterVis = getVisualLines();
    const WINDOW = 45;
    const winStart = Math.max(1, (Number(anchorLine) || 1) - 2);

    const highlightSet = new Set(highlightLines || []);
    const annot = buildAnnotWindow(afterVis, winStart, WINDOW, highlightSet);

    paper.diff = {
      anchorLine: Number(anchorLine) || 1,
      removedText,
      removedLines,
      highlightLines,
      annot,
    };
  }

  // Core replace on a VISUAL line (N) using offsets into SSOT
  // IMPORTANT: when rep == "" (clear), we must provide removedLines so UI can render ghost red.
  function _writeReplaceInternal(anchorLine, newText) {
    const beforeVis = getVisualLines();
    const N = Math.max(1, Math.min(Number(anchorLine) || 1, beforeVis.length));
    const target = beforeVis[N - 1];

    const oldText = target.text || "";
    const start = target.start ?? 0;
    const end = target.end ?? start;

    const rep = String(newText ?? "").replace(/\s+/g, " ").trim();

    // apply replace into SSOT
    paper.text = paper.text.slice(0, start) + rep + paper.text.slice(end);
    paper.rev++;

    // compute highlight lines from absolute insert range in AFTER text
    const afterVis = getVisualLines();
    const absStart = start;
    const absEnd = start + rep.length;
    const highlightLines = computeHighlightLinesByAbsRange(afterVis, absStart, absEnd);

    // ✅ Diff policy:
    // - If rep is empty (clear line): show RED ghost via removedLines=[oldText], and no removedText needed.
    // - If rep is non-empty: keep removedText (optional for UI), removedLines null.
    const isClear = rep.length === 0;

    _setDiff({
      anchorLine: N,
      removedText: isClear ? null : oldText,
      removedLines: isClear ? [oldText] : null,
      highlightLines,
    });

    return {
      ok: true,
      anchorLine: N,
      removedText: isClear ? null : oldText,
      removedLines: isClear ? [oldText] : null,
      paper_rev: paper.rev,
      highlightLines,
    };
  }

  const actions = {
    search({ query, topK = 8 }) {
      const q = String(query ?? "").trim().toLowerCase();
      const vis = getVisualLines();

      if (!q) {
        const head = vis
          .slice(0, Math.min(12, vis.length))
          .map((v) => `${v.lineNo}| ${v.text}`)
          .join("\n");
        return { kind: "head", rev: paper.rev, lineCount: vis.length, head };
      }

      const hits = [];
      for (const v of vis) {
        if ((v.text || "").toLowerCase().includes(q)) hits.push({ line: v.lineNo, text: v.text });
      }
      return { kind: "hits", rev: paper.rev, query: q, hits: hits.slice(0, topK) };
    },

    read({ startLine, endLine }) {
      const vis = getVisualLines();
      const s = Math.max(1, Math.min(Number(startLine) || 1, vis.length));
      const e = Math.max(s, Math.min(Number(endLine) || s, vis.length));
      const lines = vis.slice(s - 1, e).map((v) => ({
        line: v.lineNo,
        text: v.text,
        start: v.start,
        end: v.end,
      }));
      return { rev: paper.rev, startLine: s, endLine: e, lines };
    },

    write_replace({ anchorLine, newText }) {
      const r = _writeReplaceInternal(anchorLine, newText);
      return { ...r, op: "write_replace" };
    },

    write_append({ text, ensureNewParagraph = true }) {
      const beforeVis = getVisualLines();
      const beforeLen = paper.text.length;

      let ins = String(text ?? "").trim();
      if (!ins) return { ok: false, op: "write_append", reason: "empty_text", paper_rev: paper.rev };

      const needsNL = ensureNewParagraph && paper.text.length > 0 && !paper.text.endsWith("\n");
      const absStart = beforeLen + (needsNL ? 1 : 0);

      paper.text = paper.text + (needsNL ? "\n" : "") + ins;
      paper.rev++;

      const afterVis = getVisualLines();
      const absEnd = absStart + ins.length;
      const highlightLines = computeHighlightLinesByAbsRange(afterVis, absStart, absEnd);

      _setDiff({
        anchorLine: Math.max(1, beforeVis.length),
        removedText: null,
        removedLines: null,
        highlightLines,
      });

      return { ok: true, op: "write_append", paper_rev: paper.rev, highlightLines };
    },

    clear_line({ line }) {
      const r = _writeReplaceInternal(line, "");
      return { ...r, op: "clear_line", clearedLine: r.anchorLine };
    },

    // Clear multiple visual lines.
    // IMPORTANT: This should produce removedLines[] so UI can render multiple ghost red lines.
    // We delete bottom-up to keep offsets valid, and we accumulate removed lines in top-down order.
    clear_range({ startLine, endLine }) {
      const before = getVisualLines();
      const maxLine = before.length;

      let s = Math.max(1, Math.min(Number(startLine) || 1, maxLine));
      let e = Math.max(1, Math.min(Number(endLine) || s, maxLine));
      if (e < s) [s, e] = [e, s];

      const removedTopDown = [];
      const applied = [];

      // bottom-up apply
      for (let L = e; L >= s; L--) {
        const beforeNow = getVisualLines();
        const t = beforeNow[Math.max(0, Math.min(L, beforeNow.length) - 1)];
        const oldText = t?.text || "";
        removedTopDown.unshift(oldText);

        const r = _writeReplaceInternal(L, "");
        applied.push({ line: r.anchorLine, removedLines: r.removedLines, paper_rev: r.paper_rev });
      }

      // Override final diff to show a multi-line ghost (nice UX)
      _setDiff({
        anchorLine: s,
        removedText: null,
        removedLines: removedTopDown,
        highlightLines: [],
      });

      return {
        ok: true,
        op: "clear_range",
        startLine: s,
        endLine: e,
        appliedCount: applied.length,
        removedLines: removedTopDown,
        applied,
        paper_rev: paper.rev,
      };
    },

    clear_all() {
      const beforeVis = getVisualLines();
      const removedLines = beforeVis.map((v) => v.text || "");

      paper.text = "";
      paper.rev++;

      _setDiff({
        anchorLine: 1,
        removedText: null,
        removedLines,
        highlightLines: [],
      });

      return { ok: true, op: "clear_all", paper_rev: paper.rev, removedLinesCount: removedLines.length };
    },
  };

  return {
    actions,
    setCols(n) {
      if (Number.isFinite(n) && n >= 10 && n <= 120) paper.cols = Math.floor(n);
    },
    seed(text) {
      paper.text = String(text ?? "");
      paper.rev++;
      paper.diff = null;
    },
    clear() {
      paper.text = "";
      paper.rev++;
      paper.diff = null;
    },
    clearDiff,
    getState,
  };
}
