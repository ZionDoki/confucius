// Fictional indicator values in ShowJCR's public journal-column formats.
// No JCR/CAS/Xinrui dataset is redistributed with these fixtures.
export const journalName = "ACM Transactions on Computer Systems";
export const csv = (rows) =>
  rows
    .map((row) =>
      row
        .map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`)
        .join(","),
    )
    .join("\r\n");
export function jcrCsv(year = 2025, name = journalName, quartile = "Q1") {
  return csv([
    [
      "Journal",
      "ISSN",
      "EISSN",
      "Web of Science",
      `IF(${year})`,
      "Category_1",
      `IF Quartile(${year})_1`,
      `IF Rank(${year})_1`,
      "Category_2",
      `IF Quartile(${year})_2`,
      `IF Rank(${year})_2`,
    ],
    [
      name,
      "0734-2071",
      "1557-7333",
      "SCIE",
      "2.1",
      "COMPUTER SCIENCE, THEORY & METHODS",
      quartile,
      "1/100",
      "ENGINEERING",
      "Q2",
      "21/100",
    ],
  ]);
}
export function casCsv(year = 2025) {
  return csv([
    [
      "Journal",
      "年份",
      "ISSN/EISSN",
      "Review",
      "OA Journal Index（OAJ）",
      "Open Access",
      "Web of Science",
      "标注",
      "大类",
      "大类分区",
      "Top",
      "小类1",
      "小类1分区",
      "小类2",
      "小类2分区",
    ],
    [
      journalName,
      year,
      "0734-2071/1557-7333",
      "否",
      "否",
      "否",
      "SCIE",
      "",
      "计算机科学",
      "2 [25/100]",
      "是",
      "COMPUTER SCIENCE, THEORY & METHODS 计算机：理论方法",
      "1 [1/100]",
      "ENGINEERING 工程",
      "3 [50/100]",
    ],
  ]);
}
export function xrCsv(year = 2026) {
  return csv([
    [
      "Journal",
      "年份",
      "预警标记",
      "刊名",
      "中文刊名",
      "CN",
      "ISSN",
      "EISSN",
      "出版机构",
      "语种",
      "期刊类型",
      "数据库",
      "标注",
      "大类英文名",
      "大类中文名",
      "大类新锐分区",
      "Top",
      "大类2英文名",
      "大类2中文名",
      "大类2新锐分区",
      "大类2Top",
      "小类1英文名",
      "小类1中文名",
      "小类1新锐分区",
      "小类2英文名",
      "小类2中文名",
      "小类2新锐分区",
    ],
    [
      journalName,
      year,
      "",
      journalName,
      "测试期刊",
      "",
      "0734-2071",
      "1557-7333",
      "Test publisher",
      "English",
      "",
      "Web of Science (SCIE)",
      "",
      "Computer Science",
      "计算机科学",
      "1 区",
      "是",
      "Engineering",
      "工程技术",
      "2 区",
      "否",
      "COMPUTER SCIENCE",
      "计算机",
      "2 区",
      "ENGINEERING",
      "工程",
      "3 区",
    ],
  ]);
}
