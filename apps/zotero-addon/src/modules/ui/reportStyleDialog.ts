import {
  DEFAULT_REPORT_STYLE,
  REPORT_STYLE_OPTIONS,
  type ReportStyle,
} from "@confucius/protocol";
import { getString } from "../../utils/locale";
import {
  bindDialogNavigation,
  createWorkspaceButton,
} from "./workspaceControls";

export function reportStyleLabel(style: Readonly<ReportStyle>): string {
  return Object.values(style)
    .map((value) => getString(`workspace-report-style-${value}`))
    .join(" · ");
}

export function reportStylePreview(style: Readonly<ReportStyle>): string {
  const prose = getString(
    `workspace-report-preview-${style.focus}-${style.tone}`,
  );
  const heading = getString(`workspace-report-preview-${style.focus}-title`);
  const main =
    style.layout === "parallel"
      ? `:::parallel\n> ${getString(`workspace-report-preview-${style.focus}-quote`)}\n\n${prose}\n:::`
      : style.layout === "sections"
        ? `### ${heading}\n\n${prose}`
        : prose;
  return `${main}\n\n:::details ${getString("workspace-report-preview-english-title")}\n${getString(`workspace-report-preview-${style.focus}-english`)}\n:::\n\n:::details ${getString("workspace-report-preview-help-title")}\n${getString(`workspace-report-preview-${style.focus}-help`)}\n:::`;
}

/** Owns its focus/lifetime, and stays open when persisting preferences fails. */
export function openReportStyleDialog(options: {
  parent: HTMLElement;
  initial?: ReportStyle;
  generating: boolean;
  fillAnswerHtml: (node: HTMLElement, markdown: string) => void;
  save: (style: ReportStyle) => Promise<void>;
}): { result: Promise<boolean>; close: () => void } {
  const doc = options.parent.ownerDocument;
  if (!doc) throw new Error("Report style dialog requires a document");
  const win = doc.defaultView;
  const el = (tag: string, className = "", text?: string) => {
    const node = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      tag,
    ) as HTMLElement;
    node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const selection = { ...(options.initial ?? DEFAULT_REPORT_STYLE) };
  const returnFocus = doc.activeElement as HTMLElement | null;
  const overlay = el("div", "confucius-dialog confucius-report-style-dialog");
  const panel = el("div", "confucius-dialog-panel");
  const title = el("h2", "", getString("workspace-report-style-title"));
  title.id = "confucius-report-style-title";
  overlay.setAttribute("aria-labelledby", title.id);
  const intro = el(
    "p",
    "confucius-report-style-intro",
    getString("workspace-report-style-intro"),
  );
  panel.append(title, intro);
  const groups = el("div", "confucius-report-style-groups");
  const buttons: HTMLButtonElement[] = [];
  const preview = el(
    "div",
    "tui-answer confucius-reading-surface confucius-report-style-preview",
  );
  const summary = el("p", "confucius-report-style-summary");
  summary.setAttribute("aria-live", "polite");
  let busy = false;
  let closed = false;
  let resolve!: (saved: boolean) => void;
  const result = new Promise<boolean>((done) => {
    resolve = done;
  });
  const finish = (saved = false) => {
    if (closed) return;
    closed = true;
    overlay.remove();
    win?.removeEventListener("unload", onUnload);
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    resolve(saved);
  };
  const onUnload = () => finish();
  const updatePreview = () => {
    summary.textContent = reportStyleLabel(selection);
    options.fillAnswerHtml(preview, reportStylePreview(selection));
  };
  for (const dimension of Object.keys(REPORT_STYLE_OPTIONS) as Array<
    keyof ReportStyle
  >) {
    const group = el("div", "confucius-report-style-group");
    const label = el(
      "h3",
      "",
      getString(`workspace-report-style-${dimension}`),
    );
    label.id = `confucius-report-style-${dimension}`;
    const hint = el(
      "span",
      "",
      getString(`workspace-report-style-${dimension}-hint`),
    );
    label.append(hint);
    const choices = el("div", "confucius-report-style-choices");
    choices.setAttribute("role", "radiogroup");
    choices.setAttribute("aria-labelledby", label.id);
    const groupButtons: HTMLButtonElement[] = [];
    for (const value of REPORT_STYLE_OPTIONS[dimension]) {
      const button = createWorkspaceButton(doc, "", "");
      button.classList.add("confucius-report-style-choice");
      button.dataset.value = value;
      button.setAttribute("role", "radio");
      const selected = selection[dimension] === value;
      button.setAttribute("aria-checked", String(selected));
      button.tabIndex = selected ? 0 : -1;
      const indicator = el("span", "confucius-report-style-radio");
      indicator.setAttribute("aria-hidden", "true");
      const copy = el("span");
      copy.append(
        el("strong", "", getString(`workspace-report-style-${value}`)),
        el(
          "span",
          "confucius-report-style-description",
          getString(`workspace-report-style-${value}-description`),
        ),
      );
      button.append(indicator, copy);
      button.addEventListener("click", () => {
        if (busy) return;
        Object.assign(selection, { [dimension]: value });
        for (const item of groupButtons) {
          item.setAttribute("aria-checked", String(item === button));
          item.tabIndex = item === button ? 0 : -1;
        }
        updatePreview();
      });
      choices.append(button);
      buttons.push(button);
      groupButtons.push(button);
    }
    choices.addEventListener("keydown", (event) => {
      const key = event as KeyboardEvent;
      if (
        busy ||
        key.isComposing ||
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(key.key)
      )
        return;
      const index = groupButtons.indexOf(
        doc.activeElement as HTMLButtonElement,
      );
      if (index < 0) return;
      key.preventDefault();
      const next =
        key.key === "Home"
          ? 0
          : key.key === "End"
            ? 2
            : (index + (["ArrowLeft", "ArrowUp"].includes(key.key) ? 2 : 1)) %
              3;
      groupButtons[next].click();
      groupButtons[next].focus();
    });
    group.append(label, choices);
    groups.append(group);
  }
  const sampleTitle = el(
    "p",
    "confucius-report-style-sample-title",
    getString("workspace-report-style-preview"),
  );
  const hint = el(
    "p",
    "confucius-report-style-hint",
    getString(
      options.generating
        ? "workspace-report-style-defer-hint"
        : "workspace-report-style-save-hint",
    ),
  );
  const error = el("p", "confucius-report-style-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const footer = el("div", "confucius-report-style-footer");
  const cancel = createWorkspaceButton(
    doc,
    "",
    getString(
      options.generating
        ? "workspace-report-style-later"
        : "workspace-settings-cancel",
    ),
  );
  const confirm = createWorkspaceButton(
    doc,
    "",
    getString(
      options.generating
        ? "workspace-report-style-generate"
        : "workspace-report-style-save",
    ),
    "primary",
  );
  cancel.addEventListener("click", () => finish());
  confirm.addEventListener("click", async () => {
    if (busy || closed) return;
    busy = true;
    error.hidden = true;
    [...buttons, cancel, confirm].forEach((button) => {
      button.disabled = true;
    });
    confirm.textContent = getString("workspace-report-style-saving");
    try {
      await options.save({ ...selection });
      finish(true);
    } catch (cause) {
      if (closed) return;
      busy = false;
      error.textContent = `${getString("workspace-report-style-save-failed")} ${String(cause)}`;
      error.hidden = false;
      [...buttons, cancel, confirm].forEach((button) => {
        button.disabled = false;
      });
      confirm.textContent = getString(
        options.generating
          ? "workspace-report-style-generate"
          : "workspace-report-style-save",
      );
      confirm.focus();
    }
  });
  footer.append(cancel, confirm);
  panel.append(groups, sampleTitle, summary, preview, hint, error, footer);
  overlay.append(panel);
  bindDialogNavigation(overlay, () => {
    if (!busy) finish();
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !busy) finish();
  });
  win?.addEventListener("unload", onUnload, { once: true });
  options.parent.append(overlay);
  updatePreview();
  buttons
    .find((button) => button.tabIndex === 0)
    ?.focus({ preventScroll: true });
  return { result, close: () => finish() };
}
