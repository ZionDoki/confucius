from __future__ import annotations

import argparse
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer


def build_fixture(output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="FixtureTitle",
            parent=styles["Title"],
            fontName="Helvetica-Bold",
            fontSize=24,
            leading=29,
            textColor=HexColor("#244A38"),
            spaceAfter=10 * mm,
        )
    )
    styles.add(
        ParagraphStyle(
            name="FixtureHeading",
            parent=styles["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=15,
            leading=19,
            textColor=HexColor("#2F5D45"),
            spaceBefore=5 * mm,
            spaceAfter=3 * mm,
        )
    )
    styles.add(
        ParagraphStyle(
            name="FixtureBody",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=11,
            leading=17,
            textColor=HexColor("#1C1917"),
            spaceAfter=4 * mm,
        )
    )
    styles.add(
        ParagraphStyle(
            name="FixtureQuote",
            parent=styles["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=12,
            leading=18,
            leftIndent=8 * mm,
            rightIndent=8 * mm,
            borderColor=HexColor("#8FBF7A"),
            borderWidth=1,
            borderPadding=8,
            backColor=HexColor("#EFF6F0"),
            textColor=HexColor("#244A38"),
            spaceBefore=4 * mm,
            spaceAfter=6 * mm,
        )
    )

    def footer(canvas, doc) -> None:
        canvas.saveState()
        canvas.setStrokeColor(HexColor("#D7D0C4"))
        canvas.line(22 * mm, 17 * mm, 188 * mm, 17 * mm)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(HexColor("#6B645B"))
        canvas.drawString(22 * mm, 11 * mm, "Confucius deterministic Zotero tool fixture")
        canvas.drawRightString(188 * mm, 11 * mm, f"Page {doc.page}")
        canvas.restoreState()

    story = [
        Paragraph("Confucius Tool Verification Paper", styles["FixtureTitle"]),
        Paragraph("Abstract", styles["FixtureHeading"]),
        Paragraph(
            "This deterministic paper exists solely to verify Zotero library, full-text, "
            "section, page, search, selection, and annotation tools. Its wording is stable "
            "so automated assertions can distinguish a real result from a guessed answer.",
            styles["FixtureBody"],
        ),
        Paragraph(
            "Confucius verifies real PDF highlighting.", styles["FixtureQuote"]
        ),
        Paragraph("1 Introduction", styles["FixtureHeading"]),
        Paragraph(
            "A reliable tool test needs a known document, a known phrase, and visible "
            "evidence in the reader. The token ALPHA-VERIFY-2026 appears only on page one. "
            "Searching for that token should return exactly this context.",
            styles["FixtureBody"],
        ),
        Paragraph(
            "The first page also establishes the expected author-independent metadata: "
            "a title, a 2026 date, and a synthetic DOI stored on the parent Zotero item.",
            styles["FixtureBody"],
        ),
        PageBreak(),
        Paragraph("2 Methodology", styles["FixtureHeading"]),
        Paragraph(
            "The verification sequence creates a collection and two bibliographic items, "
            "links them as related, writes and edits a child note, attaches this PDF, and "
            "then exercises every read tool against the resulting keys.",
            styles["FixtureBody"],
        ),
        Paragraph(
            "The exact phrase BETA-RECT-4242 is reserved for page-two text selection and "
            "highlight geometry checks. A genuine PDF highlight must appear over this text "
            "inside the Zotero reader; creating only a child note does not satisfy the test.",
            styles["FixtureQuote"],
        ),
        Paragraph("3 Results", styles["FixtureHeading"]),
        Paragraph(
            "A passing implementation reports structured tool results, persists intended "
            "writes, leaves rejected writes untouched, and exposes the same state through "
            "Zotero's visible interface. The matrix records pass, fail, and blocked outcomes.",
            styles["FixtureBody"],
        ),
        PageBreak(),
        Paragraph("4 Discussion", styles["FixtureHeading"]),
        Paragraph(
            "Fallback behavior must be labeled honestly. If annotation commit produces a "
            "note instead of a reader annotation, the tool transport works but PDF "
            "highlighting remains functionally incomplete.",
            styles["FixtureBody"],
        ),
        Paragraph(
            "The token GAMMA-FINAL-9000 appears on the final page for range and regex tests.",
            styles["FixtureBody"],
        ),
        Paragraph("5 Conclusion", styles["FixtureHeading"]),
        Paragraph(
            "This fixture is intentionally small, searchable, and visually plain enough "
            "that both code assertions and Computer Use can verify the same facts.",
            styles["FixtureBody"],
        ),
    ]

    document = SimpleDocTemplate(
        str(output),
        pagesize=A4,
        rightMargin=22 * mm,
        leftMargin=22 * mm,
        topMargin=22 * mm,
        bottomMargin=24 * mm,
        title="Confucius Tool Verification Paper",
        author="Confucius E2E",
        subject="Deterministic Zotero tool verification fixture",
    )
    document.build(story, onFirstPage=footer, onLaterPages=footer)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    build_fixture(arguments.output.resolve())


if __name__ == "__main__":
    main()
