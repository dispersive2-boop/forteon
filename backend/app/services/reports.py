"""Генерация отчётов PDF и XLSX (раздел 10 спецификации).

Отчёты строятся из проверенных структурированных данных. AI может лишь
редактировать текстовую сводку — не участвует в расчётах сумм.
"""
from __future__ import annotations

import io
from datetime import date, datetime
from decimal import Decimal
from math import isfinite
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Client, Invoice, Payment, PaymentAllocation, Project, Task, utcnow

FONT_CANDIDATES = (
    ("DejaVuSans", ("C:/Windows/Fonts/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")),
    ("Arial", ("C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf")),
)

_font_name: str | None = None
_font_bold: str | None = None


def register_fonts() -> tuple[str | None, str | None]:
    global _font_name, _font_bold
    if _font_name:
        return _font_name, _font_bold
    for name, candidates in FONT_CANDIDATES:
        for candidate in candidates:
            if Path(candidate).exists():
                try:
                    pdfmetrics.registerFont(TTFont(name, candidate))
                    bold_candidate = candidate.replace("Sans.ttf", "Sans-Bold.ttf").replace(
                        "arial.ttf", "arialbd.ttf"
                    ).replace("Regular", "Bold")
                    if Path(bold_candidate).exists():
                        pdfmetrics.registerFont(TTFont(name + "-Bold", bold_candidate))
                        _font_bold = name + "-Bold"
                    else:
                        _font_bold = name
                    _font_name = name
                    return _font_name, _font_bold
                except Exception:
                    continue
    _font_name = "Helvetica"
    _font_bold = "Helvetica-Bold"
    return _font_name, _font_bold


def _fmt_money(value: float | Decimal | None) -> str:
    if value is None or not isfinite(value):
        return "—"
    amount = round(value, 2)
    grouped, _, kopecks = f"{amount or 0:,.2f}".partition(".")
    rubles = grouped.replace(",", "\u00a0")
    fraction = f",{kopecks}" if kopecks != "00" else ""
    return f"{rubles}{fraction}\u00a0₽"


def _fmt_date(value: date | datetime | None) -> str:
    if value is None:
        return "—"
    if isinstance(value, datetime):
        return value.strftime("%d.%m.%Y %H:%M")
    return value.strftime("%d.%m.%Y")


def collect_data(
    db: Session,
    owner_id: str,
    is_admin: bool,
    client_id: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> list[dict]:
    client_query = select(Client).where(Client.deleted_at.is_(None))
    if not is_admin:
        client_query = client_query.where(Client.owner_id == owner_id)
    if client_id:
        client_query = client_query.where(Client.id == client_id)

    clients = list(db.scalars(client_query.order_by(Client.name)))
    rows: list[dict] = []
    for client in clients:
        projects = list(
            db.scalars(select(Project).where(Project.client_id == client.id, Project.deleted_at.is_(None)))
        )
        tasks_query = select(Task).where(Task.client_id == client.id, Task.deleted_at.is_(None))
        tasks = list(db.scalars(tasks_query))
        if date_from:
            tasks = [t for t in tasks if t.due_date is None or t.due_date >= date_from]
        if date_to:
            tasks = [t for t in tasks if t.due_date is None or t.due_date <= date_to]

        invoices = list(db.scalars(select(Invoice).where(Invoice.client_id == client.id)))
        payments = list(db.scalars(select(Payment).where(Payment.client_id == client.id)))
        allocations = list(
            db.scalars(
                select(PaymentAllocation).where(
                    PaymentAllocation.invoice_id.in_([i.id for i in invoices] or ["-"])
                )
            )
        )
        billed = sum(float(i.amount or 0) for i in invoices if i.status != "void")
        paid = sum(float(p.amount or 0) for p in payments)
        allocated = sum(float(a.amount or 0) for a in allocations)

        open_tasks = [t for t in tasks if t.status == "open"]
        overdue = [t for t in open_tasks if t.due_date and t.due_date < date.today()]
        done = [t for t in tasks if t.status == "done"]

        rows.append(
            {
                "client": client,
                "projects": projects,
                "tasks": tasks,
                "open_tasks": open_tasks,
                "overdue": overdue,
                "done": done,
                "billed": billed,
                "paid": paid,
                "allocated": allocated,
                "debt": round(billed - allocated, 2),
            }
        )
    return rows


# ------------------------------------------------------------------ XLSX
HEADER_FILL = PatternFill("solid", fgColor="151B29")
HEADER_FONT = Font(color="FFFFFF", bold=True, size=11)
THIN = Side(style="thin", color="D7DEEA")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def _sheet(ws, title: str, headers: list[str], widths: list[int]) -> None:
    ws.title = title
    ws.append(headers)
    for idx, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = width
    for cell in ws[1]:
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.border = BORDER
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"


def build_xlsx(
    db: Session,
    rows: list[dict],
    period_label: str,
    sections: list[str] | None = None,
) -> bytes:
    """XLSX. sections ограничивает листы составом отчёта (§7, п.88)."""
    wanted = set(sections or ["projects", "tasks", "finance"])
    wb = Workbook()

    ws_clients = wb.active
    _sheet(ws_clients, "Клиенты",
           ["Клиент", "Тип", "Статус", "Адрес", "Проектов", "Открытых задач", "Просрочено", "Долг, ₽"],
           [34, 12, 14, 30, 10, 16, 12, 14])
    for row in rows:
        c = row["client"]
        ws_clients.append([
            c.name, "Юрлицо" if c.type == "legal" else "Физлицо", c.status, c.address or "—",
            len(row["projects"]), len(row["open_tasks"]), len(row["overdue"]), round(row["debt"], 2),
        ])

    if "projects" in wanted:
        ws_projects = wb.create_sheet("Проекты")
        _sheet(ws_projects, "Проекты",
               ["Клиент", "Объект", "Статус", "Расположение", "Дата в работе", "Объём",
                "Плановый доход, ₽", "Ожидаемая прибыль, ₽", "Сервис", "Следующий спринт", "Проблемы"],
               [26, 34, 16, 20, 14, 12, 21, 23, 12, 34, 34])
        for row in rows:
            for p in row["projects"]:
                ws_projects.append([
                    row["client"].name, p.name, p.status, p.location or "—", p.start_date, p.volume,
                    float(p.planned_revenue) if p.planned_revenue is not None else None,
                    p.expected_profit, p.service_flag or "—", p.plan_next_sprint or "—", p.problems_text or "—",
                ])
                for column in (7, 8):
                    ws_projects.cell(ws_projects.max_row, column).number_format = '#,##0.00" ₽"'

    if "tasks" in wanted:
        ws_tasks = wb.create_sheet("Задачи")
        _sheet(ws_tasks, "Задачи",
               ["Клиент", "Задача", "Тип", "Приоритет", "Статус", "Срок", "Источник", "Требует уточнения"],
               [26, 46, 12, 12, 12, 16, 12, 18])
        for row in rows:
            for t in row["tasks"]:
                ws_tasks.append([
                    row["client"].name, t.title, t.type, t.priority, t.status,
                    t.due_date, "AI" if t.origin == "ai" else ("Импорт" if t.origin == "import" else "Вручную"),
                    "да" if t.needs_review else "нет",
                ])

    if "finance" in wanted:
        ws_fin = wb.create_sheet("Финансы")
        _sheet(ws_fin, "Финансы",
               ["Клиент", "Выставлено, ₽", "Оплачено, ₽", "Распределено, ₽", "Долг, ₽"],
               [34, 18, 18, 18, 18])
        for row in rows:
            ws_fin.append([row["client"].name, round(row["billed"], 2), round(row["paid"], 2),
                           round(row["allocated"], 2), round(row["debt"], 2)])

        ws_problems = wb.create_sheet("Проблемы")
        _sheet(ws_problems, "Проблемы",
               ["Клиент", "Объект", "Проблема", "Ответственный", "Срок"],
               [26, 30, 50, 22, 14])
        for row in rows:
            for p in row["projects"]:
                if not p.problems_text:
                    continue
                ws_problems.append([row["client"].name, p.name, p.problems_text, "—", p.end_date])

    ws_info = wb.create_sheet("Сведения")
    _sheet(ws_info, "Сведения", ["Параметр", "Значение"], [34, 60])
    ws_info.append(["Период", period_label])
    ws_info.append(["Выгрузка", datetime.now().strftime("%d.%m.%Y %H:%M")])
    ws_info.append(["Приложение", "ForteOn MVP"])
    ws_info.append(["Клиентов", len(rows)])
    ws_info.append(["Проектов", sum(len(r["projects"]) for r in rows)])
    ws_info.append(["Задач", sum(len(r["tasks"]) for r in rows)])

    for ws in wb.worksheets:
        for column in ws.columns:
            for cell in column:
                cell.border = BORDER
                cell.alignment = Alignment(vertical="top", wrap_text=True)

    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


# ------------------------------------------------------------------ PDF
def build_pdf(
    db: Session,
    rows: list[dict],
    period_label: str,
    scope_label: str,
    sections: list[str] | None = None,
) -> bytes:
    """PDF для совещания. sections убирает лишние блоки (§7, п.88)."""
    wanted = set(sections or ["projects", "tasks", "finance"])
    font, font_bold = register_fonts()
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title="ForteOn · Сводный отчёт",
    )

    styles = getSampleStyleSheet()
    base = ParagraphStyle("Base", parent=styles["Normal"], fontName=font, fontSize=8.5, leading=11,
                          alignment=TA_LEFT, textColor=colors.HexColor("#172033"))
    h1 = ParagraphStyle("H1", parent=base, fontName=font_bold, fontSize=16, leading=20,
                        textColor=colors.HexColor("#151B29"), spaceAfter=4)
    h2 = ParagraphStyle("H2", parent=base, fontName=font_bold, fontSize=11.5, leading=15,
                        textColor=colors.HexColor("#2455DB"), spaceBefore=8, spaceAfter=4)
    small = ParagraphStyle("Small", parent=base, fontSize=7.5, leading=10,
                           textColor=colors.HexColor("#63718B"))

    story = [
        Paragraph("ForteOn · Сводный отчёт", h1),
        Paragraph(f"{scope_label} · {period_label} · выгрузка {datetime.now().strftime('%d.%m.%Y %H:%M')}", small),
        Spacer(1, 6),
    ]

    total_billed = sum(r["billed"] for r in rows)
    total_debt = sum(r["debt"] for r in rows)
    total_open = sum(len(r["open_tasks"]) for r in rows)
    total_overdue = sum(len(r["overdue"]) for r in rows)
    total_done = sum(len(r["done"]) for r in rows)

    kpi_data = [
        ["Клиентов", "Проектов", "Открытых задач", "Просрочено", "Выполнено",
         "Выставлено", "Задолженность"],
        [
            str(len(rows)),
            str(sum(len(r["projects"]) for r in rows)),
            str(total_open),
            str(total_overdue),
            str(total_done),
            _fmt_money(total_billed),
            _fmt_money(total_debt),
        ],
    ]
    kpi = Table(kpi_data, colWidths=[24 * mm] * 6 + [32 * mm])
    kpi.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#151B29")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, -1), font),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("BACKGROUND", (0, 1), (-1, 1), colors.HexColor("#F7F9FC")),
        ("BACKGROUND", (5, 1), (5, 1), colors.HexColor("#EAF1FF")),
        ("BACKGROUND", (6, 1), (6, 1), colors.HexColor("#FDECEE")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D7DEEA")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(kpi)

    if "projects" in wanted:
        story.append(Paragraph("Клиенты и проекты", h2))
        table_rows = [["Клиент", "Объект", "Статус", "Расположение", "План, ₽", "Ожид. прибыль, ₽",
                       "Задачи", "Просрочено", "Долг, ₽", "Проблемы"]]
        for row in rows:
            if not row["projects"]:
                table_rows.append([row["client"].name, "—", row["client"].status, row["client"].address or "—",
                                   "—", "—", str(len(row["open_tasks"])), str(len(row["overdue"])),
                                   _fmt_money(row["debt"]), "—"])
                continue
            for p in row["projects"]:
                table_rows.append([
                    Paragraph(row["client"].name[:40], base),
                    Paragraph((p.name or "—")[:44], base),
                    Paragraph((p.status or "—")[:22], base),
                    Paragraph((p.location or "—")[:24], base),
                    _fmt_money(p.planned_revenue),
                    _fmt_money(p.expected_profit),
                    str(len(row["open_tasks"])),
                    str(len(row["overdue"])),
                    _fmt_money(row["debt"]),
                    Paragraph((p.problems_text or "—")[:110], base),
                ])

        widths = [31 * mm, 33 * mm, 20 * mm, 21 * mm, 27 * mm, 30 * mm, 13 * mm, 17 * mm, 24 * mm, 44 * mm]
        table = Table(table_rows, colWidths=widths, repeatRows=1)
        table_style = [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2455DB")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), font_bold),
            ("FONTNAME", (0, 1), (-1, -1), font),
            ("FONTSIZE", (0, 0), (-1, -1), 7.2),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D7DEEA")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FC")]),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]
        table.setStyle(TableStyle(table_style))
        story.append(table)

    if "tasks" in wanted:
        story.append(PageBreak())
        story.append(Paragraph("Просроченные и требующие уточнения задачи", h2))
        task_rows = [["Клиент", "Задача", "Срок", "Приоритет", "Источник", "Требует уточнения"]]
        for row in rows:
            for t in row["tasks"]:
                if t.status != "open":
                    continue
                if not (t.needs_review or (t.due_date and t.due_date < date.today())):
                    continue
                task_rows.append([
                    Paragraph(row["client"].name[:34], base),
                    Paragraph(t.title[:90], base),
                    _fmt_date(t.due_date),
                    t.priority,
                    t.origin,
                    "да" if t.needs_review else "нет",
                ])
        if len(task_rows) == 1:
            task_rows.append(["—", "Нет проблемных задач", "—", "—", "—", "—"])

        t2 = Table(task_rows, colWidths=[40 * mm, 96 * mm, 22 * mm, 22 * mm, 22 * mm, 28 * mm], repeatRows=1)
        t2.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#151B29")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), font_bold),
            ("FONTNAME", (0, 1), (-1, -1), font),
            ("FONTSIZE", (0, 0), (-1, -1), 7.4),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D7DEEA")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FC")]),
        ]))
        story.append(KeepTogether([t2]))

    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "Отчёт сформирован из проверенных структурированных данных ForteOn. "
        "Финансовые суммы подтверждаются ручным вводом; AI не участвует в расчётах.",
        small,
    ))

    doc.build(story)
    return buffer.getvalue()


def save_report(content: bytes, report_id: str, fmt: str) -> str:
    settings.prepare_dirs()
    filename = f"report_{report_id}.{fmt}"
    path = settings.reports_dir / filename
    path.write_bytes(content)
    return str(path)
