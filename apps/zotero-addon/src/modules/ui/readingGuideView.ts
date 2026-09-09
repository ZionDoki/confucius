import {
  type ArtifactRecord,
  type ArtifactRevision,
  type ReadingState,
  type ReadingDiscussionRecord,
  type ReadingGuide,
} from "@confucius/protocol";
import type { WorkspaceHost } from "./WorkspaceView";
import { configuredUiLanguage } from "../../utils/locale";
import { renderReadingSurface } from "./workspaceReading";
import { citationTarget } from "./readingCitations";
import { createWorkspaceButton } from "./workspaceControls";

export const readingLabel = (zh: string, en: string) =>
  configuredUiLanguage() === "en-US" ? en : zh;
const NS = "http://www.w3.org/1999/xhtml";
type ReadingRenderer = Parameters<typeof renderReadingSurface>[2];

/** One continuous article. Its private composer never writes to the artifact. */
export function mountReadingGuide(
  win: Window,
  root: HTMLElement,
  options: {
    artifact: ArtifactRecord;
    revision: ArtifactRevision;
    guide: ReadingGuide;
    floatingRoot: HTMLElement;
    state: ReadingState;
    host: WorkspaceHost;
    renderer: ReadingRenderer;
    change(patch: Partial<ReadingState>): void;
  },
): {
  dispose(): void;
  restorePosition(): void;
  capturePosition(): void;
  follow(checkpointId: string | undefined, move: boolean): void;
} {
  const { artifact, revision, guide, state, host, renderer } = options;
  const doc = win.document;
  let disposed = false;
  let stopDiscussion = () => {};
  const el = (tag: string, cls = "", text = "") => {
    const node = doc.createElementNS(NS, tag) as HTMLElement;
    node.className = cls;
    node.textContent = text;
    return node;
  };
  const md = (text: string) =>
    renderReadingSurface(
      doc,
      { type: "markdown", markdown: text },
      renderer,
      revision.citations,
    );
  const button = (label: string, action: () => void) => {
    const node = createWorkspaceButton(doc, "", label);
    node.addEventListener("click", action);
    return node;
  };
  const change = (patch: Partial<ReadingState>) => {
    if (disposed) return;
    Object.assign(state, patch);
    options.change(patch);
  };
  const scroller = doc.getElementById("confucius-artifact-dialog-body")!;
  const passageNodes = new Map<string, HTMLElement>();
  let pdfCheckpointId: string | undefined;
  let pinnedToPdf = false;
  const feedbackTimers = new Set<number>();
  let activeId = guide.checkpoints.some(
    (cp) => cp.id === state.discussionCheckpointId,
  )
    ? state.discussionCheckpointId!
    : guide.checkpoints[0].id;
  let selection: { checkpointId: string; text: string } | undefined;
  const dock = el("aside", "confucius-reading-discussion");
  dock.setAttribute(
    "aria-label",
    readingLabel("阅读问答", "Reading conversation"),
  );
  root.classList.add("confucius-reading-guide");
  const overview = el("div", "confucius-guide-overview");
  overview.append(md(guide.overview));
  root.append(overview);

  const markSummary = (cue: HTMLElement) => {
    const current = cue.dataset.checkpointId === pdfCheckpointId;
    cue.classList.toggle("is-pdf-current", current);
    if (current) cue.setAttribute("aria-current", "location");
    else cue.removeAttribute("aria-current");
    const status = cue.querySelector<HTMLElement>(".confucius-guide-current");
    if (status) status.hidden = !current;
  };
  const makeSummary = (cp: ReadingGuide["checkpoints"][number]) => {
    const cue = el("div", "confucius-guide-signpost");
    cue.dataset.checkpointId = cp.id;
    const heading = el("div", "confucius-guide-summary-heading");
    const section = el("span", "confucius-guide-section", cp.section ?? "");
    const status = el(
      "span",
      "confucius-guide-current",
      readingLabel("正在读", "Reading now"),
    );
    status.hidden = true;
    heading.append(section, status);
    const start = cp.citationIds
      .map((id) => revision.citations.find((c) => c.id === id))
      .filter((c) => !!c?.attachmentKey && !!c.page)
      .sort((a, b) => a!.page! - b!.page!)[0];
    if (start) {
      heading.append(
        el(
          "span",
          "confucius-guide-summary-location",
          readingLabel(`第 ${start.page} 页 ↗`, `p. ${start.page} ↗`),
        ),
      );
      const locate = () => {
        if (win.getSelection()?.toString()) return;
        cue.classList.add("is-pressed");
        const timer = win.setTimeout(() => {
          cue.classList.remove("is-pressed");
          feedbackTimers.delete(timer);
        }, 240);
        feedbackTimers.add(timer);
        void host
          .rpc("reader/open", {
            ...citationTarget(start),
            annotationKey: undefined,
          })
          .catch((error) => {
            const status = doc.getElementById("confucius-status");
            if (status) status.textContent = String(error);
          });
      };
      cue.tabIndex = 0;
      cue.setAttribute("role", "link");
      cue.title = readingLabel(
        `从论文第 ${start.page} 页阅读这一部分`,
        `Read this part from page ${start.page}`,
      );
      cue.addEventListener("click", (event) => {
        if ((event.target as Element)?.closest?.("button, a")) return;
        locate();
      });
      cue.addEventListener("keydown", (event) => {
        if (event.target !== cue) return;
        const key = event as KeyboardEvent;
        if (key.key === "Enter" || key.key === " ") {
          key.preventDefault();
          locate();
        }
      });
    }
    cue.append(heading, md(cp.before));
    markSummary(cue);
    return cue;
  };
  for (const cp of guide.checkpoints) {
    const passage = el("section", "confucius-guide-passage");
    passage.dataset.checkpointId = cp.id;
    passageNodes.set(cp.id, passage);
    const cue = makeSummary(cp);
    passage.append(cue);
    if (cp.kind === "checkpoint") {
      const excerpt = el("div", "confucius-guide-excerpt");
      const heading = el("h2", "confucius-guide-question", cp.title);
      excerpt.append(heading);
      for (const id of cp.citationIds) {
        const citation = revision.citations.find((c) => c.id === id);
        if (!citation) continue;
        const target = citationTarget(citation);
        const source = renderer.locateLink(doc, target);
        source.className = "confucius-guide-source-passage";
        source.addEventListener(
          "click",
          (event) => {
            if (win.getSelection()?.toString()) {
              event.preventDefault();
              event.stopImmediatePropagation();
            }
          },
          true,
        );
        source.replaceChildren();
        source.title = readingLabel(
          "在论文中阅读这一段",
          "Read this passage in the paper",
        );
        // The whole source excerpt is a location link, preserving its original language.
        source.append(
          el(
            "span",
            "confucius-guide-source-quote",
            citation.quote ?? cp.title,
          ),
        );
        source.append(
          el(
            "span",
            "confucius-guide-source-page",
            readingLabel(
              `第 ${citation.page ?? "?"} 页 ↗`,
              `p. ${citation.page ?? "?"} ↗`,
            ),
          ),
        );
        excerpt.append(source);
      }
      passage.append(excerpt);
      const prose = el("div", "confucius-guide-prose");
      prose.append(md(cp.reading ?? ""));
      passage.append(prose);
      const notes = el("div", "confucius-guide-notes");
      for (const [key, label, text] of [
        [
          "writing",
          readingLabel("作者怎么写的", "How this is written"),
          cp.writing,
        ],
        ["further", readingLabel("展开这一步", "A closer look"), cp.further],
        [
          "question",
          readingLabel("想一想", "A question to consider"),
          cp.question,
        ],
      ]) {
        if (!text) continue;
        const details = el(
          "details",
          "confucius-guide-note",
        ) as HTMLDetailsElement;
        const stateKey = `${cp.id}:${key}`;
        details.open = !!state.expanded[stateKey];
        details.append(el("summary", "", label), md(text));
        if (key === "question" && cp.hint) {
          const hint = el("details", "confucius-guide-note");
          hint.append(
            el("summary", "", readingLabel("提示", "Hint")),
            md(cp.hint),
          );
          details.append(hint);
        }
        details.addEventListener("toggle", () =>
          change({
            expanded: { ...state.expanded, [stateKey]: details.open },
            ...(key === "writing"
              ? { lens: details.open ? "writing" : "reading" }
              : {}),
          }),
        );
        notes.append(details);
      }
      passage.append(notes);
    }
    passage.addEventListener("click", () => {
      if (
        !win.getSelection()?.toString() &&
        !state.quote &&
        !(state.drafts[activeId] ?? "").trim()
      )
        activate(cp.id);
    });
    root.append(passage);
  }
  if (guide.annotationsMarkdown) {
    const details = el(
      "details",
      "confucius-guide-annotations",
    ) as HTMLDetailsElement;
    details.open = !!state.expanded.annotations;
    details.append(
      el(
        "summary",
        "",
        readingLabel("批注与未完成项", "Annotations and open items"),
      ),
      md(guide.annotationsMarkdown),
    );
    details.addEventListener("toggle", () =>
      change({ expanded: { ...state.expanded, annotations: details.open } }),
    );
    root.append(details);
  }
  root.append(dock);
  const quoteAction = button(readingLabel("引用", "Quote"), () => {
    if (!selection) return;
    const quote = selection;
    selection = undefined;
    quoteAction.hidden = true;
    change({ quote });
    activate(quote.checkpointId, true);
    win.getSelection()?.removeAllRanges();
    dock.querySelector("textarea")?.focus();
  });
  quoteAction.className = "confucius-guide-quote-action";
  quoteAction.hidden = true;
  quoteAction.addEventListener("mousedown", (e) => e.preventDefault());
  root.append(quoteAction);

  const activate = (id: string, force = false) => {
    if (!force && activeId === id) return;
    stopDiscussion();
    activeId = id;
    change({ discussionCheckpointId: id });
    dock.replaceChildren();
    stopDiscussion = mountDiscussion(dock, id);
  };
  const selectedPassage = (node: Node | null) => {
    const element =
      node?.nodeType === 1 ? (node as Element) : node?.parentElement;
    return element?.closest(
      ".confucius-guide-passage, .confucius-guide-signpost",
    ) as HTMLElement | null;
  };
  const showQuote = () => {
    const range = win.getSelection();
    const from = selectedPassage(range?.anchorNode ?? null);
    const to = selectedPassage(range?.focusNode ?? null);
    const text = range?.toString().trim();
    if (
      !text ||
      !from ||
      from.dataset.checkpointId !== to?.dataset.checkpointId ||
      (!root.contains(from) && !options.floatingRoot.contains(from))
    ) {
      quoteAction.hidden = true;
      selection = undefined;
      return;
    }
    selection = { checkpointId: from.dataset.checkpointId!, text };
    const rect = range!.getRangeAt(0).getBoundingClientRect();
    quoteAction.style.left = `${Math.min(win.innerWidth - 76, Math.max(12, rect.left + rect.width / 2 - 28))}px`;
    quoteAction.style.top = `${Math.max(56, rect.top - 40)}px`;
    quoteAction.hidden = false;
  };
  const hideQuote = () => {
    quoteAction.hidden = true;
  };
  doc.addEventListener("mouseup", showQuote);
  doc.addEventListener("keyup", showQuote);
  win.addEventListener("resize", hideQuote);
  let scrollTimer: number | undefined;
  const savePosition = () => {
    if (disposed) return;
    const top = scroller.getBoundingClientRect().top;
    const entries = [...passageNodes.entries()];
    const current =
      entries.find(([, n]) => n.getBoundingClientRect().bottom > top + 24) ??
      entries.at(-1);
    if (current)
      change({
        checkpointId: current[0],
        checkpointOffset: current[1].getBoundingClientRect().top - top,
      });
  };
  let floatingId: string | undefined;
  const updateFloating = () => {
    const top = scroller.getBoundingClientRect().top;
    const entry = [...passageNodes.entries()].find(
      ([, passage]) => passage.getBoundingClientRect().bottom > top + 12,
    );
    const cue = entry?.[1].querySelector(".confucius-guide-signpost");
    const nextId = pinnedToPdf
      ? pdfCheckpointId
      : entry && cue && cue.getBoundingClientRect().bottom <= top
        ? entry[0]
        : undefined;
    if (nextId === floatingId) return;
    floatingId = nextId;
    for (const [id, passage] of passageNodes)
      passage
        .querySelector(".confucius-guide-signpost")
        ?.classList.toggle("is-floating-origin", id === nextId);
    const floating = options.floatingRoot;
    floating.replaceChildren();
    floating.hidden = !nextId;
    if (nextId) {
      const cp = guide.checkpoints.find((cp) => cp.id === nextId)!;
      const summary = makeSummary(cp);
      summary.classList.add("is-floating");
      floating.append(summary);
    }
  };
  const releasePdfPin = () => {
    pinnedToPdf = false;
  };
  const onScrollKey = (event: KeyboardEvent) => {
    if (
      ![
        "ArrowUp",
        "ArrowDown",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " ",
      ].includes(event.key) ||
      (event.target as Element)?.closest?.(
        "input, textarea, button, [role=link]",
      )
    )
      return;
    releasePdfPin();
  };
  const onScrollPointer = (event: PointerEvent) => {
    if (event.target === scroller) releasePdfPin();
  };
  const onResize = () => {
    hideQuote();
    if (pinnedToPdf && pdfCheckpointId) {
      const cue = passageNodes
        .get(pdfCheckpointId)
        ?.querySelector(".confucius-guide-signpost");
      if (cue)
        scroller.scrollTop +=
          cue.getBoundingClientRect().bottom -
          scroller.getBoundingClientRect().top;
    }
    updateFloating();
  };
  win.addEventListener("resize", onResize);
  const onScroll = () => {
    hideQuote();
    updateFloating();
    win.clearTimeout(scrollTimer);
    scrollTimer = win.setTimeout(savePosition, 180);
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  scroller.addEventListener("wheel", releasePdfPin, { passive: true });
  scroller.addEventListener("touchmove", releasePdfPin, { passive: true });
  scroller.addEventListener("pointerdown", onScrollPointer);
  doc.addEventListener("keydown", onScrollKey);
  const mountDiscussion = (box: HTMLElement, checkpointId: string) => {
    let stopped = false,
      pending = false,
      initializing = true,
      failure = "",
      timer: number | undefined;
    let current: ReadingDiscussionRecord | null = null,
      shown: ReadingDiscussionRecord | null = null;
    let previous: ReadingDiscussionRecord[] = [];
    let sequence = -1;
    const historic = revision.revision !== artifact.revision;
    const heading = el("div", "confucius-discussion-heading");
    const scope = el(
      "span",
      "confucius-discussion-scope",
      guide.checkpoints.find((cp) => cp.id === checkpointId)?.title ?? "",
    );
    scope.title = readingLabel(
      "问答只保存在这段阅读中",
      "Questions stay in this reading branch",
    );
    const collapse = button("×", () => {
      textarea.focus();
      box.classList.remove("is-open");
    });
    collapse.setAttribute(
      "aria-label",
      readingLabel("收起问答", "Collapse conversation"),
    );
    heading.append(scope, collapse);
    box.append(heading);
    const versions = doc.createElementNS(NS, "select") as HTMLSelectElement;
    versions.setAttribute(
      "aria-label",
      readingLabel("问答所依据的版本", "Discussion source version"),
    );
    heading.append(versions);
    const messages = el("div", "confucius-discussion-messages");
    const status = el("div", "confucius-discussion-status");
    status.setAttribute("role", "status");
    const textarea = doc.createElementNS(NS, "textarea") as HTMLTextAreaElement;
    textarea.rows = 1;
    textarea.value = state.drafts[checkpointId] ?? "";
    textarea.placeholder = readingLabel(
      "划选文字引用，或直接问一句…",
      "Select text to quote, or ask a question…",
    );
    textarea.title = readingLabel(
      "追问保存在独立阅读分支",
      "Questions stay in a private reading branch",
    );
    textarea.setAttribute(
      "aria-label",
      readingLabel("向陪读提问", "Reading question"),
    );
    textarea.addEventListener("input", () => {
      change({ drafts: { ...state.drafts, [checkpointId]: textarea.value } });
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(108, textarea.scrollHeight)}px`;
    });
    textarea.addEventListener("keydown", (event) => {
      const e = event as KeyboardEvent;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void ask(false);
      }
    });
    textarea.addEventListener("focus", () => {
      if (shown?.messages.length) box.classList.add("is-open");
    });
    const quote = el("div", "confucius-discussion-quote");
    const quoteText = el("span");
    const clearQuote = button("×", () => {
      change({ quote: null });
      quote.hidden = true;
      textarea.focus();
    });
    clearQuote.setAttribute(
      "aria-label",
      readingLabel("移除引用", "Remove quote"),
    );
    quote.append(quoteText, clearQuote);
    const showQuote = () => {
      const selected =
        state.quote?.checkpointId === checkpointId ? state.quote : null;
      quote.hidden = !selected;
      quoteText.textContent = selected?.text ?? "";
    };
    showQuote();
    const controls = el("div", "confucius-discussion-controls");
    const send = button("↑", () => void ask(false));
    send.className = "confucius-discussion-send";
    send.setAttribute("aria-label", readingLabel("发送", "Send"));
    const resume = button(
      readingLabel("继续回答", "Continue answer"),
      () => void ask(true),
    );
    const stop = button(readingLabel("停止", "Stop"), () => {
      if (shown)
        void host
          .rpc("readingDiscussion/abort", {
            artifactId: artifact.id,
            discussionId: shown.id,
          })
          .then((result) => {
            if (!stopped) {
              shown = (result as { discussion: ReadingDiscussionRecord })
                .discussion;
              update();
            }
          })
          .catch(fail);
    });
    controls.append(resume, stop, send);
    const input = el("div", "confucius-discussion-input");
    input.append(textarea, controls);
    box.append(messages, status, quote, input);
    const fail = (error: unknown) => {
      if (!stopped) {
        failure = String(error);
        box.classList.add("is-open");
        status.textContent = failure;
      }
    };
    const editable = () => !historic && (!shown || shown.id === current?.id);
    const update = () => {
      if (stopped) return;
      const running = shown?.status === "running";
      send.disabled = initializing || pending || !!running || !editable();
      textarea.disabled = !editable();
      resume.hidden =
        !shown ||
        !["failed", "interrupted"].includes(shown.status) ||
        !editable();
      resume.disabled = pending;
      stop.hidden = !running;
      status.textContent =
        failure ||
        shown?.error ||
        (running
          ? readingLabel("正在回答…", "Answering…")
          : shown
            ? `${readingLabel("基于版本", "Based on revision")} ${shown.revision}${!editable() ? readingLabel(" · 历史问答", " · Earlier discussion") : ""}`
            : historic
              ? readingLabel(
                  "历史版本，请回到最新版本提问。",
                  "Return to the latest revision to ask a question.",
                )
              : "");
      if (shown && sequence === shown.sequence) return;
      sequence = shown?.sequence ?? -1;
      const atBottom =
        messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
      messages.replaceChildren();
      for (const message of shown?.messages ?? []) {
        const row = el("div", `confucius-discussion-message ${message.role}`);
        row.append(md(message.text));
        row.setAttribute(
          "aria-label",
          message.role === "user"
            ? readingLabel("你", "You")
            : readingLabel("陪读", "Companion"),
        );
        if (message.incomplete && !running)
          row.append(
            el("small", "", readingLabel("回答未完成", "Answer interrupted")),
          );
        messages.append(row);
      }
      if (atBottom) messages.scrollTop = messages.scrollHeight;
    };
    const fillVersions = () => {
      versions.replaceChildren();
      const latest = doc.createElementNS(NS, "option") as HTMLOptionElement;
      latest.value = current?.id ?? "";
      latest.textContent = readingLabel("当前段落", "Current checkpoint");
      versions.append(latest);
      for (const old of previous) {
        const option = doc.createElementNS(NS, "option") as HTMLOptionElement;
        option.value = old.id;
        option.textContent = `${readingLabel("基于版本", "Based on revision")} ${old.revision}`;
        versions.append(option);
      }
      versions.hidden = !previous.length;
    };
    versions.addEventListener("change", () => {
      shown =
        versions.value === current?.id || !versions.value
          ? current
          : (previous.find((d) => d.id === versions.value) ?? null);
      sequence = -1;
      update();
    });
    const ask = async (resuming: boolean) => {
      if (
        initializing ||
        pending ||
        shown?.status === "running" ||
        !editable() ||
        (!resuming && !textarea.value.trim())
      )
        return;
      const submittedText = textarea.value;
      const submittedQuote = state.quote;
      pending = true;
      failure = "";
      box.classList.add("is-open");
      update();
      try {
        if (!current) {
          const result = (await host.rpc("readingDiscussion/open", {
            artifactId: artifact.id,
            checkpointId,
            revision: revision.revision,
            create: true,
          })) as {
            discussion: ReadingDiscussionRecord;
            previous: ReadingDiscussionRecord[];
          };
          if (stopped) return;
          current = result.discussion;
          previous = result.previous;
          shown = current;
          fillVersions();
        }
        const result = (await host.rpc(
          resuming ? "readingDiscussion/continue" : "readingDiscussion/prompt",
          {
            artifactId: artifact.id,
            discussionId: current.id,
            text:
              submittedQuote?.checkpointId === checkpointId
                ? `${readingLabel("引用", "Quoted passage")}:\n> ${submittedQuote.text.replace(/\n/g, "\n> ")}\n\n${submittedText}`
                : submittedText,
          },
        )) as { discussion: ReadingDiscussionRecord };
        if (stopped) return;
        current = shown = result.discussion;
        if (!resuming && textarea.value === submittedText) {
          textarea.value = "";
          change({
            drafts: { ...state.drafts, [checkpointId]: "" },
            ...(state.quote === submittedQuote ? { quote: null } : {}),
          });
          showQuote();
        }
      } catch (error) {
        fail(error);
      } finally {
        pending = false;
        if (!stopped) update();
      }
    };
    const poll = async () => {
      try {
        if (shown?.status === "running") {
          const id = shown.id;
          const result = (await host.rpc("readingDiscussion/events", {
            artifactId: artifact.id,
            discussionId: id,
            afterSequence: sequence,
          })) as { discussion: ReadingDiscussionRecord };
          if (stopped || shown?.id !== id) return;
          shown = result.discussion;
          if (current?.id === id) current = shown;
          update();
        }
      } catch (error) {
        fail(error);
      } finally {
        if (!stopped) timer = win.setTimeout(() => void poll(), 600);
      }
    };
    void host
      .rpc("readingDiscussion/open", {
        artifactId: artifact.id,
        checkpointId,
        revision: revision.revision,
        create: false,
      })
      .then((result) => {
        if (stopped) return;
        const saved = result as {
          discussion: ReadingDiscussionRecord | null;
          previous: ReadingDiscussionRecord[];
        };
        initializing = false;
        current = shown = saved.discussion;
        previous = saved.previous;
        fillVersions();
        update();
        void poll();
      })
      .catch((error) => {
        initializing = false;
        fail(error);
        update();
      });
    update();
    return () => {
      stopped = true;
      if (timer !== undefined) win.clearTimeout(timer);
    };
  };
  activate(activeId, true);
  return {
    capturePosition: savePosition,
    follow(checkpointId, move) {
      const changed = pdfCheckpointId !== checkpointId;
      pdfCheckpointId = checkpointId;
      for (const passage of passageNodes.values())
        markSummary(
          passage.querySelector<HTMLElement>(".confucius-guide-signpost")!,
        );
      for (const cue of options.floatingRoot.querySelectorAll<HTMLElement>(
        ".confucius-guide-signpost",
      ))
        markSummary(cue);
      if (!checkpointId) {
        pinnedToPdf = false;
        updateFloating();
        return;
      }
      const passage = passageNodes.get(checkpointId);
      if (!passage || !move || (!changed && pinnedToPdf)) return;
      pinnedToPdf = true;
      updateFloating();
      const cue = passage.querySelector<HTMLElement>(
        ".confucius-guide-signpost",
      )!;
      const top =
        cue.getBoundingClientRect().bottom -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      scroller.scrollTo({
        top,
        behavior: win.matchMedia("(prefers-reduced-motion: reduce)")?.matches
          ? "instant"
          : "smooth",
      });
    },
    restorePosition() {
      const anchor = state.checkpointId && passageNodes.get(state.checkpointId);
      if (anchor && typeof state.checkpointOffset === "number")
        scroller.scrollTop +=
          anchor.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          state.checkpointOffset;
      updateFloating();
    },
    dispose() {
      if (disposed) return;
      savePosition();
      disposed = true;
      stopDiscussion();
      options.floatingRoot.replaceChildren();
      options.floatingRoot.hidden = true;
      win.clearTimeout(scrollTimer);
      for (const timer of feedbackTimers) win.clearTimeout(timer);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", releasePdfPin);
      scroller.removeEventListener("touchmove", releasePdfPin);
      scroller.removeEventListener("pointerdown", onScrollPointer);
      doc.removeEventListener("keydown", onScrollKey);
      win.removeEventListener("resize", onResize);
      doc.removeEventListener("mouseup", showQuote);
      doc.removeEventListener("keyup", showQuote);
      win.removeEventListener("resize", hideQuote);
    },
  };
}

export const READING_GUIDE_CSS = `
.confucius-reading-guide { line-height: var(--confucius-reading-line-height, 1.8); }
.confucius-guide-overview { color: var(--confucius-secondary); margin: 0 0 32px; }
.confucius-guide-passage { margin: 0 0 40px; scroll-margin-top: 28px; }
.confucius-guide-signpost { padding: 20px 24px; background: var(--confucius-surface); border: 1px solid transparent; border-radius: 10px; transition: background-color .18s, box-shadow .18s, border-color .18s, transform .18s; color: var(--confucius-secondary); }
.confucius-guide-signpost[role=link] { cursor: pointer; }
.confucius-guide-signpost.is-floating { background-color: color-mix(in srgb, var(--confucius-accent) 5%, var(--confucius-surface)); border-color: var(--confucius-line-strong); box-shadow: 0 5px 16px #00000010; }
.confucius-guide-signpost[role=link]:hover { background-color: color-mix(in srgb, var(--confucius-accent) 11%, var(--confucius-surface)); border-color: color-mix(in srgb, var(--confucius-accent) 42%, var(--confucius-line)); box-shadow: 0 6px 18px #00000012; transform: translateY(-1px); }
.confucius-guide-signpost.is-floating-origin { visibility: hidden; }
.confucius-guide-signpost.is-pdf-current { background-color: color-mix(in srgb, #e9b958 30%, var(--confucius-surface)); background-image: radial-gradient(ellipse at 18% 0%, color-mix(in srgb, var(--confucius-elevated) 40%, transparent), transparent 80%); border-color: color-mix(in srgb, #c08b30 68%, var(--confucius-line)); box-shadow: 0 0 0 1px #e7b34c20, 0 4px 16px #bc8b3224, 0 0 28px #efba4b30, inset 0 1px 0 #fff4ce66; }
.confucius-guide-signpost.is-pdf-current .confucius-reading-surface { color: var(--confucius-ink); }
.confucius-guide-signpost.is-pdf-current .confucius-guide-section { color: var(--confucius-accent-text); }
.confucius-guide-signpost.is-pdf-current:hover { background-color: color-mix(in srgb, #e9b958 40%, var(--confucius-surface)); box-shadow: 0 0 0 1px #e7b34c30, 0 6px 20px #bc8b3230, 0 0 32px #efba4b3b, inset 0 1px 0 #fff4ce66; }
.confucius-guide-signpost[role=link]:active, .confucius-guide-signpost[role=link].is-pressed { background-color: color-mix(in srgb, var(--confucius-accent) 26%, var(--confucius-surface)); background-image: none; border-color: var(--confucius-accent); box-shadow: inset 0 1px 3px #0000000f; transform: translateY(1px); }
.confucius-guide-signpost[role=link]:focus-visible { outline: 2px solid var(--confucius-accent); outline-offset: 3px; }
.confucius-guide-summary-heading { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; font-size: 11px; line-height: 1.5; color: var(--confucius-muted); }
.confucius-guide-section { flex: 1; min-width: 0; letter-spacing: .03em; overflow-wrap: anywhere; }
.confucius-guide-summary-location { white-space: nowrap; transition: color .18s; }
.confucius-guide-signpost:is(:hover, :focus-visible, .is-pdf-current) .confucius-guide-summary-location { color: var(--confucius-accent-text); }
.confucius-guide-signpost:is(:hover, :focus-visible) .confucius-guide-summary-location { text-decoration: underline; text-underline-offset: 3px; }
.confucius-guide-current { display: inline-flex; align-items: center; gap: 5px; color: var(--confucius-accent-text); white-space: nowrap; }
.confucius-guide-current::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #c28a24; box-shadow: 0 0 0 3px #eaba5540, 0 0 10px #e8ad39b3; }
.confucius-guide-current[hidden] { display: none; }
.confucius-guide-signpost .confucius-reading-surface { color: var(--confucius-secondary); }
.confucius-guide-signpost p:first-child, .confucius-guide-overview p:first-child { margin-top: 0; }
.confucius-guide-signpost p:last-child, .confucius-guide-overview p:last-child { margin-bottom: 0; }
.confucius-guide-excerpt { margin: 28px 0 22px; }
.confucius-guide-question { font-size: 1.12em; line-height: 1.6; font-weight: 600; margin: 0 0 16px; }
.confucius-artifact-window button.confucius-guide-source-passage { user-select: text; -moz-user-select: text; display: block; width: 100%; text-align: start; padding: 0 0 0 18px; margin: 18px 0; border: 0; border-inline-start: 2px solid var(--confucius-line-strong); border-radius: 0; background: transparent; color: var(--confucius-secondary); box-shadow: none; font-weight: 400; cursor: pointer; white-space: normal; }
.confucius-guide-source-quote { display: block; font-family: Georgia, "Times New Roman", serif; font-size: 1.05em; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.confucius-guide-source-page { display: block; margin-top: 8px; font: 11px/1.5 system-ui, sans-serif; color: var(--confucius-muted); }
.confucius-artifact-window button.confucius-guide-source-passage:hover { color: var(--confucius-ink); border-color: var(--confucius-accent); }
.confucius-guide-prose { overflow-wrap: anywhere; }
.confucius-guide-notes { margin-top: 20px; }
.confucius-guide-note { margin: 10px 0; }
.confucius-guide-note summary, .confucius-guide-annotations summary { cursor: pointer; font-size: .86em; color: var(--confucius-muted); }
.confucius-guide-note[open] { margin-bottom: 22px; }
.confucius-guide-note[open] > summary { margin-bottom: 14px; color: var(--confucius-secondary); }
.confucius-guide-annotations { margin: 60px 0 24px; padding-top: 20px; border-top: 1px solid var(--confucius-line); }
.confucius-reading-guide ::selection { background: var(--confucius-hover); }
.confucius-artifact-window button.confucius-guide-quote-action { position: fixed; z-index: 15; background: var(--confucius-ink); color: var(--confucius-paper); border: 0; border-radius: 5px; padding: 7px 14px; font-size: 12px; box-shadow: 0 3px 12px #0002; }
.confucius-reading-discussion { position: fixed; z-index: 10; width: min(600px, calc(100vw - 48px)); inset-inline-start: 50%; bottom: 20px; transform: translateX(-50%); background: var(--confucius-paper); border: 1px solid var(--confucius-line); border-radius: 12px; box-shadow: 0 6px 30px #0000000d; font-size: 13px; }
.confucius-discussion-heading { display: flex; align-items: center; gap: 10px; padding: 12px 16px 8px; color: var(--confucius-muted); font-size: 11px; }
.confucius-discussion-scope { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.confucius-reading-discussion:not(.is-open) :is(.confucius-discussion-heading, .confucius-discussion-messages, .confucius-discussion-status) { display: none; }
.confucius-discussion-messages { max-height: min(42vh, 360px); overflow-y: auto; padding: 4px 16px; }
.confucius-discussion-message { width: fit-content; max-width: 92%; margin: 12px 0; padding: 10px 14px; border-radius: 10px; background: var(--confucius-surface); overflow-wrap: anywhere; }
.confucius-discussion-message.user { margin-inline-start: auto; background: var(--confucius-hover); }
.confucius-discussion-message p:first-child { margin-top: 0; }
.confucius-discussion-message p:last-child { margin-bottom: 0; }
.confucius-discussion-status { font-size: 11px; color: var(--confucius-muted); padding: 2px 16px 4px; }
.confucius-discussion-status:empty { display: none; }
.confucius-discussion-quote { display: flex; align-items: center; gap: 12px; margin: 12px 16px 0; padding-inline-start: 10px; border-inline-start: 2px solid var(--confucius-accent); color: var(--confucius-muted); font-size: 12px; }
.confucius-discussion-quote span { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.confucius-discussion-input { display: flex; align-items: flex-end; padding: 10px 12px 10px 16px; gap: 8px; }
.confucius-reading-discussion textarea { display: block; flex: 1; min-width: 0; box-sizing: border-box; resize: none; font: inherit; line-height: 24px; height: 30px; min-height: 30px; max-height: 108px; padding: 3px 0; margin: 0; background: transparent; color: inherit; border: 0; outline: none; box-shadow: none; }
.confucius-reading-discussion textarea::placeholder { color: var(--confucius-muted); }
.confucius-discussion-controls { display: flex; align-items: center; gap: 8px; }
.confucius-artifact-window .confucius-reading-discussion button { border: 0; background: transparent; color: var(--confucius-muted); box-shadow: none; padding: 4px 6px; font-size: 12px; }
.confucius-artifact-window .confucius-reading-discussion .confucius-discussion-send { border-radius: 50%; width: 30px; height: 30px; padding: 0; background: var(--confucius-ink); color: var(--confucius-paper); font-size: 19px; }
.confucius-artifact-window .confucius-discussion-send:disabled { opacity: .25; }
.confucius-reading-discussion [hidden], .confucius-guide-quote-action[hidden] { display: none !important; }
@media (max-width: 600px) { .confucius-guide-signpost { padding: 20px; } .confucius-guide-passage { margin-bottom: 32px; } .confucius-reading-discussion { bottom: 12px; width: calc(100vw - 32px); } }
@media (prefers-reduced-motion: reduce) { .confucius-guide-signpost { transition: none; } .confucius-guide-signpost[role=link]:is(:hover, :active), .confucius-guide-signpost.is-pressed { transform: none; } }
`;
