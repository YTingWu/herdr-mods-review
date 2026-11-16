// Review comments on a local diff, handed to an agent. No Herdr calls, so it stays testable.

// The diff rows behind a run of displayed rows. Side by side shows a pair per row;
// context appears on both sides of a pair but is one line.
function underlying(rows, split) {
  if (!split) return rows;
  const out = [];
  for (const row of rows) {
    if (row?.kind !== "pair") continue;
    if (row.left && row.left === row.right) out.push(row.left);
    else for (const side of [row.left, row.right]) if (side) out.push(side);
  }
  return out;
}

const SIGN = { "+": "+", "-": "-" };

/**
 * What a selection of displayed rows `[a, b]` (either order) covers: its lines as
 * a small diff, and the new- and old-side line ranges. Hunk headings are left out.
 * Null when nothing but headings is selected.
 */
export function selectionOf(rows, split, a, b) {
  const start = Math.max(0, Math.min(a, b));
  const end = Math.min(rows.length - 1, Math.max(a, b));
  const picked = underlying(rows.slice(start, end + 1), split).filter(
    (row) => row && row.kind !== "@" && row.kind !== "",
  );
  if (!picked.length) return null;
  const range = (key) => {
    const numbers = picked.map((row) => row[key]).filter((n) => typeof n === "number");
    return numbers.length ? [Math.min(...numbers), Math.max(...numbers)] : null;
  };
  return {
    lines: picked.map((row) => `${SIGN[row.kind] ?? " "}${row.text ?? ""}`),
    next: range("next"),
    old: range("old"),
  };
}

const span = ([a, b]) => (a === b ? `${a}` : `${a}-${b}`);

// "src/app.js:12-14", or the old side's lines when only removed lines are picked.
export function locationOf(comment) {
  if (comment.next) return `${comment.path}:${span(comment.next)}`;
  if (comment.old) return `${comment.path} (removed, was line ${span(comment.old)})`;
  return comment.path;
}

// Whether a diff row of this file carries one of these comments.
export function rowHasComment(comments, row) {
  if (!row) return false;
  return comments.some(
    (c) =>
      (c.next && typeof row.next === "number" && row.next >= c.next[0] && row.next <= c.next[1]) ||
      (!c.next && c.old && typeof row.old === "number" && row.old >= c.old[0] && row.old <= c.old[1]),
  );
}

const SCOPE = { staged: "staged", unstaged: "unstaged", committed: "committed, not pushed" };

// The one message an agent gets for every comment.
export function reviewMessage(root, comments) {
  const parts = [
    `Review comments on my local changes in ${root}. Each one quotes the lines it is about, as a diff (+ added, - removed). Please make the changes they ask for.`,
  ];
  comments.forEach((c, i) => {
    const fence = c.lines.some((line) => line.includes("```")) ? "````" : "```";
    parts.push(
      [
        `${i + 1}. ${locationOf(c)}${SCOPE[c.scope] ? ` (${SCOPE[c.scope]})` : ""}`,
        `${fence}diff`,
        ...c.lines,
        fence,
        c.body.trim(),
      ].join("\n"),
    );
  });
  return parts.join("\n\n");
}
