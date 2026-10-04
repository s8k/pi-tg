import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { blocksLen, blockCount, blocksToPlainText, chunkBlocks, foldBlocks, inlineToRichText, mdToBlocks, richTextLen, tailBlocks } from "../src/rich-blocks.ts";
import type { TgBlock, TgRichText } from "../src/rich-blocks.ts";

describe("richTextLen", () => {
  test("bare string: char length", () => {
    assert.equal(richTextLen("hello"), 5);
    assert.equal(richTextLen(""), 0);
  });
  test("sequence: sum of leaves", () => {
    assert.equal(richTextLen(["ab", "cd"]), 4);
    assert.equal(richTextLen([]), 0);
  });
  test("entity: length of inner text", () => {
    assert.equal(richTextLen({ type: "bold", text: "hi" }), 2);
    assert.equal(richTextLen({ type: "url", text: "t", url: "https://x.y" }), 1); // href not counted
  });
  test("deep nesting: recursive", () => {
    const rt: TgRichText = { type: "bold", text: ["a", { type: "italic", text: "bc" }] };
    assert.equal(richTextLen(rt), 3);
  });
  test("multibyte: JS string units (not bytes)", () => {
    assert.equal(richTextLen("абв"), 3);
    assert.equal(richTextLen("😀😀"), 4); // emoji = surrogate pair = 2 units each
  });
});

describe("blocksLen", () => {
  const P = (s: string): TgBlock => ({ type: "paragraph", text: s });

  test("paragraph: text length", () => {
    assert.equal(blocksLen([P("hello")]), 5);
  });
  test("heading: text length", () => {
    assert.equal(blocksLen([{ type: "heading", text: "abc", size: 2 }]), 3);
  });
  test("pre: string length", () => {
    assert.equal(blocksLen([{ type: "pre", text: "a\nb", language: "js" }]), 3);
  });
  test("divider: zero", () => {
    assert.equal(blocksLen([{ type: "divider" }]), 0);
  });
  test("list: sum of item blocks", () => {
    const b: TgBlock[] = [
      { type: "list", items: [
        { blocks: [P("ab")] },
        { blocks: [P("c"), P("de")] },
      ] },
    ];
    assert.equal(blocksLen(b), 5);
  });
  test("blockquote: inner blocks", () => {
    const b: TgBlock[] = [{ type: "blockquote", blocks: [P("abc")] }];
    assert.equal(blocksLen(b), 3);
  });
  test("details: summary + inner", () => {
    const b: TgBlock[] = [
      { type: "details", summary: "sum", blocks: [P("abc"), { type: "pre", text: "xy" }] },
    ];
    assert.equal(blocksLen(b), 3 + 3 + 2);
  });
  test("table: all cells", () => {
    const b: TgBlock[] = [
      {
        type: "table", is_bordered: true,
        cells: [
          [{ type: "bold", text: "h1" }, "h2"],
          ["a", { type: "italic", text: "bc" }],
        ],
      },
    ];
    assert.equal(blocksLen(b), 2 + 2 + 1 + 2);
  });
  test("thinking: text length", () => {
    assert.equal(blocksLen([{ type: "thinking", text: "Working…" }]), 8);
  });
  test("mixed array: additive", () => {
    assert.equal(blocksLen([P("ab"), { type: "divider" }, P("c")]), 3);
  });
});

describe("blockCount", () => {
  const P = (s: string): TgBlock => ({ type: "paragraph", text: s });

  test("top-level blocks count 1 each", () => {
    assert.equal(blockCount([P("a"), { type: "divider" }, P("c")]), 3);
  });
  test("list: block + one per item + item nesting", () => {
    const b: TgBlock[] = [
      { type: "list", items: [
        { blocks: [P("x")] },
        { blocks: [P("y"), P("z")] },
      ] },
    ];
    // 1 (list) + 2 (items) + 3 (item inner blocks)
    assert.equal(blockCount(b), 6);
  });
  test("blockquote: block + inner blocks", () => {
    const b: TgBlock[] = [{ type: "blockquote", blocks: [P("a"), P("b")] }];
    assert.equal(blockCount(b), 3);
  });
  test("details: block + inner blocks (docs: details content is counted)", () => {
    const b: TgBlock[] = [{ type: "details", summary: "s", blocks: [P("a")] }];
    assert.equal(blockCount(b), 2);
  });
  test("table: block + one per row", () => {
    const b: TgBlock[] = [{ type: "table", cells: [["a"], ["b"], ["c"]] }];
    assert.equal(blockCount(b), 4);
  });
  test("nested: details inside list item", () => {
    const b: TgBlock[] = [
      { type: "list", items: [
        { blocks: [{ type: "details", summary: "s", blocks: [P("x")] }] },
      ] },
    ];
    // 1 (list) + 1 (item) + 1 (details) + 1 (paragraph)
    assert.equal(blockCount(b), 4);
  });
});

const B = (t: TgRichText): TgRichText => ({ type: "bold", text: t });
const I = (t: TgRichText): TgRichText => ({ type: "italic", text: t });
const S = (t: TgRichText): TgRichText => ({ type: "strikethrough", text: t });
const M = (t: TgRichText): TgRichText => ({ type: "marked", text: t });
const SP = (t: TgRichText): TgRichText => ({ type: "spoiler", text: t });
const C = (t: TgRichText): TgRichText => ({ type: "code", text: t });
const U = (t: TgRichText, url: string): TgRichText => ({ type: "url", text: t, url });

describe("inlineToRichText", () => {
  test("plain string: bare string", () => {
    assert.deepEqual(inlineToRichText("hello"), "hello");
  });
  test("code span: content verbatim, no formatting inside", () => {
    assert.deepEqual(inlineToRichText("`a<b> & **x**`"), C("a<b> & **x**"));
    assert.deepEqual(inlineToRichText("x `a` y"), ["x ", C("a"), " y"]);
  });
  test("bold ** and __", () => {
    assert.deepEqual(inlineToRichText("**hi**"), B("hi"));
    assert.deepEqual(inlineToRichText("__hi__"), B("hi"));
  });
  test("italic * and _", () => {
    assert.deepEqual(inlineToRichText("*hi*"), I("hi"));
    assert.deepEqual(inlineToRichText("_hi_"), I("hi"));
  });
  test("strikethrough ~~", () => {
    assert.deepEqual(inlineToRichText("~~old~~"), S("old"));
  });
  test("==marked== and ||spoiler||", () => {
    assert.deepEqual(inlineToRichText("==new=="), M("new"));
    assert.deepEqual(inlineToRichText("||secret||"), SP("secret"));
  });
  test("link: [t](url) → {type:url, text, url}; text parsed recursively", () => {
    assert.deepEqual(inlineToRichText("[t](http://x/?a=1&b=2)"), U("t", "http://x/?a=1&b=2"));
    assert.deepEqual(inlineToRichText("[**b**](u)"), U(B("b"), "u"));
  });
  test("nested emphasis, both directions", () => {
    assert.deepEqual(inlineToRichText("**bold *ital* bold**"), B(["bold ", I("ital"), " bold"]));
    assert.deepEqual(inlineToRichText("*ital **bold** ital*"), I(["ital ", B("bold"), " ital"]));
  });
  test("intraword underscores stay literal (identifiers)", () => {
    assert.deepEqual(inlineToRichText("snake_case_name"), "snake_case_name");
    assert.deepEqual(inlineToRichText("foo__bar__"), "foo__bar__");
  });
  test("unmatched markers stay literal", () => {
    assert.deepEqual(inlineToRichText("*unterminated"), "*unterminated");
    assert.deepEqual(inlineToRichText("**no close"), "**no close");
  });
  test("samples: no entity ever left unbalanced (every open has a close by construction)", () => {
    const samples = ["a * b ** c ` d", "**bold *x", "100% * 2 ~ 3 _ v1.2_", "[broken](", "`unclosed", "==x", "||y"];
    const check = (rt: TgRichText): void => {
      if (typeof rt === "string") return;
      if (Array.isArray(rt)) { rt.forEach(check); return; }
      check(rt.text);
    };
    for (const s of samples) {
      const out = inlineToRichText(s);
      check(out); // never throws; structure always well-formed
      // and rendered text length <= source (nothing added)
      assert.ok(richTextLen(out) <= s.length, s);
    }
  });
  test("& < > are plain text, never structure", () => {
    assert.deepEqual(inlineToRichText("a < b & c > d"), "a < b & c > d");
  });
  test("code span with unmatched emphasis inside stays verbatim", () => {
    assert.deepEqual(inlineToRichText("`a * b`"), C("a * b"));
  });
  test("adjacent constructs sequence", () => {
    assert.deepEqual(inlineToRichText("**b** *i* `c`"), [B("b"), " ", I("i"), " ", C("c")]);
  });
});

describe("mdToBlocks", () => {
  test("empty → []", () => {
    assert.deepEqual(mdToBlocks(""), []);
    assert.deepEqual(mdToBlocks("\n\n"), []);
  });
  test("paragraph: plain + inline", () => {
    assert.deepEqual(mdToBlocks("hello world"), [{ type: "paragraph", text: "hello world" }]);
    assert.deepEqual(mdToBlocks("**b** and *i*"), [
      { type: "paragraph", text: [B("b"), " and ", I("i")] },
    ]);
  });
  test("multi-line paragraph joins with newline", () => {
    assert.deepEqual(mdToBlocks("a\nb"), [{ type: "paragraph", text: "a\nb" }]);
  });
  test("fence with language → pre", () => {
    assert.deepEqual(mdToBlocks("```js\nconst x = 1;\n```"), [
      { type: "pre", text: "const x = 1;", language: "js" },
    ]);
  });
  test("fence without language → pre, no language field", () => {
    assert.deepEqual(mdToBlocks("```\nx\n```"), [{ type: "pre", text: "x" }]);
  });
  test("unclosed fence at EOF → pre (streaming tail, the regression case)", () => {
    assert.deepEqual(mdToBlocks("```js\nconst x = 1;"), [
      { type: "pre", text: "const x = 1;", language: "js" },
    ]);
  });
  test("heading sizes 1-6", () => {
    assert.deepEqual(mdToBlocks("# H1"), [{ type: "heading", text: "H1", size: 1 }]);
    assert.deepEqual(mdToBlocks("###### H6"), [{ type: "heading", text: "H6", size: 6 }]);
  });
  test("heading text supports inline", () => {
    assert.deepEqual(mdToBlocks("## **Bold** head"), [
      { type: "heading", text: [B("Bold"), " head"], size: 2 },
    ]);
  });
  test("hr variants → divider", () => {
    for (const hr of ["---", "***", "___", "- - -"]) {
      assert.deepEqual(mdToBlocks(hr), [{ type: "divider" }], hr);
    }
  });
  test("unordered list → list items with inline text", () => {
    assert.deepEqual(mdToBlocks("- a\n- **b**"), [
      { type: "list", items: [
        { blocks: [{ type: "paragraph", text: "a" }] },
        { blocks: [{ type: "paragraph", text: B("b") }] },
      ] },
    ]);
  });
  test("ordered list → type '1' + value per item (spike-pinned)", () => {
    assert.deepEqual(mdToBlocks("1. one\n2. two\n3. three"), [
      { type: "list", items: [
        { blocks: [{ type: "paragraph", text: "one" }], type: "1", value: 1 },
        { blocks: [{ type: "paragraph", text: "two" }], type: "1", value: 2 },
        { blocks: [{ type: "paragraph", text: "three" }], type: "1", value: 3 },
      ] },
    ]);
  });
  test("GFM task-list items → has_checkbox / is_checked", () => {
    assert.deepEqual(mdToBlocks("- [ ] open\n- [x] done"), [
      { type: "list", items: [
        { blocks: [{ type: "paragraph", text: "open" }], has_checkbox: true, is_checked: false },
        { blocks: [{ type: "paragraph", text: "done" }, ], has_checkbox: true, is_checked: true },
      ] },
    ]);
  });
  test("indented continuation attaches to the previous list item (v1 flat lists)", () => {
    const blocks = mdToBlocks("- a\n  continued\n- b");
    const list = blocks[0];
    assert.equal(list.type, "list");
    if (list.type !== "list") return;
    assert.equal(list.items.length, 2);
    assert.deepEqual(list.items[0].blocks, [
      { type: "paragraph", text: "a" },
      { type: "paragraph", text: "continued" },
    ]);
  });
  test("blockquote → inner blocks recursively (consecutive lines = one soft-break paragraph)", () => {
    assert.deepEqual(mdToBlocks("> quoted\n> **bold** quote"), [
      { type: "blockquote", blocks: [
        { type: "paragraph", text: ["quoted\n", B("bold"), " quote"] },
      ] },
    ]);
  });
  test("blockquote: blank line splits inner paragraphs", () => {
    assert.deepEqual(mdToBlocks("> one\n>\n> **two**"), [
      { type: "blockquote", blocks: [
        { type: "paragraph", text: "one" },
        { type: "paragraph", text: B("two") },
      ] },
    ]);
  });
  test("blockquote with fence inside", () => {
    assert.deepEqual(mdToBlocks("> text\n> ```\n> code\n> ```"), [
      { type: "blockquote", blocks: [
        { type: "paragraph", text: "text" },
        { type: "pre", text: "code" },
      ] },
    ]);
  });
  test("GFM table → 2D cells, is_bordered, entity-wrapped", () => {
    const blocks = mdToBlocks("| h1 | h2 |\n| --- | --- |\n| a | b |");
    assert.equal(blocks.length, 1);
    const t = blocks[0];
    assert.equal(t.type, "table");
    if (t.type !== "table") return;
    assert.equal(t.is_bordered, true);
    assert.deepEqual(t.cells, [
      [{ type: "bold", text: "h1" }, { type: "bold", text: "h2" }],
      [{ type: "code", text: "a" }, { type: "code", text: "b" }],
    ]);
  });
  test("table cell with inline formatting keeps entities (object cell)", () => {
    const blocks = mdToBlocks("| h |\n| --- |\n| **x** |");
    const t = blocks[0];
    assert.equal(t.type, "table");
    if (t.type !== "table") return;
    assert.deepEqual(t.cells[1][0], B("x"));
  });
  test("<details> → details block, summary from <summary>, inner recursive", () => {
    const blocks = mdToBlocks("<details>\n<summary>⚙ read ✔</summary>\n\n```json\n{}\n```\n</details>");
    assert.equal(blocks.length, 1);
    const d = blocks[0];
    assert.equal(d.type, "details");
    if (d.type !== "details") return;
    assert.deepEqual(d.summary, "⚙ read ✔");
    assert.deepEqual(d.blocks, [{ type: "pre", text: "{}", language: "json" }]);
    assert.equal(d.is_open, undefined);
  });
  test("unclosed <details> → is_open true (streaming)", () => {
    const blocks = mdToBlocks("<details>\n<summary>⚙ run</summary>\n\nworking…");
    const d = blocks[0];
    assert.equal(d.type, "details");
    if (d.type !== "details") return;
    assert.equal(d.is_open, true);
  });
  test("details without <summary> line → summary from first line", () => {
    const blocks = mdToBlocks("<details>\nfirst line is summary\nbody here\n</details>");
    const d = blocks[0];
    assert.equal(d.type, "details");
    if (d.type !== "details") return;
    assert.deepEqual(d.summary, "first line is summary");
    assert.deepEqual(d.blocks, [{ type: "paragraph", text: "body here" }]);
  });
  test("unknown/inline-HTML lines → plain paragraph (total function)", () => {
    assert.deepEqual(mdToBlocks("<aside>note</aside>"), [
      { type: "paragraph", text: "<aside>note</aside>" },
    ]);
    assert.deepEqual(mdToBlocks("<bogus attr='x'>"), [
      { type: "paragraph", text: "<bogus attr='x'>" },
    ]);
  });
  test("never throws on arbitrary input (total)", () => {
    const nasty = [
      "``", "**", "__", "~~", "==", "||", "[", "](", "`",
      "###", "#no-space", "| only one pipe", "| a | b", "- -", "1.", "> ",
      "\u0000control\u0007", "mixed **bold `code` [l](u)~~",
    ].join("\n");
    const blocks = mdToBlocks(nasty); // must not throw
    assert.ok(Array.isArray(blocks));
    assert.ok(blocksLen(blocks) <= nasty.length + 10); // nothing invented
  });
  test("mixed document: paragraph + fence + hr + list", () => {
    const blocks = mdToBlocks("intro\n\n```\ncode\n```\n\n---\n\n- one");
    assert.deepEqual(blocks, [
      { type: "paragraph", text: "intro" },
      { type: "pre", text: "code" },
      { type: "divider" },
      { type: "list", items: [{ blocks: [{ type: "paragraph", text: "one" }] }] },
    ]);
  });
});

const PRE = (text: string, language?: string): TgBlock => language
  ? { type: "pre", text, language }
  : { type: "pre", text };

describe("foldBlocks", () => {
  test("short fence untouched", () => {
    const inB: TgBlock[] = [PRE("a\nb\n", "js")];
    assert.deepEqual(foldBlocks(inB, 5), inB.map((b) => ({ ...b })));
  });
  test("long fence → closed details, lang + line count in summary", () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const out = foldBlocks([PRE(body, "js")], 25);
    assert.equal(out.length, 1);
    const d = out[0];
    assert.equal(d.type, "details");
    if (d.type !== "details") return;
    assert.equal(d.is_open, false);
    assert.deepEqual(d.summary, "code, js (30 lines)");
    assert.deepEqual(d.blocks, [PRE(body, "js")]);
  });
  test("long fence without language → summary without lang", () => {
    const body = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const out = foldBlocks([PRE(body)], 25);
    const d = out[0];
    assert.equal(d.type, "details");
    if (d.type !== "details") return;
    assert.deepEqual(d.summary, "code (30 lines)");
  });
  test("non-pre blocks pass through untouched", () => {
    const inB: TgBlock[] = [{ type: "paragraph", text: "x" }, { type: "divider" }];
    assert.deepEqual(foldBlocks(inB, 1), inB);
  });
});

describe("tailBlocks", () => {
  const many = (n: number): TgBlock[] =>
    Array.from({ length: n }, (_, i) => ({ type: "paragraph", text: `p${i} `.padEnd(20, "x") }));

  test("under cap: untouched", () => {
    const inB = many(3);
    assert.deepEqual(tailBlocks(inB), inB);
  });
  test("over cap: suffix kept + leading ⋯ paragraph", () => {
    const inB = many(100);
    const out = tailBlocks(inB, 200);
    assert.equal(out[0]?.type, "paragraph");
    if (out[0]?.type !== "paragraph") return;
    assert.equal(out[0].text, "⋯");
    assert.ok(out.length < inB.length);
    assert.deepEqual(out[out.length - 1], inB[inB.length - 1]);
    assert.ok(blocksLen(out) <= 200);
  });
  test("thinking block (last) always kept", () => {
    const inB = [...many(100), { type: "thinking" as const, text: "Working…" }];
    const out = tailBlocks(inB, 200);
    assert.deepEqual(out[out.length - 1], { type: "thinking", text: "Working…" });
  });
  test("single oversized pre → hard-cut to last lines", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    const out = tailBlocks([PRE(body, "js")], 200);
    assert.equal(out[0]?.type, "paragraph");
    const pre = out[out.length - 1];
    assert.equal(pre.type, "pre");
    if (pre.type !== "pre") return;
    assert.equal(pre.language, "js");
    assert.ok(pre.text.length <= 200);
    assert.ok(pre.text.endsWith("line-199"));
  });
  test("over block budget: suffix kept within count", () => {
    const inB = many(600);
    const out = tailBlocks(inB, 1_000_000, 480);
    assert.ok(blockCount(out) <= 480);
    assert.equal(out[0]?.type, "paragraph");
  });
});

describe("chunkBlocks", () => {
  const P = (s: string): TgBlock => ({ type: "paragraph", text: s });

  test("fits in one chunk: no marker", () => {
    const out = chunkBlocks([P("a"), P("b")]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], [P("a"), P("b")]);
  });
  test("two chunks: second gets (continued) marker paragraph", () => {
    const big = P("x".repeat(100));
    const out = chunkBlocks([big, big], 150);
    assert.equal(out.length, 2);
    assert.equal(out[1][0]?.type, "paragraph");
    if (out[1][0]?.type !== "paragraph") return;
    assert.equal(out[1][0].text, "(continued)");
    assert.ok(blocksLen(out[1]) <= 150);
    assert.ok(blocksLen(out[0]) <= 150);
  });
  test("oversized pre splits at line boundaries, language re-emitted", () => {
    const body = Array.from({ length: 50 }, (_, i) => `line-${i} padding padding`).join("\n");
    const out = chunkBlocks([PRE(body, "py")], 200);
    assert.ok(out.length >= 2);
    for (const c of out) {
      for (const b of c) {
        if (b.type === "pre") {
          assert.equal(b.language, "py");
          assert.ok(blocksLen([b]) <= 200);
        }
      }
    }
    const all = out
      .flatMap((c) => c.filter((b): b is Extract<TgBlock, { type: "pre" }> => b.type === "pre").map((b) => b.text))
      .join("\n");
    assert.ok(all.includes("line-0"));
    assert.ok(all.includes("line-49"));
  });
  test("oversized table splits at row boundaries, header repeated", () => {
    const cells: TgRichText[][] = [
      [{ type: "bold", text: "h1" }, { type: "bold", text: "h2" }],
      ...Array.from({ length: 30 }, (_, i) => [
        { type: "code" as const, text: `row-${i}-aaaaaaaaaaaaaaaaaaaa` },
        { type: "code" as const, text: `data-${i}-bbbbbbbbbbbbbbbbbbbb` },
      ]),
    ];
    const out = chunkBlocks([{ type: "table", is_bordered: true, cells }], 200);
    assert.ok(out.length >= 2);
    for (const c of out) {
      for (const b of c) {
        if (b.type === "table") {
          assert.deepEqual(b.cells[0], cells[0]);
          assert.ok(blocksLen([b]) <= 200);
        }
      }
    }
  });
  test("oversized ordered list splits at item boundaries, value continuation", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      blocks: [P(`item-${i} aaaaaaaaaaaaa`)], type: "1" as const, value: i + 1,
    }));
    const out = chunkBlocks([{ type: "list", items }], 200);
    assert.ok(out.length >= 2);
    const lists = out.flatMap((c) => c.filter((b) => b.type === "list"));
    assert.equal(lists[1].items[0].value, lists[0].items.length + 1);
  });
  test("oversized details unwraps: summary becomes leading paragraph", () => {
    const inner = Array.from({ length: 40 }, (_, i) => P(`body-${i} aaaaaaaaaaaaa`));
    const out = chunkBlocks([{ type: "details", summary: "the summary", blocks: inner }], 200);
    assert.ok(out.length >= 1);
    const first = out[0][0];
    assert.equal(first?.type, "paragraph");
    if (first?.type !== "paragraph") return;
    assert.equal(first.text, "the summary");
    assert.ok(!out.flat().some((b) => b.type === "details"));
  });
  test("every chunk respects BOTH budgets", () => {
    const blocks: TgBlock[] = [];
    for (let i = 0; i < 300; i++) blocks.push(P(`para ${i} ${"z".repeat(50)}`));
    const out = chunkBlocks(blocks, 500, 40);
    for (const c of out) {
      assert.ok(blocksLen(c) <= 500, `len ${blocksLen(c)}`);
      assert.ok(blockCount(c) <= 40, `count ${blockCount(c)}`);
    }
  });
});

describe("blocksToPlainText", () => {
  const P = (s: string): TgBlock => ({ type: "paragraph", text: s });

  test("paragraph/heading", () => {
    assert.equal(blocksToPlainText([P("hello")]), "hello");
    assert.equal(blocksToPlainText([{ type: "heading", text: "T", size: 2 }]), "T");
  });
  test("pre: bare lines", () => {
    assert.equal(blocksToPlainText([PRE("a\nb", "js")]), "a\nb");
  });
  test("divider: line of dashes", () => {
    const out = blocksToPlainText([{ type: "divider" }]);
    assert.ok(/─{4,}/.test(out));
  });
  test("list: bullets, ordered numbers, checkboxes", () => {
    const out = blocksToPlainText([
      { type: "list", items: [
        { blocks: [P("a")] },
        { blocks: [P("b")], has_checkbox: true, is_checked: true },
      ] },
      { type: "list", items: [
        { blocks: [P("x")], type: "1", value: 3 },
      ] },
    ]);
    const lines = out.split("\n");
    assert.ok(lines[0].includes("a"));
    assert.ok(lines[1].includes("[x]") && lines[1].includes("b"));
    assert.ok(lines[2].startsWith("3."));
  });
  test("table: pipe rows", () => {
    const out = blocksToPlainText([
      { type: "table", is_bordered: true, cells: [
        [{ type: "bold", text: "h1" }, { type: "bold", text: "h2" }],
        [{ type: "code", text: "a" }, { type: "code", text: "b" }],
      ] },
    ]);
    const lines = out.split("\n");
    assert.ok(lines[0].includes("| h1") && lines[0].includes("h2 |"));
    assert.ok(lines[1].includes("| a") && lines[1].includes("b |"));
  });
  test("details: summary line + inner", () => {
    const out = blocksToPlainText([
      { type: "details", summary: "sum", blocks: [P("body")] },
    ]);
    const lines = out.split("\n");
    assert.equal(lines[0], "sum");
    assert.equal(lines[1], "body");
  });
  test("blockquote: inner text", () => {
    assert.equal(blocksToPlainText([{ type: "blockquote", blocks: [P("q")] }]), "q");
  });
  test("link entity: text (href)", () => {
    const out = blocksToPlainText([
      { type: "paragraph", text: [{ type: "url", text: "t", url: "http://x.y" }] },
    ]);
    assert.equal(out, "t (http://x.y)");
  });
  test("thinking: its text (defensive)", () => {
    assert.equal(blocksToPlainText([{ type: "thinking", text: "W" }]), "W");
  });
});
