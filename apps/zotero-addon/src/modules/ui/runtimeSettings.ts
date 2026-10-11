import type {
  AgentBackendKind,
  ModelConfigView,
  RuntimeListResult,
  RuntimeStatus,
} from "@confucius/protocol";
import { getString } from "../../utils/locale";
import { createWorkspaceButton } from "./workspaceControls";
import { createOpenAlexSettings } from "./literaturePanel";
import { pickRuntimeExecutable } from "./runtimeExecutablePicker";

type Rpc = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;
type ExternalBackend = Exclude<AgentBackendKind, "native">;
const NS = "http://www.w3.org/1999/xhtml";

/** Shared Runtime page in workspace settings and Zotero preferences. */
export function createRuntimeSettings(
  doc: Document,
  rpc: Rpc,
  onChange?: (listed: RuntimeListResult) => void,
) {
  const node = (tag: string, className = "", text?: string) => {
    const item = doc.createElementNS(NS, tag) as HTMLElement;
    item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  const translations = new Map<HTMLElement, string>();
  const translate = (item: HTMLElement, key: string) => {
    translations.set(item, key);
    item.textContent = getString(key);
    return item;
  };
  const localizedNode = (tag: string, className: string, key: string) =>
    translate(node(tag, className), key);
  const root = node("section", "confucius-runtime-settings");
  root.append(
    localizedNode("p", "confucius-settings-help", "workspace-runtime-help"),
  );
  const hostRow = node("label", "confucius-runtime-host-row");
  const hostToggle = node("input") as HTMLInputElement;
  hostToggle.id = "confucius-runtime-host-enabled";
  hostToggle.type = "checkbox";
  const hostCopy = node("span");
  hostCopy.append(
    localizedNode("strong", "", "workspace-runtime-host-toggle"),
    localizedNode(
      "span",
      "confucius-settings-help",
      "workspace-runtime-host-help",
    ),
  );
  hostRow.append(hostToggle, hostCopy);
  const refreshButton = createWorkspaceButton(
    doc,
    "confucius-runtime-refresh",
    getString("workspace-runtime-refresh"),
  );
  translate(refreshButton, "workspace-runtime-refresh");
  const actions = node("div", "confucius-settings-actions");
  actions.append(refreshButton);
  const errorLine = node("p", "confucius-runtime-error");
  errorLine.setAttribute("role", "status");
  root.append(hostRow, actions, errorLine);
  const native = node("section", "confucius-runtime-card");
  const nativeTitle = localizedNode("h3", "", "workspace-runtime-native");
  const nativeStatus = node("span", "confucius-runtime-state");
  const nativeHeader = node("div", "confucius-runtime-header");
  const nativeHelp = node("p", "confucius-settings-help");
  nativeHeader.append(nativeTitle, nativeStatus);
  native.append(nativeHeader, nativeHelp);
  root.append(native);
  let listed: RuntimeListResult | undefined;
  let config: ModelConfigView | undefined;
  let busy = false;
  const editors = new Map<
    ExternalBackend,
    {
      status: HTMLElement;
      help: HTMLElement;
      version: HTMLElement;
      path: HTMLInputElement;
      auto: HTMLInputElement;
      manual: HTMLInputElement;
      pathRow: HTMLElement;
      current: HTMLElement;
      diagnostic: HTMLElement;
      checked: HTMLElement;
      apply: HTMLButtonElement;
      dirty: boolean;
    }
  >();

  const setBusy = (value: boolean) => {
    busy = value;
    root.setAttribute("aria-busy", String(value));
    for (const control of root.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >(
      ".confucius-runtime-card input, .confucius-runtime-card button, #confucius-runtime-host-enabled, #confucius-runtime-refresh",
    ))
      control.disabled = value;
  };
  const fail = (error: unknown) => {
    errorLine.textContent =
      error instanceof Error ? error.message : String(error);
  };
  const stateLabel = (state: RuntimeStatus["state"]) =>
    getString(`workspace-runtime-state-${state.replace(/_/g, "-")}`);
  const paint = () => {
    if (!listed) return;
    hostToggle.checked = listed.runtimeHostEnabled;
    nativeStatus.textContent = stateLabel(
      config?.configured ? "ready" : "unavailable",
    );
    nativeStatus.dataset.state = config?.configured ? "ready" : "unavailable";
    nativeHelp.textContent = config?.configured
      ? getString("workspace-runtime-native-ready")
      : getString("workspace-runtime-native-setup");
    for (const [backend, editor] of editors) {
      const runtime = listed.runtimes.find((item) => item.backend === backend);
      editor.status.textContent = listed.runtimeHostEnabled
        ? stateLabel(runtime?.state ?? "unavailable")
        : getString("workspace-runtime-disabled");
      editor.status.dataset.state = listed.runtimeHostEnabled
        ? (runtime?.state ?? "unavailable")
        : "unavailable";
      editor.version.textContent = runtime?.version ?? "";
      editor.apply.textContent = getString(
        listed.runtimeHostEnabled
          ? "workspace-runtime-apply-check"
          : "workspace-runtime-save-path",
      );
      editor.help.textContent = !listed.runtimeHostEnabled
        ? getString("workspace-runtime-host-disabled")
        : getString(
            `workspace-runtime-guide-${(runtime?.state ?? "unavailable").replace(/_/g, "-")}`,
          );
      if (!editor.dirty) {
        editor.path.value = runtime?.configuredExecutable ?? "";
        editor.manual.checked = Boolean(editor.path.value);
        editor.auto.checked = !editor.manual.checked;
      }
      editor.pathRow.hidden = editor.auto.checked;
      editor.current.textContent = runtime?.executable
        ? `${getString("workspace-runtime-resolved")}: ${runtime.executable}`
        : listed.runtimeHostEnabled
          ? getString("workspace-runtime-not-detected")
          : "";
      editor.diagnostic.textContent = listed.runtimeHostEnabled
        ? (runtime?.message ?? "")
        : "";
      editor.checked.textContent = runtime?.checkedAt
        ? `${getString("workspace-runtime-checked")}: ${new Date(runtime.checkedAt).toLocaleString()}`
        : "";
    }
    storage.textContent =
      config?.runtimeStoragePath ??
      getString("workspace-runtime-storage-unavailable");
    storageState.textContent =
      config?.storageStatus === "unsaved"
        ? getString("workspace-storage-unsaved")
        : "";
    onChange?.(listed);
  };
  const load = async (force: boolean) => {
    const results = await Promise.allSettled([
      rpc(force ? "runtime/refresh" : "runtime/list", {}),
      rpc("config/get", {}),
    ]);
    if (results[0].status === "rejected") throw results[0].reason;
    if (!root.isConnected) return;
    listed = results[0].value as RuntimeListResult;
    if (results[1].status === "fulfilled")
      config = results[1].value as ModelConfigView;
    else fail(results[1].reason);
    paint();
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    errorLine.textContent = "";
    try {
      await work();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  for (const backend of ["codex", "kimi"] as const) {
    const card = node("section", "confucius-runtime-card");
    const header = node("div", "confucius-runtime-header");
    const title = node("h3", "", backend === "codex" ? "Codex" : "Kimi");
    const version = node("span", "confucius-settings-help");
    const status = node(
      "span",
      "confucius-runtime-state",
      getString("workspace-runtime-checking"),
    );
    status.setAttribute("role", "status");
    header.append(title, version, status);
    const help = node("p", "confucius-settings-help");
    const details = node(
      "details",
      "confucius-settings-advanced",
    ) as HTMLDetailsElement;
    const summary = localizedNode("summary", "", "workspace-runtime-configure");
    details.append(summary);
    const choices = node("div", "confucius-settings-options");
    const radio = (mode: "auto" | "manual") => {
      const label = node("label", "confucius-runtime-path-mode");
      const input = node("input") as HTMLInputElement;
      input.type = "radio";
      input.name = `confucius-runtime-${backend}-mode`;
      input.id = `confucius-runtime-${backend}-${mode}`;
      input.checked = mode === "auto";
      label.append(
        input,
        localizedNode("span", "", `workspace-runtime-path-${mode}`),
      );
      choices.append(label);
      return input;
    };
    const auto = radio("auto"),
      manual = radio("manual");
    const pathRow = node("div", "confucius-runtime-path-row");
    pathRow.hidden = true;
    const path = node("input") as HTMLInputElement;
    path.id = `confucius-runtime-${backend}-path`;
    path.type = "text";
    path.placeholder = getString("workspace-runtime-path-manual-placeholder");
    path.setAttribute(
      "aria-label",
      getString(`workspace-runtime-${backend}-label`),
    );
    const browse = createWorkspaceButton(
      doc,
      `confucius-runtime-${backend}-browse`,
      getString("workspace-runtime-browse"),
    );
    translate(browse, "workspace-runtime-browse");
    pathRow.append(path, browse);
    const check = createWorkspaceButton(
      doc,
      `confucius-runtime-${backend}-save`,
      getString("workspace-runtime-apply-check"),
    );
    const checkRow = node("div", "confucius-settings-actions");
    checkRow.append(check);
    const current = node("p", "confucius-runtime-path confucius-settings-help");
    const diagnostic = node(
      "p",
      "confucius-runtime-path confucius-settings-help",
    );
    const checked = node("p", "confucius-settings-help");
    details.append(choices, pathRow, checkRow, current, diagnostic, checked);
    card.append(header, help, details);
    root.append(card);
    const editor = {
      status,
      help,
      version,
      path,
      auto,
      manual,
      pathRow,
      current,
      diagnostic,
      checked,
      apply: check,
      dirty: false,
    };
    editors.set(backend, editor);
    for (const input of [auto, manual])
      input.addEventListener("change", () => {
        editor.dirty = true;
        pathRow.hidden = auto.checked;
        if (manual.checked) path.focus();
      });
    path.addEventListener("input", () => {
      editor.dirty = true;
    });
    browse.addEventListener("click", () => {
      void run(async () => {
        const selected = await pickRuntimeExecutable(
          doc.defaultView!,
          getString(`workspace-runtime-${backend}-label`),
        );
        if (selected) {
          path.value = selected;
          editor.dirty = true;
          manual.checked = true;
          auto.checked = false;
          pathRow.hidden = false;
        }
      });
    });
    check.addEventListener("click", () => {
      if (busy) return;
      if (manual.checked && !path.value.trim()) {
        fail(new Error(getString("workspace-runtime-path-required")));
        path.focus();
        return;
      }
      void run(async () => {
        await rpc("runtime/configure", {
          backend,
          executable: auto.checked ? "" : path.value.trim(),
        });
        editor.dirty = false;
        await load(true);
      });
    });
  }
  const retrieval = node(
    "details",
    "confucius-settings-advanced",
  ) as HTMLDetailsElement;
  retrieval.append(localizedNode("summary", "", "workspace-runtime-retrieval"));
  let retrievalMounted = false;
  retrieval.addEventListener("toggle", () => {
    if (!retrieval.open || retrievalMounted) return;
    retrievalMounted = true;
    retrieval.append(createOpenAlexSettings(doc, rpc));
  });
  const advanced = node("details", "confucius-settings-advanced");
  const storage = node("p", "confucius-runtime-path");
  const storageState = node("p", "confucius-runtime-error");
  advanced.append(
    localizedNode("summary", "", "workspace-runtime-advanced"),
    localizedNode("h3", "", "workspace-runtime-storage"),
    storage,
    storageState,
  );
  root.append(retrieval, advanced);
  refreshButton.addEventListener("click", () => void run(() => load(true)));
  hostToggle.addEventListener("change", () => {
    void run(async () => {
      try {
        listed = (await rpc("runtime/setPluginHost", {
          enabled: hostToggle.checked,
        })) as RuntimeListResult;
        paint();
      } catch (error) {
        hostToggle.checked = listed?.runtimeHostEnabled ?? false;
        throw error;
      }
    });
  });
  return {
    element: root,
    refresh: (force = true) => run(() => load(force)),
    localize() {
      for (const [item, key] of translations) item.textContent = getString(key);
      for (const item of root.querySelectorAll<HTMLElement>(
        "[data-confucius-l10n]",
      ))
        item.textContent = getString(item.dataset.confuciusL10n!);
      for (const settings of root.querySelectorAll(
        ".confucius-venue-rating-settings",
      ))
        settings.dispatchEvent(
          new doc.defaultView!.Event("confucius-localize"),
        );
      for (const [backend, editor] of editors) {
        editor.path.placeholder = getString(
          "workspace-runtime-path-manual-placeholder",
        );
        editor.path.setAttribute(
          "aria-label",
          getString(`workspace-runtime-${backend}-label`),
        );
      }
      paint();
    },
  };
}
