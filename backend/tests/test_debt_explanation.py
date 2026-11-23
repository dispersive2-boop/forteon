"""п.17 «30 идей»: долг объясняется словами, а не только числом.

Почему именно так
-----------------
Раньше менеджер видел «долг 300 000 ₽» и не мог ответить клиенту, откуда
сумма. Хуже: если оплата пришла, но не разнесена по счетам, «долг» выглядел
как обычная задолженность, хотя деньги уже у нас.

Проверяем поведение, а не формат ответа:
  * без счетов фраза не пугает нулями;
  * при долге видны все три числа: выставлено, зачтено, остаток;
  * если оплата не разнесена, об этом сказано отдельно;
  * суммы читаются человеком: «300 000 ₽», а не «300000.0».
"""
from __future__ import annotations

from app.api.finance import _explain_debt, _money


def test_money_without_kopecks_for_whole() -> None:
    assert _money(300000) == "300 000 ₽"
    assert _money(1234567) == "1 234 567 ₽"


def test_money_with_kopecks_uses_comma() -> None:
    assert _money(1000.5) == "1 000,50 ₽"
    assert _money(99.99) == "99,99 ₽"


def test_no_invoices_no_scary_zeros() -> None:
    text = _explain_debt(0, 0, 0, 0, 0)
    assert "0 ₽" not in text, "Нули в объяснении только пугают"
    assert "долга нет" in text.lower()


def test_debt_shows_three_numbers() -> None:
    text = _explain_debt(500000, 200000, 200000, 300000, 0)
    assert "500 000 ₽" in text, "выставлено"
    assert "200 000 ₽" in text, "зачтено"
    assert "300 000 ₽" in text, "остаток"
    assert "остаток" in text.lower()


def test_full_payment_says_no_debt() -> None:
    text = _explain_debt(500000, 500000, 500000, 0, 0)
    assert "долга нет" in text.lower()
    assert "500 000 ₽" in text


def test_unallocated_payment_is_called_out() -> None:
    """Деньги пришли, но не разнесены — это не долг, но и не порядок."""
    text = _explain_debt(500000, 600000, 500000, 0, 100000)
    assert "долга нет" in text.lower()
    assert "100 000 ₽" in text
    assert "не разнес" in text.lower() or "разнес" in text.lower()


def test_unallocated_with_debt_mentioned_too() -> None:
    text = _explain_debt(500000, 400000, 200000, 300000, 200000)
    assert "300 000 ₽" in text, "остаток"
    assert "200 000 ₽" in text, "неразнесённая оплата"
    assert "разнес" in text.lower()
