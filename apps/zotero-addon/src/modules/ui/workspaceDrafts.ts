type FormValues = Record<string, string>;

function valuesOf(root: HTMLElement): FormValues {
  const values: FormValues = {};
  for (const field of Array.from(
    root.querySelectorAll("input[id], textarea[id], select[id]"),
  ) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    values[field.id] = field.value;
  }
  for (const group of Array.from(
    root.querySelectorAll('[role="radiogroup"][id]'),
  ) as HTMLElement[]) {
    values[group.id] =
      group.querySelector<HTMLElement>('[aria-checked="true"]')?.dataset
        .value ?? "";
  }
  return values;
}

/** UI-only drafts: switching topics, filters or editor views never writes a note. */
export class WorkspaceFormDrafts {
  private values = new Map<string, FormValues>();
  private baselines = new WeakMap<HTMLElement, string>();

  remember(root: HTMLElement | null): void {
    const key = root?.dataset.draftKey;
    if (!root || !key) return;
    const values = valuesOf(root);
    if (JSON.stringify(values) === this.baselines.get(root))
      this.values.delete(key);
    else this.values.set(key, values);
  }

  restore(root: HTMLElement, key: string): void {
    root.dataset.draftKey = key;
    this.baselines.set(root, JSON.stringify(valuesOf(root)));
    const values = this.values.get(key);
    if (!values) return;
    const EventCtor = root.ownerDocument?.defaultView?.Event;
    for (const field of Array.from(
      root.querySelectorAll("input[id], textarea[id], select[id]"),
    ) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
      if (values[field.id] === undefined) continue;
      field.value = values[field.id];
      if (EventCtor)
        field.dispatchEvent(new EventCtor("input", { bubbles: true }));
    }
    for (const group of Array.from(
      root.querySelectorAll('[role="radiogroup"][id]'),
    ) as HTMLElement[]) {
      (Array.from(group.querySelectorAll("[data-value]")) as HTMLElement[])
        .find((option) => option.dataset.value === values[group.id])
        ?.click();
    }
  }

  clear(root: HTMLElement | null): void {
    if (!root?.dataset.draftKey) return;
    this.values.delete(root.dataset.draftKey);
    delete root.dataset.draftKey;
  }
}
