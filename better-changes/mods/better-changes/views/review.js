// Review comments in the diff tab: pick lines, write a comment, collect them across
// files, then send them all to an agent in this space as one message.
// Comments live in shared("better-changes.comments")[<machine>|<repo root>], so every
// diff tab of a repository sees the same list.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState } from "gpui-base";
import { theme, shared, setShared, agents, hc, run } from "herdr";
import { selectionOf, locationOf, rowHasComment, reviewMessage } from "../git/review.js";
import { TEXT, Icon, IconButton, TextButton, TextBox, Menu, MenuLabel, MenuOption, Message } from "./ui.js";

const COMMENTS_KEY = "better-changes.comments";
const REVIEWABLE = ["staged", "unstaged", "committed"];

export const reviewMethods = {
  initReview(cx) {
    this.reviewSel = null; // { at, anchor, end }: rows of the diff shown when it was made
    this.reviewDraft = "";
    this.reviewTyping = false;
    this.reviewNote = null;
    this.sending = false;
    this.shiftDown = false;
    this.agentChoice = null;
    this.agentMenuOpen = false;
    this.agentMenuFocus = cx.focus_handle();
    this.reviewInput = TextareaState.new({ placeholder: "Comment on the selected lines…", rows: 3 });
    this.reviewInput.on("change", (_e, cx) => {
      this.reviewDraft = this.reviewInput.value();
      cx.notify();
    });
    this.reviewInput.on("focus", (_e, cx) => {
      this.reviewTyping = true;
      cx.notify();
    });
    this.reviewInput.on("blur", (_e, cx) => {
      this.reviewTyping = false;
      cx.notify();
    });
  },

  // Which diff is on screen: a selection belongs to one file, scope and layout.
  reviewAt() {
    return `${this.selection}|${this.diffLayout}`;
  },

  reviewable() {
    return Boolean(this.root && REVIEWABLE.includes(this.scope) && this.rows.length);
  },

  repoKey() {
    return `${this.on ?? ""}|${this.root}`;
  },

  allComments() {
    return (shared(COMMENTS_KEY) ?? {})[this.repoKey()] ?? [];
  },

  setComments(list) {
    const all = { ...(shared(COMMENTS_KEY) ?? {}) };
    if (list.length) all[this.repoKey()] = list;
    else delete all[this.repoKey()];
    setShared(COMMENTS_KEY, all);
  },

  fileComments() {
    return this.allComments().filter((c) => c.path === this.path && c.scope === this.scope);
  },

  shownRows() {
    return this.diffLayout === "split" ? (this.pairedRows ?? []) : this.rows;
  },

  // The rows [from, to] picked now, or null.
  selectedRange() {
    const s = this.reviewSel;
    if (!s || s.at !== this.reviewAt()) return null;
    return [Math.min(s.anchor, s.end), Math.max(s.anchor, s.end)];
  },

  isSelected(index) {
    const range = this.selectedRange();
    return Boolean(range && index >= range[0] && index <= range[1]);
  },

  // A click on a diff row: picks it, and with shift extends the pick to it.
  clickRow(key, cx) {
    if (!this.reviewable()) return;
    const index = Number(key);
    const row = this.shownRows()[index];
    if (!row || row.kind === "@" || (this.diffLayout === "split" && row.kind !== "pair")) return;
    const s = this.reviewSel;
    if (this.shiftDown && s && s.at === this.reviewAt()) this.reviewSel = { ...s, end: index };
    else this.reviewSel = { at: this.reviewAt(), anchor: index, end: index };
    this.reviewNote = null;
    this.reviewInput.focus();
    cx.notify();
  },

  cancelSelection(cx) {
    this.reviewSel = null;
    cx.notify();
  },

  addComment(cx) {
    const range = this.selectedRange();
    const body = this.reviewDraft.trim();
    if (!range || !body) return;
    const picked = selectionOf(this.shownRows(), this.diffLayout === "split", range[0], range[1]);
    if (!picked) return;
    this.setComments([
      ...this.allComments(),
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        path: this.path,
        scope: this.scope,
        ...picked,
        body,
      },
    ]);
    this.reviewDraft = "";
    this.reviewInput.set_value("");
    this.reviewSel = null;
    cx.notify();
  },

  removeComment(id, cx) {
    this.setComments(this.allComments().filter((c) => c.id !== id));
    cx.notify();
  },

  // Agents in this diff tab's space, the most recently active first.
  agentsHere() {
    return agents()
      .filter((a) => a.space === this.diffSpace)
      .sort((a, b) => b.seq - a.seq);
  },

  chosenAgent() {
    const list = this.agentsHere();
    return list.find((a) => a.address === this.agentChoice) ?? list[0] ?? null;
  },

  agentLabel(a) {
    return [a.program?.name ?? a.app ?? "Agent", a.tab_name].filter(Boolean).join(" · ");
  },

  // Sends every comment of this repository as one message, then drops the ones sent.
  sendComments(cx) {
    const comments = this.allComments();
    const agent = this.chosenAgent();
    if (!comments.length || !agent || this.sending) return;
    const root = this.root;
    const sent = new Set(comments.map((c) => c.id));
    this.sending = true;
    this.reviewNote = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["send", agent.address, reviewMessage(root, comments)]);
        if (r?.code !== 0) throw Error((r?.stderr || r?.stdout || "hc send failed").trim());
        // Comments written while it was sending stay.
        if (this.root === root) this.setComments(this.allComments().filter((c) => !sent.has(c.id)));
        run("pane.focus", { terminal: agent.address });
      } catch (error) {
        this.reviewNote = `Couldn't send: ${error.message}`;
      } finally {
        this.sending = false;
        cx.notify();
      }
    });
  },

  // ── Drawing ─────────────────────────────────────────────────────────────────

  // The marker column of a diff row: a dot where a comment is.
  commentMark(rowOrPair) {
    const t = theme();
    const comments = this.fileComments();
    const rows = rowOrPair?.kind === "pair" ? [rowOrPair.left, rowOrPair.right] : [rowOrPair];
    const marked = comments.length > 0 && rows.some((r) => rowHasComment(comments, r));
    return div()
      .w(10)
      .flex_none()
      .text_color(t.accent)
      .child(marked ? "●" : "");
  },

  renderReview() {
    const t = theme();
    const comments = this.allComments();
    const range = this.selectedRange();
    if (!this.reviewable() && !comments.length) return null;
    const box = v_flex()
      .id("review-box")
      .flex_none()
      .p(10)
      .gap(8)
      .border_t(1)
      .border_color(t.border)
      .text_size(TEXT.small);

    if (this.reviewNote)
      box.child(div().text_color(t.ansi1).whitespace_normal().child(this.reviewNote));

    if (range) box.child(this.renderComposer(range));
    else if (this.reviewable())
      box.child(
        div()
          .text_size(TEXT.caption)
          .text_color(t.dim)
          .child("Click a line (shift-click for a range) to comment on it."),
      );

    if (comments.length) {
      box.child(
        div()
          .text_size(TEXT.caption)
          .font_medium()
          .text_color(t.muted)
          .child(`Comments · ${comments.length}`),
      );
      box.child(
        v_flex()
          .id("review-comments")
          .max_h(150)
          .overflow_y_scroll()
          .gap(2)
          .children(comments.map((c) => this.renderComment(c))),
      );
      box.child(this.renderSendRow(comments.length));
    }
    return box;
  },

  renderComposer(range) {
    const t = theme();
    const picked = selectionOf(this.shownRows(), this.diffLayout === "split", range[0], range[1]);
    const where = picked ? locationOf({ path: this.path, ...picked }) : this.path;
    const canAdd = Boolean(picked && this.reviewDraft.trim());
    return v_flex()
      .gap(6)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(Icon("comment", 12).text_color(t.accent))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(where))
          .child(TextButton({ id: "review-cancel", label: "Cancel", onClick: (cx) => this.cancelSelection(cx) })),
      )
      .child(
        TextBox({
          id: "review-input",
          state: this.reviewInput,
          focused: this.reviewTyping,
          label: "Review comment",
          height: 64,
        }),
      )
      .child(
        h_flex()
          .justify_end()
          .child(
            this.ActionButton({
              id: "review-add",
              label: "Add comment",
              icon: "plus",
              enabled: canAdd,
              primary: false,
              onClick: (cx) => this.addComment(cx),
            }),
          ),
      );
  },

  renderComment(c) {
    const t = theme();
    return h_flex()
      .id(`comment-${c.id}`)
      .gap(8)
      .px(6)
      .py(3)
      .rounded(6)
      .items_start()
      .hover((s) => s.bg(t.hover))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().truncate().text_size(TEXT.caption).text_color(t.accent).child(locationOf(c)))
          .child(div().whitespace_normal().text_color(t.foreground).child(c.body)),
      )
      .child(
        IconButton({
          id: `comment-rm-${c.id}`,
          icon: "close",
          label: "Remove comment",
          small: true,
          onClick: (cx) => this.removeComment(c.id, cx),
        }),
      );
  },

  renderSendRow(count) {
    const t = theme();
    const list = this.agentsHere();
    const agent = this.chosenAgent();
    if (!agent)
      return Message("No agent in this space. Start one here to send these comments.");
    const trigger = h_flex()
      .id("review-agent")
      .h(26)
      .px(8)
      .gap(5)
      .min_w(0)
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(t.border)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .child(div().truncate().child(`To ${this.agentLabel(agent)}`))
      .child(Icon("chevron-down", 12));
    const menu = Menu({
      id: "review-agent-menu",
      open: this.agentMenuOpen,
      focus: this.agentMenuFocus,
      anchor: "bottom_left",
      width: 260,
      onOpenChange: (open, cx) => {
        this.agentMenuOpen = open;
        cx.notify();
      },
      trigger,
      children: [
        MenuLabel("Send to"),
        ...list.map((a) =>
          MenuOption({
            id: `review-agent-${a.address}`,
            icon: "send",
            label: this.agentLabel(a),
            selected: a.address === agent.address,
            onClick: (cx) => {
              this.agentChoice = a.address;
              this.agentMenuOpen = false;
              cx.notify();
            },
          }),
        ),
      ],
    });
    return h_flex()
      .gap(8)
      .items_center()
      .child(div().flex_1().min_w(0).child(menu))
      .child(
        this.ActionButton({
          id: "review-send",
          label: this.sending ? "Sending…" : `Send ${count} to agent`,
          icon: "send",
          enabled: !this.sending,
          primary: true,
          onClick: (cx) => this.sendComments(cx),
        }),
      );
  },

  ActionButton({ id, label, icon, enabled, primary, onClick }) {
    const t = theme();
    const solid = enabled && primary;
    return h_flex()
      .id(id)
      .h(28)
      .px(12)
      .gap(6)
      .flex_none()
      .items_center()
      .rounded(7)
      .bg(solid ? t.solid : t.raised)
      .text_color(solid ? t.solid_foreground : enabled ? t.foreground : t.dim)
      .when(enabled, (el) =>
        el
          .cursor_pointer()
          .hover((s) => (solid ? s.opacity(0.88) : s.bg(t.hover)))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            onClick(cx);
          }),
      )
      .child(Icon(icon, 12))
      .child(label);
  },
};
