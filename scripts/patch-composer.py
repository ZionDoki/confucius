import io

p = "apps/zotero-addon/src/modules/ui/WorkspaceView.ts"
s = io.open(p, encoding="utf-8").read()
orig = s

# ---------------------------------------------------------------- topbar slim
# remove mode + skill widgets from the topbar; they move into the composer "+" menu
s = s.replace(
    """  const modeBtn = button(doc, "confucius-mode", "Agent");
  modeBtn.style.background = "#6b645b";
  modeBtn.style.border = "1px solid #57514a";""",
    """  const modeBtn = button(doc, "confucius-mode", "Agent");
  modeBtn.style.display = "none";""",
)
s = s.replace(
    """  const skillSelect = el(
    doc,
    "select",
    {
      minWidth: "180px",
      height: "32px",
      border: "1px solid #c4bdb3",
      borderRadius: "6px",
      background: "#ffffff",
      color: "#1c1917",
      padding: "0 8px",
    },
    { id: "confucius-skill" },
  ) as HTMLSelectElement;
  const emptySkill = el(doc, "option", undefined, { value: "" });
  emptySkill.textContent = getString("workspace-no-skill");
  skillSelect.appendChild(emptySkill);
""",
    "",
)
s = s.replace("  topbar.appendChild(modeBtn);\n", "")
s = s.replace("  topbar.appendChild(skillSelect);\n", "")

# ---------------------------------------------------------------- composer
s = s.replace(
    """  const sendBtn = button(doc, "confucius-send", getString("workspace-send"));
  sendBtn.setAttribute("type", "submit");
  const stopBtn = button(doc, "confucius-stop", getString("workspace-stop"));
  composer.appendChild(prompt);
  composer.appendChild(sendBtn);
  composer.appendChild(stopBtn);
""",
    """  const sendBtn = button(doc, "confucius-send", getString("workspace-send"));
  sendBtn.setAttribute("type", "submit");
  const stopBtn = button(doc, "confucius-stop", getString("workspace-stop"));
  stopBtn.style.display = "none";
  stopBtn.style.background = "#8a5a12";
  stopBtn.style.border = "1px solid #6f470e";

  const plusBtn = el(
    doc,
    "button",
    {
      flex: "0 0 auto",
      background: "#6b645b",
      color: "#f6f3ec",
      border: "1px solid #57514a",
      borderRadius: "6px",
      width: "40px",
      height: "40px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "18px",
    },
    { id: "confucius-plus", type: "button", title: "Mode, skills, model" },
  );
  plusBtn.textContent = "+";

  const contextRing = buildContextRing(doc);

  composer.appendChild(plusBtn);
  composer.appendChild(prompt);
  composer.appendChild(contextRing.node);
  composer.appendChild(sendBtn);
  composer.appendChild(stopBtn);
""",
)

assert s != orig
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("composer shell updated")
