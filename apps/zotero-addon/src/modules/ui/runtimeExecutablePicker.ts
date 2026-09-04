/** Open the platform file picker for an external Agent Runtime executable. */
export function pickRuntimeExecutable(
  win: Window,
  title: string,
): Promise<string | null> {
  const browsingContext = browsingContextFor(win);
  if (!browsingContext) {
    return Promise.reject(new Error("No browser context for the file picker"));
  }
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
    Ci.nsIFilePicker,
  );
  picker.init(browsingContext, title, 0 as nsIFilePicker.Mode);
  if (Services.appinfo.OS === "WINNT") {
    picker.appendFilter("Executable files", "*.exe;*.com;*.cmd");
  }
  picker.appendFilters(picker.filterAll ?? 0);
  return new Promise((resolve) => {
    picker.open((result) => {
      resolve(
        result === (picker.returnOK ?? 0) ? (picker.file?.path ?? null) : null,
      );
    });
  });
}

function browsingContextFor(win: Window): BrowsingContext | null {
  const direct = (win as unknown as { browsingContext?: BrowsingContext })
    .browsingContext;
  if (direct) return direct;
  return (
    (win.top as unknown as { browsingContext?: BrowsingContext } | null)
      ?.browsingContext ?? null
  );
}
